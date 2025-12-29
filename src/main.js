import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { io } from "socket.io-client";

// STATE
const MODES = { MENU: 0, LOBBY: 1, GAME: 2, BUILDER: 3, END: 4 };
let currentMode = MODES.MENU;
let socket, myId, myRole = 'survivor';

// THREE JS
let scene, camera, renderer, clock;
let characterTemplate, mixer;
let players = {}; 
let mapMesh = null;
let taskMarkers = [];
let portalMesh = null;

// PHYSICS & CAM
const raycaster = new THREE.Raycaster();
const downVector = new THREE.Vector3(0, -1, 0);
let camYaw = 0, camPitch = 0.3;
const keys = { w:false, a:false, s:false, d:false, space:false, e:false, shift:false, q:false };
let velocityY = 0;
const GRAVITY = 25.0;
const JUMP_FORCE = 10.0;
let onGround = false;

// BUILDER
let builderConfig = { spawns: [], tasks: [], portal: null };
let builderTool = 'spawn';
let ghostMesh = null;
let builderCamYaw = 0, builderCamPitch = 0;
let mouse = new THREE.Vector2();
let isRightMouseDown = false;
let isMouseDown = false;

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05080a);
    scene.fog = new THREE.Fog(0x05080a, 10, 80);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    document.getElementById('scene-layer').appendChild(renderer.domElement);

    // LIGHTS
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffdfba, 1.2);
    dir.position.set(20, 50, 20);
    dir.castShadow = true;
    dir.shadow.mapSize.width = 2048; dir.shadow.mapSize.height = 2048;
    scene.add(dir);

    socket = io();
    setupSocket();
    setupInputs();

    loadAssets().then(() => {
        clock = new THREE.Clock();
        animate();
    });

    bindUI();
}

async function loadAssets() {
    const loader = new GLTFLoader();
    
    // MAP
    try {
        const mapGltf = await loader.loadAsync('/map.glb');
        mapMesh = mapGltf.scene;
        mapMesh.traverse(c => { if(c.isMesh) { c.receiveShadow=true; c.castShadow=true; } });
        scene.add(mapMesh);
    } catch (e) {
        console.log("No map.glb found, creating fallback grid.");
        // Fallback floor for physics
        const planeGeo = new THREE.PlaneGeometry(200, 200);
        const planeMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
        const plane = new THREE.Mesh(planeGeo, planeMat);
        plane.rotation.x = -Math.PI/2;
        plane.receiveShadow = true;
        scene.add(plane);
        mapMesh = plane; // Assign mapMesh so raycast works!
        
        // Visual Grid
        const grid = new THREE.GridHelper(200, 200);
        scene.add(grid);
    }

    // CHAR
    try {
        const charGltf = await loader.loadAsync('/character.gltf');
        characterTemplate = charGltf.scene;
        characterTemplate.animations = charGltf.animations;
        // Preview
        const preview = SkeletonUtils.clone(characterTemplate);
        preview.position.set(2, 0, 5);
        preview.rotation.y = -0.5;
        scene.add(preview);
    } catch {
        characterTemplate = new THREE.Mesh(new THREE.BoxGeometry(1,2,1), new THREE.MeshStandardMaterial({color:0xff0000}));
    }
}

function bindUI() {
    document.getElementById('btn-play').onclick = () => {
        socket.emit('joinLobby', { name: document.getElementById('inp-nickname').value || "Pirate" });
    };
    document.getElementById('btn-ready').onclick = () => socket.emit('playerReady');
    
    // FIX: Leave button reloads page
    document.getElementById('btn-leave-lobby').onclick = () => window.location.reload();
    document.getElementById('btn-back-menu').onclick = () => window.location.reload();

    // FIX: Map Builder Entry
    document.getElementById('btn-builder').onclick = () => {
        enterBuilderMode();
    };

    document.getElementById('btn-exit-builder').onclick = () => window.location.reload();

    // Builder Tools
    document.querySelectorAll('.tool-btn').forEach(b => {
        b.onclick = (e) => {
            document.querySelectorAll('.tool-btn').forEach(x => x.classList.remove('active'));
            e.currentTarget.classList.add('active');
            builderTool = e.currentTarget.dataset.type;
            updateGhostMesh();
        };
    });
    
    document.getElementById('btn-export-map').onclick = () => {
        console.log(JSON.stringify(builderConfig));
        alert("Config sent to server/console");
        socket.emit('saveMapConfig', builderConfig);
    };
}

function setupSocket() {
    socket.on('lobbyUpdate', (data) => {
        if(currentMode !== MODES.GAME && currentMode !== MODES.BUILDER) {
            currentMode = MODES.LOBBY;
            switchUI('lobby-screen');
        }
        const list = document.getElementById('lobby-player-list');
        list.innerHTML = '';
        Object.values(data.players).forEach(p => {
            const el = document.createElement('div');
            el.className = `lobby-player ${p.isReady ? 'ready' : ''}`;
            el.innerHTML = `<span>${p.name}</span> <span class="status">${p.isReady ? 'READY' : 'WAITING'}</span>`;
            list.appendChild(el);
        });
    });

    socket.on('gameStart', (data) => {
        currentMode = MODES.GAME;
        switchUI('game-ui');
        
        // Spawn Players
        Object.values(data.players).forEach(p => spawnPlayer(p));
        
        // Spawn Tasks
        data.mapConfig.tasks.forEach(t => {
            const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.3), new THREE.MeshBasicMaterial({color:0xffff00}));
            m.position.set(t.x, t.y, t.z);
            scene.add(m);
            taskMarkers.push({mesh: m, id: t.id});
        });
        
        if(data.status === 2) document.getElementById('game-timer').innerText = "IN PROGRESS";
    });

    socket.on('updatePlayer', (p) => {
        if(players[p.id]) {
            players[p.id].targetPos.set(p.x, p.y, p.z);
            players[p.id].targetRot = p.rot;
            updateAnim(players[p.id], p.anim);
        } else {
            spawnPlayer(p);
        }
    });

    socket.on('infectionStarted', (data) => {
        if(data.captainId === socket.id) {
            myRole = 'captain';
        } 
        updateHUD();
    });

    socket.on('playerDied', (data) => {
        if(players[data.id]) players[data.id].mesh.visible = false;
        if(data.id === socket.id) {
            myRole = 'spectator';
            document.exitPointerLock();
            updateHUD();
        }
    });

    socket.on('timerUpdate', (t) => document.getElementById('game-timer').innerText = formatTime(t));
    
    socket.on('gameOver', (data) => {
        currentMode = MODES.END;
        switchUI('end-screen');
        document.getElementById('end-title').innerText = `${data.winner} WIN!`;
        document.getElementById('end-reason').innerText = data.reason;
        document.exitPointerLock();
    });
}

function spawnPlayer(data) {
    if(players[data.id]) return;
    const mesh = SkeletonUtils.clone(characterTemplate);
    mesh.position.set(data.x, data.y, data.z);
    scene.add(mesh);
    
    // Animation Setup
    const pMixer = new THREE.AnimationMixer(mesh);
    const actions = {};
    if(characterTemplate.animations) {
        characterTemplate.animations.forEach(clip => {
            // Fuzzy match names
            if(clip.name.includes('Idle')) actions['Idle'] = pMixer.clipAction(clip);
            if(clip.name.includes('Run') || clip.name.includes('Walk')) actions['Run'] = pMixer.clipAction(clip);
            if(clip.name.includes('Attack')) actions['Attack'] = pMixer.clipAction(clip);
        });
    }
    // Default fallback if no anims
    if(actions['Idle']) actions['Idle'].play();

    players[data.id] = {
        id: data.id, mesh, mixer: pMixer, actions, currentAnim: 'Idle',
        targetPos: new THREE.Vector3(data.x, data.y, data.z), targetRot: data.rot
    };

    if(data.id === socket.id) {
        myId = data.id;
        myRole = data.role;
        updateHUD();
        camera.position.set(data.x, data.y + 5, data.z + 5);
    }
}

// PHYSICS & MOVEMENT
function updatePhysics(delta) {
    if(myRole === 'spectator') return;
    const me = players[myId];
    if(!me) return;

    // 1. INPUT MOVEMENT
    const speed = keys.shift ? 9 : 6;
    const moveDir = new THREE.Vector3();
    const forward = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
    const right = new THREE.Vector3(Math.sin(camYaw - Math.PI/2), 0, Math.cos(camYaw - Math.PI/2));

    // FIX: Inverted controls fixed
    if(keys.w) moveDir.sub(forward); // Forward (ThreeJS Z is negative)
    if(keys.s) moveDir.add(forward); // Backward
    if(keys.a) moveDir.add(right);   // Left
    if(keys.d) moveDir.sub(right);   // Right

    if(moveDir.length() > 0) moveDir.normalize();

    // 2. ATTACK LOGIC (Hitbox check)
    if(isMouseDown && (myRole === 'captain' || myRole === 'skeleton')) {
        updateAnim(me, 'Attack');
        // Find closest player in front
        let closestId = null;
        let minDst = 2.5; // Attack range
        
        Object.values(players).forEach(other => {
            if(other.id !== myId) {
                const dst = me.mesh.position.distanceTo(other.mesh.position);
                if(dst < minDst) {
                    closestId = other.id;
                    minDst = dst;
                }
            }
        });

        if(closestId) {
            socket.emit('attackPlayer', closestId);
            console.log("Attacking:", closestId);
        }
        isMouseDown = false; // Trigger once per click
    }

    // 3. GRAVITY & JUMP
    if(onGround) {
        velocityY = 0;
        if(keys.space) { 
            velocityY = JUMP_FORCE; 
            onGround = false; 
        }
    } else {
        velocityY -= GRAVITY * delta;
    }

    // 4. APPLY VELOCITY
    const intendedMove = moveDir.multiplyScalar(speed * delta);
    me.mesh.position.x += intendedMove.x;
    me.mesh.position.z += intendedMove.z;
    me.mesh.position.y += velocityY * delta;

    // 5. RAYCAST GROUND CHECK
    // Start slightly above feet, cast down
    raycaster.set(new THREE.Vector3(me.mesh.position.x, me.mesh.position.y + 1.0, me.mesh.position.z), downVector);
    // Intersect mapMesh (ensure it exists!)
    const intersects = mapMesh ? raycaster.intersectObject(mapMesh, true) : [];

    if(intersects.length > 0) {
        const dist = intersects[0].distance;
        // dist is distance from origin (y+1) to hit point. 
        // If dist < 1.0, we are inside ground. If dist approx 1.0, we are on ground.
        if(dist <= 1.1 && velocityY <= 0) { 
            me.mesh.position.y = intersects[0].point.y;
            onGround = true;
        } else {
            onGround = false;
        }
    } else {
        // Fallback floor at 0 if no map hit
        if(me.mesh.position.y < 0) { me.mesh.position.y = 0; onGround = true; }
    }

    // 6. ROTATION & ANIM
    if(moveDir.lengthSq() > 0) {
        const targetRot = Math.atan2(-moveDir.x, -moveDir.z); 
        me.mesh.rotation.y = targetRot;
        if(me.currentAnim !== 'Attack') updateAnim(me, 'Run');
    } else {
        if(me.currentAnim !== 'Attack') updateAnim(me, 'Idle');
    }

    // 7. SYNC
    socket.emit('updatePos', {
        x: me.mesh.position.x, y: me.mesh.position.y, z: me.mesh.position.z,
        rot: me.mesh.rotation.y, anim: me.currentAnim
    });

    // 8. CAMERA FOLLOW
    const camDist = 6;
    const camHeight = 4;
    const offset = new THREE.Vector3(0, camHeight, camDist);
    offset.applyAxisAngle(new THREE.Vector3(0,1,0), camYaw);
    
    const targetCamPos = me.mesh.position.clone().add(offset);
    camera.position.lerp(targetCamPos, 0.2);
    camera.lookAt(me.mesh.position.x, me.mesh.position.y + 1.5, me.mesh.position.z);
}

function updateBuilder(delta) {
    const speed = 20 * delta;
    const forward = new THREE.Vector3(Math.sin(builderCamYaw), 0, Math.cos(builderCamYaw));
    const right = new THREE.Vector3(Math.sin(builderCamYaw - Math.PI/2), 0, Math.cos(builderCamYaw - Math.PI/2));

    if(keys.w) camera.position.addScaledVector(forward, -speed);
    if(keys.s) camera.position.addScaledVector(forward, speed);
    if(keys.a) camera.position.addScaledVector(right, speed);
    if(keys.d) camera.position.addScaledVector(right, -speed);
    if(keys.q) camera.position.y += speed;
    if(keys.e) camera.position.y -= speed;

    camera.rotation.set(builderCamPitch, builderCamYaw, 0);

    // Ghost Mesh
    raycaster.setFromCamera(mouse, camera);
    const intersects = mapMesh ? raycaster.intersectObject(mapMesh, true) : [];
    
    if(intersects.length > 0) {
        const p = intersects[0].point;
        if(ghostMesh) ghostMesh.position.copy(p);
        
        if(isMouseDown && ghostMesh) {
            isMouseDown = false; 
            const marker = ghostMesh.clone();
            marker.material = marker.material.clone();
            marker.material.opacity = 1; marker.material.transparent = false;
            scene.add(marker);

            const data = {x:p.x, y:p.y, z:p.z};
            if(builderTool === 'spawn') builderConfig.spawns.push(data);
            else if(builderTool === 'task') builderConfig.tasks.push({id:'t'+Date.now(), ...data});
            else if(builderTool === 'portal') builderConfig.portal = data;
        }
        document.getElementById('builder-coords').innerText = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}`;
    }
}

function updateGhostMesh() {
    if(ghostMesh) scene.remove(ghostMesh);
    let geo, col;
    if(builderTool === 'spawn') { geo = new THREE.CylinderGeometry(0.5,0.5,2); col=0x00ff00; }
    else if(builderTool === 'task') { geo = new THREE.OctahedronGeometry(0.5); col=0xffff00; }
    else if(builderTool === 'portal') { geo = new THREE.TorusGeometry(1,0.2); col=0x00ffff; }
    else { geo = new THREE.BoxGeometry(1,1,1); col=0xffffff; }
    ghostMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({color:col, transparent:true, opacity:0.5}));
    scene.add(ghostMesh);
}

function enterBuilderMode() {
    currentMode = MODES.BUILDER;
    switchUI('builder-ui');
    if(scene.getObjectByName("previewChar")) scene.remove(scene.getObjectByName("previewChar"));
    
    camera.position.set(0, 20, 20);
    camera.lookAt(0,0,0);
    builderCamPitch = -0.5;
    builderCamYaw = 0;
    updateGhostMesh();
    document.exitPointerLock();
}

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    Object.values(players).forEach(p => { if(p.mixer) p.mixer.update(delta); });

    if(currentMode === MODES.GAME) {
        if(myRole !== 'spectator') updatePhysics(delta);
        
        // Network interpolation
        Object.values(players).forEach(p => {
            if(p.id !== myId) {
                p.mesh.position.lerp(p.targetPos, 10 * delta);
                p.mesh.rotation.y = p.targetRot; 
                updateAnim(p, p.serverAnim || 'Idle');
            }
        });
    }
    else if(currentMode === MODES.BUILDER) {
        updateBuilder(delta);
    }
    
    renderer.render(scene, camera);
}

function updateAnim(p, name) {
    if(p.currentAnim === name) return;
    if(p.actions[p.currentAnim]) p.actions[p.currentAnim].fadeOut(0.2);
    if(p.actions[name]) p.actions[name].reset().fadeIn(0.2).play();
    p.currentAnim = name;
}

function setupInputs() {
    // FIX: Added e.key check to prevent crashes
    window.addEventListener('keydown', e => { if(e.key) keys[e.key.toLowerCase()] = true; });
    window.addEventListener('keyup', e => { if(e.key) keys[e.key.toLowerCase()] = false; });
    
    window.addEventListener('mousemove', e => {
        mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

        if(currentMode === MODES.GAME && document.pointerLockElement) {
            camYaw -= e.movementX * 0.002;
            camPitch -= e.movementY * 0.002;
            camPitch = Math.max(-0.5, Math.min(1.0, camPitch));
        }
        else if(currentMode === MODES.BUILDER && isRightMouseDown) {
            builderCamYaw -= e.movementX * 0.004;
            builderCamPitch -= e.movementY * 0.004;
        }
    });

    window.addEventListener('mousedown', e => {
        if(e.button === 0) isMouseDown = true;
        if(e.button === 2) isRightMouseDown = true;
    });
    window.addEventListener('mouseup', () => { isMouseDown = false; isRightMouseDown = false; });
    window.addEventListener('contextmenu', e => e.preventDefault());

    document.addEventListener('click', () => {
        if(currentMode === MODES.GAME && myRole !== 'spectator') document.body.requestPointerLock();
    });
}

function updateHUD() {
    const el = document.getElementById('role-display');
    el.innerText = myRole.toUpperCase();
    el.style.color = (myRole === 'captain' || myRole === 'skeleton') ? '#ff4444' : '#c8aa6e';
}

function switchUI(id) {
    ['main-menu', 'lobby-screen', 'game-ui', 'end-screen', 'builder-ui'].forEach(s => document.getElementById(s).style.display = 'none');
    document.getElementById(id).style.display = 'flex';
    if(id === 'game-ui') document.getElementById(id).style.display = 'block'; 
}

function formatTime(s) {
    const m = Math.floor(s/60);
    const sec = s%60;
    return `${m}:${sec<10?'0':''}${sec}`;
}

function showNotification(msg, color) { console.log(msg); }

init();