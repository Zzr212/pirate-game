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

// Three.js Globals
let scene, camera, renderer, clock;
let character, mixer; 
let players = {}; // id -> { mesh, mixer, ... }
let mapMesh = null;
let taskMarkers = [];
let portalMesh = null;

// Inputs
const keys = { w: false, a: false, s: false, d: false, space: false };
let camYaw = 0, camPitch = 0.3;

// Builder State
let builderConfig = { spawns: [], tasks: [], portal: {x:0, y:0, z:0} };
let builderTool = 'spawn';

// --- INIT ---
function init() {
    // 1. Setup Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05080a);
    scene.fog = new THREE.FogExp2(0x05080a, 0.02);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 1000);
    camera.position.set(0, 5, 10);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    
    // Append to different divs based on mode? No, one canvas, we toggle UI.
    document.getElementById('menu-background-3d').appendChild(renderer.domElement);

    // Lights
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(10, 20, 10);
    dir.castShadow = true;
    scene.add(dir);

    // 2. Connect Socket
    socket = io();
    setupSocket();

    // 3. Inputs
    setupInputs();

    // 4. Load Assets (Map & Char)
    loadAssets().then(() => {
        // Start Loop
        clock = new THREE.Clock();
        animate();
        // Setup Menu Character Preview
        setupMenuPreview();
    });

    // 5. UI Bindings
    document.getElementById('btn-play').onclick = () => {
        const name = document.getElementById('inp-nickname').value || "Pirate";
        socket.emit('joinLobby', { name: name, model: 'pirate_1' });
    };
    document.getElementById('btn-ready').onclick = () => socket.emit('playerReady');
    document.getElementById('btn-builder').onclick = enterBuilderMode;
    document.getElementById('btn-close-task').onclick = closeTaskModal;
    
    // Builder UI
    document.querySelectorAll('.tool-btn').forEach(b => {
        b.onclick = (e) => {
            document.querySelectorAll('.tool-btn').forEach(x => x.classList.remove('active'));
            e.target.classList.add('active');
            builderTool = e.target.dataset.type;
        };
    });
    document.getElementById('btn-export-map').onclick = () => console.log(JSON.stringify(builderConfig));
    document.getElementById('btn-exit-builder').onclick = () => window.location.reload();
}

async function loadAssets() {
    const loader = new GLTFLoader();
    
    // LOAD MAP
    try {
        const mapGltf = await loader.loadAsync('/map.glb');
        mapMesh = mapGltf.scene;
        scene.add(mapMesh);
    } catch (e) {
        console.warn("No map.glb found, creating fallback plane.");
        const geo = new THREE.PlaneGeometry(100, 100);
        const mat = new THREE.MeshStandardMaterial({ color: 0x333333 });
        mapMesh = new THREE.Mesh(geo, mat);
        mapMesh.rotation.x = -Math.PI/2;
        scene.add(mapMesh);
    }
    
    // LOAD CHARACTER (Placeholder)
    try {
        const charGltf = await loader.loadAsync('/character.gltf');
        character = charGltf.scene;
        // Keep original for cloning
    } catch(e) {
        // Fallback cube
        character = new THREE.Mesh(new THREE.BoxGeometry(1,2,1), new THREE.MeshStandardMaterial({color:0xff0000}));
    }
}

// --- GAME LOGIC ---

function setupSocket() {
    socket.on('lobbyUpdate', (data) => {
        if(currentMode !== MODES.LOBBY) enterLobby();
        updateLobbyUI(data.players, data.status);
    });

    socket.on('gameStart', (data) => {
        enterGame(data);
    });

    socket.on('updatePlayer', (p) => {
        if(!players[p.id]) spawnPlayer(p);
        const pl = players[p.id];
        pl.targetPos.set(p.x, p.y, p.z);
        pl.targetRot = p.rot;
    });

    socket.on('infectionStarted', (data) => {
        document.getElementById('role-display').innerText = (data.captainId === socket.id) ? "YOU ARE THE CAPTAIN" : "SURVIVE";
        document.getElementById('role-display').style.color = (data.captainId === socket.id) ? "red" : "#cdbe91";
        if(players[data.captainId]) {
            // Visual change for captain
            players[data.captainId].mesh.scale.setScalar(1.2);
            // Add red glow logic here
        }
    });

    socket.on('playerInfected', (data) => {
        if(players[data.id]) {
            // Change model to skeleton or just color for now
            players[data.id].mesh.material = new THREE.MeshStandardMaterial({color: 0xaaaaaa}); // Simplified
        }
        if(data.id === socket.id) {
            myRole = 'skeleton';
            document.getElementById('role-display').innerText = "HUNT THEM";
        }
    });

    socket.on('playerDied', (data) => {
        if(players[data.id]) players[data.id].mesh.visible = false;
        if(data.id === socket.id) {
            myRole = 'spectator';
            document.getElementById('spectator-ui').style.display = 'block';
        }
    });

    socket.on('portalOpened', (pos) => {
        if(!portalMesh) {
            const geo = new THREE.TorusGeometry(1, 0.2, 16, 100);
            const mat = new THREE.MeshBasicMaterial({ color: 0x00ffff });
            portalMesh = new THREE.Mesh(geo, mat);
            portalMesh.position.set(pos.x, pos.y, pos.z);
            scene.add(portalMesh);
            // Add particle effect logic here
        }
        showNotification("PORTAL IS OPEN! ESCAPE!");
    });
}

// --- MODES & UI ---

function enterLobby() {
    currentMode = MODES.LOBBY;
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('lobby-screen').style.display = 'flex';
    // Clear 3D preview
    scene.remove(previewChar);
}

function updateLobbyUI(playersDict, status) {
    const list = document.getElementById('lobby-player-list');
    list.innerHTML = '';
    Object.values(playersDict).forEach(p => {
        const div = document.createElement('div');
        div.className = `lobby-player ${p.isReady ? 'ready' : ''}`;
        div.innerHTML = `<span>${p.name}</span> <span>${p.isReady ? 'READY' : '...'}</span>`;
        list.appendChild(div);
    });
}

function enterGame(data) {
    currentMode = MODES.GAME;
    document.getElementById('lobby-screen').style.display = 'none';
    document.getElementById('game-ui').style.display = 'block';
    
    // Spawn self
    const me = data.players[socket.id];
    spawnPlayer(me, true);
    
    // Spawn others
    Object.values(data.players).forEach(p => {
        if(p.id !== socket.id) spawnPlayer(p);
    });

    // Create Tasks
    data.mapConfig.tasks.forEach(t => {
        const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.3), new THREE.MeshBasicMaterial({color: 0xffff00}));
        marker.position.set(t.x, t.y, t.z);
        // marker.userData = { id: t.id, type: t.type }; // Store logic
        scene.add(marker);
        taskMarkers.push({ mesh: marker, id: t.id, type: t.type });
    });

    // Update Task UI
    const ul = document.getElementById('task-list');
    ul.innerHTML = '';
    me.tasks.forEach(tid => {
        const li = document.createElement('li');
        li.id = `ui-task-${tid}`;
        li.innerText = tid; // Replace with proper name later
        ul.appendChild(li);
    });
    
    document.body.requestPointerLock();
}

function spawnPlayer(data, isMe = false) {
    if(players[data.id]) return; // Already exists
    
    // Clone character model
    const mesh = SkeletonUtils.clone(character);
    mesh.position.set(data.x, data.y, data.z);
    scene.add(mesh);

    players[data.id] = {
        id: data.id,
        mesh: mesh,
        targetPos: new THREE.Vector3(data.x, data.y, data.z),
        targetRot: data.rot
    };

    if(isMe) {
        myId = data.id;
        // Attach camera
        // Camera logic is in animate loop
    }
}

// --- TASK LOGIC ---

function checkInteraction() {
    if(myRole !== 'survivor') return;
    
    const myPos = players[myId].mesh.position;
    let closestTask = null;
    let minDist = 2.0;

    taskMarkers.forEach(t => {
        // Check if I have this task
        // We need local player data. Let's assume we store "myTasks" array globally or check UI
        const dist = myPos.distanceTo(t.mesh.position);
        if(dist < minDist) {
            closestTask = t;
            minDist = dist;
        }
    });

    const prompt = document.getElementById('interaction-prompt');
    if(closestTask) {
        prompt.style.display = 'block';
        prompt.innerText = `PRESS [E] TO ${closestTask.type.toUpperCase()}`;
        if(keys.e_pressed) {
            keys.e_pressed = false; // consume key
            openTask(closestTask);
        }
    } else {
        prompt.style.display = 'none';
    }
    
    // Portal Logic
    if(portalMesh && myPos.distanceTo(portalMesh.position) < 3.0) {
        prompt.style.display = 'block';
        prompt.innerText = "PRESS [E] TO ESCAPE";
        if(keys.e_pressed) {
            socket.emit('escape');
        }
    }
}

function openTask(task) {
    document.exitPointerLock();
    const modal = document.getElementById('task-modal');
    modal.style.display = 'flex';
    document.getElementById('task-title').innerText = task.type.toUpperCase();
    
    const content = document.getElementById('task-content');
    content.innerHTML = '';
    
    // Simple mini-game: Click 3 red buttons
    for(let i=0; i<3; i++) {
        const btn = document.createElement('div');
        btn.className = 'wire-game-btn';
        btn.onclick = function() {
            this.classList.add('fixed');
            if(document.querySelectorAll('.wire-game-btn.fixed').length === 3) {
                socket.emit('completeTask', task.id);
                closeTaskModal();
            }
        };
        content.appendChild(btn);
    }
}

function closeTaskModal() {
    document.getElementById('task-modal').style.display = 'none';
    document.body.requestPointerLock();
}

// --- ANIMATION LOOP ---
function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    if(currentMode === MODES.GAME && players[myId]) {
        const me = players[myId];
        
        if(myRole !== 'spectator') {
            // Movement Logic
            const speed = (myRole === 'captain') ? 7 : 5;
            const dir = new THREE.Vector3();
            const forward = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
            const right = new THREE.Vector3(Math.sin(camYaw - Math.PI/2), 0, Math.cos(camYaw - Math.PI/2));
            
            if(keys.w) dir.sub(forward);
            if(keys.s) dir.add(forward);
            if(keys.a) dir.add(right);
            if(keys.d) dir.sub(right);
            
            if(dir.length() > 0) {
                dir.normalize().multiplyScalar(speed * delta);
                me.mesh.position.add(dir);
                // Rotation
                me.mesh.rotation.y = Math.atan2(-dir.x, -dir.z); // Simple look dir
                
                // Send to server
                socket.emit('updatePos', {
                    x: me.mesh.position.x, 
                    y: me.mesh.position.y, 
                    z: me.mesh.position.z,
                    rot: me.mesh.rotation.y,
                    anim: 'Run'
                });
            }

            // Attack Logic
            if(keys.mouseLeft && (myRole === 'captain' || myRole === 'skeleton')) {
                // Raycast or distance check to kill
                // For simplicity, just check distance to all players
                Object.values(players).forEach(target => {
                    if(target.id !== myId) {
                        if(me.mesh.position.distanceTo(target.mesh.position) < 1.5) {
                            socket.emit('attackPlayer', target.id);
                        }
                    }
                });
                keys.mouseLeft = false; // Cooldown/One click
            }

            // Camera Follow
            const camOff = new THREE.Vector3(0, 4, 6); // TP View
            camOff.applyAxisAngle(new THREE.Vector3(0,1,0), camYaw);
            camera.position.copy(me.mesh.position).add(camOff);
            camera.lookAt(me.mesh.position.clone().add(new THREE.Vector3(0, 1.5, 0)));
        } else {
            // Spectator Cam (Free Fly)
            // Implement WASD free cam
        }

        checkInteraction();
    }
    
    // Network Interpolation for others
    Object.values(players).forEach(p => {
        if(p.id !== myId) {
            p.mesh.position.lerp(p.targetPos, 10 * delta);
            p.mesh.rotation.y = p.targetRot; // Need lerp here too ideally
        }
    });

    renderer.render(scene, camera);
}

// --- INPUTS ---
function setupInputs() {
    window.addEventListener('keydown', (e) => {
        if(e.key.toLowerCase() in keys) keys[e.key.toLowerCase()] = true;
        if(e.key === 'e') keys.e_pressed = true;
    });
    window.addEventListener('keyup', (e) => {
        if(e.key.toLowerCase() in keys) keys[e.key.toLowerCase()] = false;
    });
    window.addEventListener('mousemove', (e) => {
        if(document.pointerLockElement) {
            camYaw -= e.movementX * 0.002;
        }
    });
    window.addEventListener('mousedown', () => keys.mouseLeft = true);
}

// --- BUILDER MODE ---
function enterBuilderMode() {
    currentMode = MODES.BUILDER;
    document.getElementById('main-menu').style.display = 'none';
    document.getElementById('builder-ui').style.display = 'block';
    
    // Enable free fly cam
    camera.position.set(0, 20, 0);
    camera.lookAt(0,0,0);
    
    window.addEventListener('mousedown', (e) => {
        if(currentMode !== MODES.BUILDER || !document.pointerLockElement) return;
        
        // Raycast to floor
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(0,0), camera); // Center of screen
        const intersects = raycaster.intersectObject(mapMesh);
        
        if(intersects.length > 0) {
            const p = intersects[0].point;
            const marker = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2, 0.5), new THREE.MeshBasicMaterial({color: 0x00ff00}));
            marker.position.copy(p);
            scene.add(marker);

            if(builderTool === 'spawn') builderConfig.spawns.push({x:p.x, y:p.y, z:p.z});
            else if(builderTool === 'task') builderConfig.tasks.push({id: 't'+Date.now(), type:'wires', x:p.x, y:p.y, z:p.z});
            else if(builderTool === 'portal') {
                builderConfig.portal = {x:p.x, y:p.y, z:p.z};
                marker.material.color.setHex(0x00ffff);
            }
        }
    });
    
    document.body.requestPointerLock();
}

let previewChar;
function setupMenuPreview() {
    // Show character in menu
    previewChar = SkeletonUtils.clone(character);
    previewChar.position.set(0, -1, -3);
    previewChar.scale.setScalar(1.5);
    scene.add(previewChar);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, -5);
}

init();