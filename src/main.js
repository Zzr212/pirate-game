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
const keys = { w:false, a:false, s:false, d:false, space:false, e:false };
let velocityY = 0;
const GRAVITY = 20;
const JUMP_FORCE = 8;
let onGround = false;

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
    } catch {
        console.log("No map.glb, using grid.");
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(200,200), new THREE.MeshStandardMaterial({color:0x222222}));
        plane.rotation.x = -Math.PI/2;
        plane.receiveShadow = true;
        scene.add(plane);
        mapMesh = plane;
    }

    // CHAR
    try {
        const charGltf = await loader.loadAsync('/character.gltf');
        characterTemplate = charGltf.scene;
        characterTemplate.animations = charGltf.animations;
        // Preview char for menu
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
    document.getElementById('btn-builder').onclick = () => { /* Builder Logic from previous response */ };
    document.getElementById('btn-back-menu').onclick = () => window.location.reload();
}

function setupSocket() {
    socket.on('lobbyUpdate', (data) => {
        if(currentMode !== MODES.GAME) {
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

        if(data.status === 2) { // Already playing
            document.getElementById('game-timer').innerText = "IN PROGRESS";
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
        if(data.captainId === socket.id) {
            myRole = 'captain';
            showNotification("YOU ARE THE CAPTAIN!", "red");
        } else {
            showNotification("CAPTAIN HAS BEEN CHOSEN!", "yellow");
        }
        updateHUD();
    });

    socket.on('playerDied', (data) => {
        if(players[data.id]) players[data.id].mesh.visible = false;
        if(data.id === socket.id) {
            myRole = 'spectator';
            showNotification("YOU DIED. SPECTATING MODE.", "red");
            document.exitPointerLock();
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
            actions[clip.name] = pMixer.clipAction(clip);
        });
    }
    if(actions['Idle']) actions['Idle'].play();

    players[data.id] = {
        id: data.id, mesh, mixer: pMixer, actions, currentAnim: 'Idle',
        targetPos: new THREE.Vector3(data.x, data.y, data.z), targetRot: data.rot
    };

    if(data.id === socket.id) {
        myId = data.id;
        myRole = data.role;
        updateHUD();
        // Camera starts at spawn
        camera.position.set(data.x, data.y + 5, data.z + 5);
    }
}

// PHYSICS & MOVEMENT
function updatePhysics(delta) {
    if(myRole === 'spectator') return;
    const me = players[myId];
    if(!me) return;

    // 1. INPUT MOVEMENT
    const speed = 6;
    const moveDir = new THREE.Vector3();
    const forward = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
    const right = new THREE.Vector3(Math.sin(camYaw - Math.PI/2), 0, Math.cos(camYaw - Math.PI/2));

    if(keys.w) moveDir.sub(forward);
    if(keys.s) moveDir.add(forward);
    if(keys.a) moveDir.add(right);
    if(keys.d) moveDir.sub(right);

    if(moveDir.length() > 0) moveDir.normalize();

    // 2. GRAVITY & JUMP
    if(onGround) {
        velocityY = 0;
        if(keys.space) { velocityY = JUMP_FORCE; onGround = false; }
    } else {
        velocityY -= GRAVITY * delta;
    }

    // 3. APPLY VELOCITY
    const intendedMove = moveDir.multiplyScalar(speed * delta);
    me.mesh.position.x += intendedMove.x;
    me.mesh.position.z += intendedMove.z;
    me.mesh.position.y += velocityY * delta;

    // 4. RAYCAST GROUND CHECK (Collision)
    raycaster.set(new THREE.Vector3(me.mesh.position.x, me.mesh.position.y + 1, me.mesh.position.z), downVector);
    const intersects = raycaster.intersectObject(mapMesh, true); // true = recursive

    if(intersects.length > 0) {
        const dist = intersects[0].distance;
        // 1.0 is offset from origin to feet
        if(dist < 1.1 && velocityY <= 0) { 
            me.mesh.position.y = intersects[0].point.y;
            onGround = true;
        } else {
            onGround = false;
        }
    } else {
        // Fallback floor at 0
        if(me.mesh.position.y < 0) { me.mesh.position.y = 0; onGround = true; }
    }

    // 5. ROTATION
    if(moveDir.lengthSq() > 0) {
        const targetRot = Math.atan2(-moveDir.x, -moveDir.z); 
        // Smooth rot logic omitted for brevity, snap is fine for low lag
        me.mesh.rotation.y = targetRot;
        updateAnim(me, 'Run');
    } else {
        updateAnim(me, 'Idle');
    }

    // 6. SYNC
    socket.emit('updatePos', {
        x: me.mesh.position.x, y: me.mesh.position.y, z: me.mesh.position.z,
        rot: me.mesh.rotation.y, anim: me.currentAnim
    });

    // 7. CAMERA FOLLOW
    const camDist = 5;
    const camHeight = 3;
    const offset = new THREE.Vector3(0, camHeight, camDist);
    offset.applyAxisAngle(new THREE.Vector3(0,1,0), camYaw);
    
    camera.position.lerp(me.mesh.position.clone().add(offset), 0.2);
    camera.lookAt(me.mesh.position.x, me.mesh.position.y + 1.5, me.mesh.position.z);
}

function updateSpectator() {
    // Cycle through players
    const activePlayers = Object.values(players).filter(p => p.mesh.visible);
    if(activePlayers.length === 0) return;

    if(keys.a && !keys.lock) { spectatorIndex--; keys.lock = true; setTimeout(()=>keys.lock=false, 200); }
    if(keys.d && !keys.lock) { spectatorIndex++; keys.lock = true; setTimeout(()=>keys.lock=false, 200); }
    
    if(spectatorIndex < 0) spectatorIndex = activePlayers.length - 1;
    if(spectatorIndex >= activePlayers.length) spectatorIndex = 0;

    const target = activePlayers[spectatorIndex];
    if(target) {
        camera.position.lerp(new THREE.Vector3(target.mesh.position.x, target.mesh.position.y + 10, target.mesh.position.z + 10), 0.1);
        camera.lookAt(target.mesh.position);
    }
}

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    Object.values(players).forEach(p => { if(p.mixer) p.mixer.update(delta); });

    if(currentMode === MODES.GAME) {
        if(myRole !== 'spectator') updatePhysics(delta);
        else updateSpectator();
        
        // Network interpolation for others
        Object.values(players).forEach(p => {
            if(p.id !== myId) {
                p.mesh.position.lerp(p.targetPos, 10 * delta);
                p.mesh.rotation.y = p.targetRot; // Need proper lerp for rotation
                updateAnim(p, p.serverAnim || 'Idle');
            }
        });
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
    window.addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
    window.addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);
    
    document.addEventListener('mousemove', e => {
        if(document.pointerLockElement) {
            camYaw -= e.movementX * 0.002;
            camPitch -= e.movementY * 0.002;
            camPitch = Math.max(-0.5, Math.min(1.0, camPitch));
        }
    });

    document.addEventListener('click', () => {
        if(currentMode === MODES.GAME && myRole !== 'spectator') {
            document.body.requestPointerLock();
            if(myRole === 'captain' || myRole === 'skeleton') {
                updateAnim(players[myId], 'Attack');
                // Raycast attack logic here
            }
        }
    });
}

function updateHUD() {
    const el = document.getElementById('role-display');
    el.innerText = myRole.toUpperCase();
    el.style.color = (myRole === 'captain' || myRole === 'skeleton') ? 'red' : '#c8aa6e';
}

function switchUI(id) {
    ['main-menu', 'lobby-screen', 'game-ui', 'end-screen'].forEach(s => document.getElementById(s).style.display = 'none');
    document.getElementById(id).style.display = (id === 'game-ui' || id === 'main-menu') ? 'block' : 'flex';
}

function formatTime(s) {
    const m = Math.floor(s/60);
    const sec = s%60;
    return `${m}:${sec<10?'0':''}${sec}`;
}

function showNotification(msg, color) { /* Implement UI popup */ console.log(msg); }

init();