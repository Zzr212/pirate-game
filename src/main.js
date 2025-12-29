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
let characterTemplate, enemyTemplate;
let players = {}; 
let mapMesh = null;
let taskMarkers = [];

// PHYSICS & CONTROLS
const raycaster = new THREE.Raycaster();
const downVector = new THREE.Vector3(0, -1, 0);
let camYaw = 0, camPitch = 0.3;
const keys = { w:false, a:false, s:false, d:false, space:false, shift:false };
let velocityY = 0;
const GRAVITY = 30.0;
const JUMP_FORCE = 12.0;
let onGround = false;
let isMouseDown = false;
let isRightMouseDown = false;

// BUILDER
let builderConfig = { spawns: [], tasks: [], portal: null };
let builderTool = 'spawn';
let ghostMesh = null;
let builderCamYaw = 0, builderCamPitch = 0;
let mouse = new THREE.Vector2();

// SPECTATOR
let spectatorIndex = 0;

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05080a);
    scene.fog = new THREE.Fog(0x05080a, 10, 80);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
    
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById('scene-layer').appendChild(renderer.domElement);

    // LIGHTING
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffdfba, 1.5);
    dir.position.set(50, 100, 50);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -50; dir.shadow.camera.right = 50;
    dir.shadow.camera.top = 50; dir.shadow.camera.bottom = -50;
    scene.add(dir);

    socket = io();
    setupSocket();
    setupInputs();
    bindUI();

    loadAssets().then(() => {
        clock = new THREE.Clock();
        animate();
    });
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
        console.log("Using fallback grid.");
        createFallbackMap();
    }

    // CHARACTERS
    try {
        const charGltf = await loader.loadAsync('/character.gltf');
        characterTemplate = charGltf.scene;
        // Fix rotation of raw model if needed
        characterTemplate.rotation.set(0,0,0); 
        characterTemplate.animations = charGltf.animations;
        
        // Preview
        const preview = SkeletonUtils.clone(characterTemplate);
        preview.position.set(2, 0, 5);
        preview.rotation.y = 0; 
        preview.name = "previewChar";
        scene.add(preview);
    } catch {
        characterTemplate = new THREE.Mesh(new THREE.BoxGeometry(1,2,1), new THREE.MeshStandardMaterial({color:0xff0000}));
    }

    try {
        const enemyGltf = await loader.loadAsync('/assets/enemy.gltf');
        enemyTemplate = enemyGltf.scene;
        enemyTemplate.animations = enemyGltf.animations;
    } catch {
        enemyTemplate = new THREE.Mesh(new THREE.BoxGeometry(1,2,1), new THREE.MeshStandardMaterial({color:0x00ff00}));
    }
}

function createFallbackMap() {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(200,200), new THREE.MeshStandardMaterial({color:0x222222}));
    plane.rotation.x = -Math.PI/2;
    plane.receiveShadow = true;
    scene.add(plane);
    mapMesh = plane;
    scene.add(new THREE.GridHelper(200, 200));
}

function bindUI() {
    document.getElementById('btn-play').onclick = () => {
        currentMode = MODES.LOBBY;
        switchUI('lobby-screen');
        if(scene.getObjectByName("previewChar")) scene.remove(scene.getObjectByName("previewChar"));
        const name = document.getElementById('inp-nickname').value || "Pirate";
        socket.emit('joinLobby', { name: name });
    };
    document.getElementById('btn-ready').onclick = () => socket.emit('playerReady');
    document.getElementById('btn-leave-lobby').onclick = () => window.location.reload();
    document.getElementById('btn-back-menu').onclick = () => window.location.reload();
    document.getElementById('btn-builder').onclick = () => {
        if (!mapMesh) { alert("Map missing!"); return; }
        enterBuilderMode();
    };
    document.getElementById('btn-exit-builder').onclick = () => window.location.reload();
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
        socket.emit('saveMapConfig', builderConfig);
    };
}

function setupSocket() {
    socket.on('lobbyUpdate', (data) => {
        if(currentMode !== MODES.LOBBY) return;
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
        
        // Clean scene
        Object.values(players).forEach(p => scene.remove(p.group));
        players = {};
        taskMarkers.forEach(t => scene.remove(t.mesh));
        taskMarkers = [];

        Object.values(data.players).forEach(p => spawnPlayer(p));
        data.mapConfig.tasks.forEach(t => {
            const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.3), new THREE.MeshBasicMaterial({color:0xffff00}));
            m.position.set(t.x, t.y, t.z);
            scene.add(m);
            taskMarkers.push({mesh: m, id: t.id});
        });

        if(data.isSpectator) {
             myRole = 'spectator';
             showNotification("SPECTATING", "yellow");
             document.exitPointerLock();
        }
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
        if(data.captainId === socket.id) { myRole = 'captain'; showNotification("YOU ARE THE CAPTAIN!", "red"); }
        else showNotification("CAPTAIN CHOSEN!", "yellow");
        updateHUD();
    });

    socket.on('playerInfected', (data) => {
        if(players[data.id]) swapModelToEnemy(players[data.id]);
        if(data.id === socket.id) {
            myRole = 'skeleton';
            showNotification("YOU ARE INFECTED!", "red");
            updateHUD();
        }
    });

    socket.on('playerDied', (data) => {
        if(players[data.id]) players[data.id].group.visible = false;
        if(data.id === socket.id) {
            myRole = 'spectator';
            document.exitPointerLock();
            showNotification("YOU DIED.", "red");
            updateHUD();
        }
    });

    socket.on('playerLeft', (id) => {
        if(players[id]) {
            scene.remove(players[id].group);
            delete players[id];
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

// --- PLAYER SPAWNING WITH GROUP WRAPPER ---
function spawnPlayer(data) {
    if(players[data.id]) return;

    // 1. Create Container Group (Handles Physics/Pos)
    const group = new THREE.Group();
    group.position.set(data.x, data.y, data.z);
    scene.add(group);

    // 2. Determine Template
    let template = (data.role === 'skeleton') ? enemyTemplate : characterTemplate;
    
    // 3. Clone Mesh and Fix Rotation
    const mesh = SkeletonUtils.clone(template);
    // FIX: Rotiramo mesh unutar grupe da gleda ispravno (često modeli gledaju +Z a Three treba -Z)
    // Ako model lebdi horizontalno, ovdje podesi mesh.rotation.x
    // Ako model hoda unazad, podesi mesh.rotation.y = Math.PI
    mesh.rotation.set(0, Math.PI, 0); 
    group.add(mesh);

    // 4. Setup Animation
    const pMixer = new THREE.AnimationMixer(mesh);
    const actions = {};
    if(template.animations) {
        template.animations.forEach(clip => {
            const name = clip.name.toLowerCase();
            if(name.includes('idle')) actions['Idle'] = pMixer.clipAction(clip);
            else if(name.includes('run') || name.includes('walk')) actions['Run'] = pMixer.clipAction(clip);
            else if(name.includes('attack')) actions['Attack'] = pMixer.clipAction(clip);
            else if(name.includes('death')) actions['Death'] = pMixer.clipAction(clip);
        });
    }
    if(actions['Idle']) actions['Idle'].play();

    players[data.id] = {
        id: data.id, group: group, mesh: mesh, mixer: pMixer, actions, currentAnim: 'Idle',
        targetPos: new THREE.Vector3(data.x, data.y, data.z), targetRot: data.rot,
        role: data.role
    };

    if(data.id === socket.id) {
        myId = data.id;
        myRole = data.role;
        updateHUD();
        camera.position.set(data.x, data.y + 5, data.z + 5);
    }
}

function swapModelToEnemy(pObj) {
    pObj.group.remove(pObj.mesh);
    const mesh = SkeletonUtils.clone(enemyTemplate);
    mesh.rotation.set(0, Math.PI, 0); // Apply same fix
    pObj.group.add(mesh);
    
    pObj.mesh = mesh;
    pObj.mixer = new THREE.AnimationMixer(mesh);
    pObj.actions = {};
    
    if(enemyTemplate.animations) {
        enemyTemplate.animations.forEach(clip => {
            const name = clip.name.toLowerCase();
            if(name.includes('idle')) pObj.actions['Idle'] = pObj.mixer.clipAction(clip);
            else if(name.includes('run') || name.includes('walk')) pObj.actions['Run'] = pObj.mixer.clipAction(clip);
            else if(name.includes('attack')) pObj.actions['Attack'] = pObj.mixer.clipAction(clip);
        });
    }
    if(pObj.actions['Idle']) pObj.actions['Idle'].play();
    pObj.currentAnim = 'Idle';
}

// PHYSICS
function updatePhysics(delta) {
    if(myRole === 'spectator') return;
    const me = players[myId];
    if(!me) return;

    const speed = keys.shift ? 9 : 6;
    const moveDir = new THREE.Vector3();
    const forward = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
    const right = new THREE.Vector3(Math.sin(camYaw - Math.PI/2), 0, Math.cos(camYaw - Math.PI/2));

    // W ide naprijed (oduzimamo forward vektor)
    if(keys.w) moveDir.sub(forward); 
    if(keys.s) moveDir.add(forward); 
    if(keys.a) moveDir.add(right);
    if(keys.d) moveDir.sub(right);

    if(moveDir.length() > 0) moveDir.normalize();

    // ATTACK
    if(isMouseDown && (myRole === 'captain' || myRole === 'skeleton')) {
        isMouseDown = false; 
        updateAnim(me, 'Attack');
        Object.values(players).forEach(other => {
            if(other.id !== myId && other.group.visible) {
                 const dist = me.group.position.distanceTo(other.group.position);
                 if(dist < 2.5) socket.emit('attackPlayer', other.id);
            }
        });
    }

    // GRAVITY
    if(onGround) {
        velocityY = 0;
        if(keys.space) { velocityY = JUMP_FORCE; onGround = false; }
    } else {
        velocityY -= GRAVITY * delta;
    }

    const intendedMove = moveDir.multiplyScalar(speed * delta);
    me.group.position.x += intendedMove.x;
    me.group.position.z += intendedMove.z;
    me.group.position.y += velocityY * delta;

    // GROUND CHECK
    // Cast ray from CENTER (y+0.5) downwards. 
    // If y is at feet level, casting from y+0.5 means length 0.5 is ground.
    raycaster.set(new THREE.Vector3(me.group.position.x, me.group.position.y + 0.5, me.group.position.z), downVector);
    const intersects = mapMesh ? raycaster.intersectObject(mapMesh, true) : [];

    if(intersects.length > 0) {
        const hitY = intersects[0].point.y;
        const dist = intersects[0].distance;
        
        // If distance < 0.5 (meaning feet are below ground) OR just slightly above
        if(dist <= 0.6 && velocityY <= 0) {
            me.group.position.y = hitY;
            onGround = true;
        } else {
            onGround = false;
        }
    } else {
        if(me.group.position.y < 0) { me.group.position.y = 0; onGround = true; }
    }

    // ROTATION & ANIMATION
    if(moveDir.lengthSq() > 0) {
        // FIX: Rotation offset logic
        // atan2(x, z) gives rotation from North. 
        // We add Math.PI because we rotated the mesh inside the group by PI.
        const targetRot = Math.atan2(moveDir.x, moveDir.z); 
        me.group.rotation.y = targetRot;
        
        if(me.currentAnim !== 'Attack') updateAnim(me, 'Run');
    } else {
        if(me.currentAnim !== 'Attack') updateAnim(me, 'Idle');
    }

    // SYNC
    socket.emit('updatePos', {
        x: me.group.position.x, y: me.group.position.y, z: me.group.position.z,
        rot: me.group.rotation.y, anim: me.currentAnim
    });

    // CAMERA
    const camDist = 6;
    const camHeight = 4;
    const offset = new THREE.Vector3(0, camHeight, camDist);
    offset.applyAxisAngle(new THREE.Vector3(0,1,0), camYaw);
    
    camera.position.lerp(me.group.position.clone().add(offset), 0.2);
    camera.lookAt(me.group.position.x, me.group.position.y + 1.5, me.group.position.z);
}

function updateSpectator() {
    const active = Object.values(players).filter(p => p.role !== 'spectator' && p.group.visible);
    if(active.length === 0) return;
    if(spectatorIndex >= active.length) spectatorIndex = 0;
    const target = active[spectatorIndex];
    if(target) {
        camera.position.lerp(new THREE.Vector3(target.group.position.x, target.group.position.y + 8, target.group.position.z + 8), 0.1);
        camera.lookAt(target.group.position);
    }
}

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    Object.values(players).forEach(p => { if(p.mixer) p.mixer.update(delta); });

    if(currentMode === MODES.GAME) {
        if(myRole !== 'spectator') updatePhysics(delta);
        else updateSpectator();
        
        Object.values(players).forEach(p => {
            if(p.id !== myId) {
                p.group.position.lerp(p.targetPos, 15 * delta); 
                // Rotation sync
                let rDiff = p.targetRot - p.group.rotation.y;
                while(rDiff > Math.PI) rDiff -= Math.PI*2;
                while(rDiff < -Math.PI) rDiff += Math.PI*2;
                p.group.rotation.y += rDiff * 10 * delta;
                
                updateAnim(p, p.serverAnim || 'Idle');
            }
        });
    } else if(currentMode === MODES.BUILDER) {
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
    window.addEventListener('keydown', e => { 
        if(e.key) keys[e.key.toLowerCase()] = true; 
        if(myRole === 'spectator') {
            if(e.key.toLowerCase() === 'a') spectatorIndex--;
            if(e.key.toLowerCase() === 'd') spectatorIndex++;
        }
    });
    window.addEventListener('keyup', e => { if(e.key) keys[e.key.toLowerCase()] = false; });
    
    document.addEventListener('mousemove', e => {
        mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

        if(currentMode === MODES.GAME && document.pointerLockElement) {
            camYaw -= e.movementX * 0.002;
            camPitch -= e.movementY * 0.002;
            camPitch = Math.max(-0.5, Math.min(1.0, camPitch));
        } else if(currentMode === MODES.BUILDER && isRightMouseDown) {
             builderCamYaw -= e.movementX * 0.004;
             builderCamPitch -= e.movementY * 0.004;
        }
    });

    window.addEventListener('mousedown', e => {
        if(e.button === 0) isMouseDown = true;
        if(e.button === 2) isRightMouseDown = true;
    });
    window.addEventListener('mouseup', () => { isMouseDown = false; isRightMouseDown = false; });
    document.addEventListener('click', () => {
        if(currentMode === MODES.GAME && myRole !== 'spectator') document.body.requestPointerLock();
    });
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
    }
}

function updateGhostMesh() {
    if(ghostMesh) scene.remove(ghostMesh);
    let col = (builderTool==='spawn')?0x00ff00:(builderTool==='task'?0xffff00:0x00ffff);
    ghostMesh = new THREE.Mesh(new THREE.BoxGeometry(0.5,2,0.5), new THREE.MeshBasicMaterial({color:col, transparent:true, opacity:0.5}));
    scene.add(ghostMesh);
}

function enterBuilderMode() {
    currentMode = MODES.BUILDER;
    switchUI('builder-ui');
    if(scene.getObjectByName("previewChar")) scene.remove(scene.getObjectByName("previewChar"));
    camera.position.set(0, 20, 20); camera.lookAt(0,0,0);
    builderCamPitch = -0.5; builderCamYaw = 0;
    updateGhostMesh();
    document.exitPointerLock();
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