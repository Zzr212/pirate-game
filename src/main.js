import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { io } from "socket.io-client";

// --- CONFIG & STATE ---
const MODES = { MENU: 0, LOBBY: 1, GAME: 2, BUILDER: 3 };
let currentMode = MODES.MENU;
let socket;
let myId = null;
let myRole = 'survivor';

// Scene Globals
let scene, camera, renderer, clock;
let characterTemplate, character; // Template for cloning, 'character' is preview
let mixer; // Preview mixer
let players = {}; // id -> { mesh, mixer, actions{}, ... }
let mapMesh = null;
let taskMarkers = [];
let portalMesh = null;

// Inputs
const keys = { w: false, a: false, s: false, d: false, q: false, e: false, shift: false, space: false };
const mouse = new THREE.Vector2();
let isMouseDown = false;
let isRightMouseDown = false;

// Builder State
let builderConfig = { spawns: [], tasks: [], portal: null };
let builderTool = 'spawn';
let ghostMesh = null;
let builderCamYaw = 0;
let builderCamPitch = 0;

// Game State
let camYaw = 0, camPitch = 0.3;

// --- INIT ---
function init() {
    // 1. Setup Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05080a); // Dark blue/black
    scene.fog = new THREE.Fog(0x05080a, 10, 60);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
    camera.position.set(0, 5, 10);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById('scene-layer').appendChild(renderer.domElement);

    // 2. Lighting (Fixed Darkness)
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffdfba, 1.2); // Warm sun
    dirLight.position.set(20, 50, 20);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    scene.add(dirLight);

    // 3. Connect Socket
    socket = io();
    setupSocket();

    // 4. Inputs
    setupInputs();

    // 5. Assets
    loadAssets().then(() => {
        clock = new THREE.Clock();
        setupMenuPreview();
        animate();
    });

    // 6. UI Bindings
    bindUI();
}

async function loadAssets() {
    const loader = new GLTFLoader();
    
    // Load Map
    try {
        const mapGltf = await loader.loadAsync('/map.glb');
        mapMesh = mapGltf.scene;
        mapMesh.traverse(c => { if(c.isMesh) { c.receiveShadow = true; c.castShadow = true; } });
        scene.add(mapMesh);
    } catch (e) {
        console.warn("Map not found, creating grid.");
        const grid = new THREE.GridHelper(100, 100, 0x444444, 0x222222);
        scene.add(grid);
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(100,100), new THREE.MeshStandardMaterial({color:0x111111}));
        plane.rotation.x = -Math.PI/2;
        plane.receiveShadow = true;
        scene.add(plane);
        mapMesh = plane; // For raycasting
    }

    // Load Character
    try {
        const charGltf = await loader.loadAsync('/character.gltf');
        characterTemplate = charGltf.scene;
        characterTemplate.traverse(c => { if(c.isMesh) c.castShadow = true; });
        characterTemplate.animations = charGltf.animations; // Store anims
    } catch(e) {
        console.warn("Character not found, using box.");
        characterTemplate = new THREE.Mesh(new THREE.BoxGeometry(1,2,1), new THREE.MeshStandardMaterial({color:0xff0000}));
        characterTemplate.animations = [];
    }
}

function bindUI() {
    document.getElementById('btn-play').onclick = () => {
        const name = document.getElementById('inp-nickname').value || "Pirate";
        socket.emit('joinLobby', { name: name });
    };
    document.getElementById('btn-builder').onclick = enterBuilderMode;
    document.getElementById('btn-ready').onclick = () => socket.emit('playerReady');
    document.getElementById('btn-exit-builder').onclick = () => window.location.reload();
    
    // Builder Tools
    document.querySelectorAll('.tool-btn').forEach(b => {
        b.onclick = (e) => {
            document.querySelectorAll('.tool-btn').forEach(x => x.classList.remove('active'));
            const target = e.currentTarget; // use currentTarget for button with icon
            target.classList.add('active');
            builderTool = target.dataset.type;
            updateGhostMesh();
        };
    });
    
    document.getElementById('btn-export-map').onclick = () => {
        console.log("MAP CONFIG:", JSON.stringify(builderConfig));
        alert("Config printed to Console (F12)");
        socket.emit('saveMapConfig', builderConfig);
    };
}

// --- ANIMATION SYSTEM ---
function createPlayerMesh(id, pos) {
    const mesh = SkeletonUtils.clone(characterTemplate);
    mesh.position.set(pos.x, pos.y, pos.z);
    scene.add(mesh);

    // Setup Mixer
    const pMixer = new THREE.AnimationMixer(mesh);
    const actions = {};
    
    // Map animations names to actions
    // Assumes names like "Idle", "Run", "Attack" in GLTF
    if(characterTemplate.animations) {
        characterTemplate.animations.forEach(clip => {
            const action = pMixer.clipAction(clip);
            // Handle names loosely
            if(clip.name.includes('Idle')) actions['Idle'] = action;
            if(clip.name.includes('Run') || clip.name.includes('Walk')) actions['Run'] = action;
            if(clip.name.includes('Attack')) actions['Attack'] = action;
            if(clip.name.includes('Death')) { actions['Death'] = action; action.clampWhenFinished = true; action.setLoop(THREE.LoopOnce); }
        });
    }

    // Default Play
    if(actions['Idle']) actions['Idle'].play();

    return { mesh, mixer: pMixer, actions, currentAnim: 'Idle' };
}

function updateAnim(p, animName) {
    if(!p.actions[animName]) return;
    if(p.currentAnim === animName) return;
    
    const prev = p.actions[p.currentAnim];
    const next = p.actions[animName];
    
    if(prev) prev.fadeOut(0.2);
    next.reset().fadeIn(0.2).play();
    p.currentAnim = animName;
}

// --- GAME LOGIC ---

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    if(currentMode === MODES.MENU) {
        // Rotate preview char
        if(character) character.rotation.y += delta * 0.5;
        if(mixer) mixer.update(delta);
    }
    else if(currentMode === MODES.GAME) {
        updateGame(delta);
    }
    else if(currentMode === MODES.BUILDER) {
        updateBuilder(delta);
    }

    renderer.render(scene, camera);
}

function updateGame(delta) {
    if(!myId || !players[myId]) return;
    const me = players[myId];
    
    // 1. Movement Logic (WASD)
    if(myRole !== 'spectator') {
        const speed = keys.shift ? 7 : 4;
        const dir = new THREE.Vector3();
        
        // Camera Forward (flat)
        const forward = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
        const right = new THREE.Vector3(Math.sin(camYaw - Math.PI/2), 0, Math.cos(camYaw - Math.PI/2));

        if(keys.w) dir.sub(forward);
        if(keys.s) dir.add(forward);
        if(keys.a) dir.add(right);
        if(keys.d) dir.sub(right);

        let anim = 'Idle';

        if(dir.length() > 0) {
            dir.normalize();
            me.mesh.position.addScaledVector(dir, speed * delta);
            // Rotate character to face movement
            const targetRot = Math.atan2(-dir.x, -dir.z);
            // Smooth rotation
            let rotDiff = targetRot - me.mesh.rotation.y;
            while(rotDiff > Math.PI) rotDiff -= Math.PI*2;
            while(rotDiff < -Math.PI) rotDiff += Math.PI*2;
            me.mesh.rotation.y += rotDiff * 10 * delta;
            
            anim = 'Run';
        }

        // Attack Logic
        if(isMouseDown && (myRole === 'captain' || myRole === 'skeleton')) {
             anim = 'Attack';
             socket.emit('attackPlayer', 'check_collision_server'); 
             // Logic simplified: server validates hits, but we trigger anim
             isMouseDown = false; 
             // Reset to idle after attack (hacky without state machine)
             setTimeout(() => isMouseDown = false, 500); 
        }

        // Apply Animation
        updateAnim(me, anim);
        
        // Sync to Server
        socket.emit('updatePos', {
            x: me.mesh.position.x, y: me.mesh.position.y, z: me.mesh.position.z,
            rot: me.mesh.rotation.y, anim: anim
        });

        // Camera Follow (TPS)
        const camDist = 6;
        const camHeight = 4;
        const camPos = new THREE.Vector3(0, camHeight, camDist);
        camPos.applyAxisAngle(new THREE.Vector3(0,1,0), camYaw);
        camPos.add(me.mesh.position);
        
        camera.position.lerp(camPos, 0.2); // Smooth follow
        camera.lookAt(me.mesh.position.x, me.mesh.position.y + 1.5, me.mesh.position.z);
        
        // Raycast Interaction
        checkInteraction();
    }
    
    // Update Others
    Object.values(players).forEach(p => {
        if(p.mixer) p.mixer.update(delta);
        if(p.id !== myId) {
            p.mesh.position.lerp(p.targetPos, 10 * delta);
            // Simple rotation sync
            let rotDiff = p.targetRot - p.mesh.rotation.y;
            while(rotDiff > Math.PI) rotDiff -= Math.PI*2;
            while(rotDiff < -Math.PI) rotDiff += Math.PI*2;
            p.mesh.rotation.y += rotDiff * 10 * delta;
            
            updateAnim(p, p.serverAnim);
        }
    });
}

function updateBuilder(delta) {
    // 1. Camera Movement (Free Fly)
    const speed = 15 * delta;
    const dir = new THREE.Vector3();
    const forward = new THREE.Vector3(Math.sin(builderCamYaw), 0, Math.cos(builderCamYaw));
    const right = new THREE.Vector3(Math.sin(builderCamYaw - Math.PI/2), 0, Math.cos(builderCamYaw - Math.PI/2));

    if(keys.w) camera.position.addScaledVector(forward, -speed);
    if(keys.s) camera.position.addScaledVector(forward, speed);
    if(keys.a) camera.position.addScaledVector(right, speed);
    if(keys.d) camera.position.addScaledVector(right, -speed);
    if(keys.q) camera.position.y += speed;
    if(keys.e) camera.position.y -= speed;

    camera.rotation.set(builderCamPitch, builderCamYaw, 0);

    // 2. Ghost Mesh Positioning
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(mapMesh, true);
    
    if(intersects.length > 0) {
        const p = intersects[0].point;
        if(ghostMesh) {
            ghostMesh.position.copy(p);
            // Snap to grid option?
            // ghostMesh.position.x = Math.round(p.x);
        }
        
        // Click to place
        if(isMouseDown && ghostMesh) {
            isMouseDown = false; // Debounce
            placeObject(p);
        }
        
        document.getElementById('builder-coords').innerText = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
    }
}

function placeObject(pos) {
    const p = {x: pos.x, y: pos.y, z: pos.z};
    
    // Visual Marker
    const marker = ghostMesh.clone();
    marker.material = marker.material.clone();
    marker.material.opacity = 1;
    marker.material.transparent = false;
    scene.add(marker);
    
    // Save to Config
    if(builderTool === 'spawn') builderConfig.spawns.push(p);
    else if(builderTool === 'task') builderConfig.tasks.push({id: 't_'+Date.now(), type:'wires', ...p});
    else if(builderTool === 'portal') builderConfig.portal = p;
    else if(builderTool === 'light') { /* Add light logic later */ }
}

function updateGhostMesh() {
    if(ghostMesh) scene.remove(ghostMesh);
    
    let geo, color;
    if(builderTool === 'spawn') { geo = new THREE.CylinderGeometry(0.5, 0.5, 2); color = 0x00ff00; }
    else if(builderTool === 'task') { geo = new THREE.OctahedronGeometry(0.5); color = 0xffff00; }
    else if(builderTool === 'portal') { geo = new THREE.TorusGeometry(1, 0.2); color = 0x00ffff; }
    else { geo = new THREE.BoxGeometry(1,1,1); color = 0xffffff; }
    
    ghostMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({color: color, transparent: true, opacity: 0.5}));
    scene.add(ghostMesh);
}

// --- SETUP FUNCTIONS ---

function setupMenuPreview() {
    if(!characterTemplate) return;
    character = SkeletonUtils.clone(characterTemplate);
    scene.add(character);
    
    // Set position relative to camera for menu
    character.position.set(2, 0, 5); 
    character.rotation.y = -0.5;
    
    mixer = new THREE.AnimationMixer(character);
    // Play idle
    if(characterTemplate.animations) {
        const idle = characterTemplate.animations.find(c => c.name.includes('Idle'));
        if(idle) mixer.clipAction(idle).play();
    }
}

function enterBuilderMode() {
    currentMode = MODES.BUILDER;
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('builder-ui').style.display = 'block';
    
    // Reset Cam for builder
    camera.position.set(0, 20, 20);
    builderCamPitch = -0.5;
    updateGhostMesh();
}

function setupSocket() {
    socket.on('lobbyUpdate', (data) => {
        if(currentMode === MODES.MENU) {
            currentMode = MODES.LOBBY;
            document.getElementById('main-menu').style.display = 'none';
            document.getElementById('lobby-screen').style.display = 'flex';
            if(character) scene.remove(character); // Remove preview
        }
        
        // Render Lobby List
        const list = document.getElementById('lobby-player-list');
        list.innerHTML = '';
        Object.values(data.players).forEach(p => {
            list.innerHTML += `<div style="padding:10px; border:1px solid #444; margin:5px; color:${p.isReady?'lime':'white'}">${p.name} ${p.isReady?'(READY)':''}</div>`;
        });
    });

    socket.on('gameStart', (data) => {
        currentMode = MODES.GAME;
        document.getElementById('lobby-screen').style.display = 'none';
        document.getElementById('game-ui').style.display = 'block';
        
        // Init Players
        Object.values(data.players).forEach(p => {
            const isMe = p.id === socket.id;
            const obj = createPlayerMesh(p.id, p);
            obj.targetPos = new THREE.Vector3(p.x, p.y, p.z);
            obj.targetRot = p.rot;
            obj.serverAnim = 'Idle';
            players[p.id] = obj;
            
            if(isMe) {
                myId = p.id;
                myRole = p.role;
                document.getElementById('role-display').innerText = myRole.toUpperCase();
                // Pointer Lock for Game
                document.body.requestPointerLock();
            }
        });

        // Spawn Tasks
        data.mapConfig.tasks.forEach(t => {
            const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.3), new THREE.MeshBasicMaterial({color:0xffff00}));
            m.position.set(t.x, t.y, t.z);
            scene.add(m);
            taskMarkers.push({mesh: m, id: t.id});
        });
    });
    
    socket.on('updatePlayer', (p) => {
        if(players[p.id]) {
            players[p.id].targetPos.set(p.x, p.y, p.z);
            players[p.id].targetRot = p.rot;
            players[p.id].serverAnim = p.anim;
        }
    });
}

function setupInputs() {
    window.addEventListener('keydown', (e) => { keys[e.key.toLowerCase()] = true; if(e.key === 'Shift') keys.shift = true; });
    window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; if(e.key === 'Shift') keys.shift = false; });
    
    window.addEventListener('mousedown', (e) => {
        if(e.button === 0) isMouseDown = true; // Left
        if(e.button === 2) isRightMouseDown = true; // Right
    });
    window.addEventListener('mouseup', () => { isMouseDown = false; isRightMouseDown = false; });
    window.addEventListener('contextmenu', e => e.preventDefault()); // Block context menu

    window.addEventListener('mousemove', (e) => {
        // Mouse Coordinates for Builder (-1 to 1)
        mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

        if(currentMode === MODES.GAME && document.pointerLockElement) {
            camYaw -= e.movementX * 0.002;
            camPitch -= e.movementY * 0.002;
            camPitch = Math.max(-1.0, Math.min(1.0, camPitch));
        }
        else if(currentMode === MODES.BUILDER && isRightMouseDown) {
            // Builder Cam Rotation
            builderCamYaw -= e.movementX * 0.004;
            builderCamPitch -= e.movementY * 0.004;
        }
    });
}

function checkInteraction() {
    if(!myId) return;
    const mePos = players[myId].mesh.position;
    let near = false;
    
    taskMarkers.forEach(t => {
        if(mePos.distanceTo(t.mesh.position) < 2) {
            near = true;
            document.getElementById('interaction-prompt').style.display = 'flex';
            document.getElementById('interaction-text').innerText = "DO TASK";
            if(keys.e) { keys.e = false; openTaskUI(t.id); }
        }
    });
    
    if(!near) document.getElementById('interaction-prompt').style.display = 'none';
}

function openTaskUI(id) {
    document.exitPointerLock();
    document.getElementById('task-modal').style.display = 'flex';
    // ... Task logic ...
    document.getElementById('btn-close-task').onclick = () => {
         document.getElementById('task-modal').style.display = 'none';
         document.body.requestPointerLock();
         socket.emit('completeTask', id); // Simplified
    };
}

init();