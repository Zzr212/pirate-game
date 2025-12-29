import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { io } from 'socket.io-client';

// SETUP SOCKET
const socket = io();

// SCENE SETUP
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);
scene.fog = new THREE.FogExp2(0x111111, 0.02);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// LIGHTS
const ambientLight = new THREE.AmbientLight(0x404040, 1.5);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 1);
dirLight.position.set(10, 20, 10);
dirLight.castShadow = true;
scene.add(dirLight);

// GAME VARIABLES
const players = {}; 
let myId = null;
let myModel = null;
let mixer = null;
let animations = {};
let currentAction = 'Idle';
let isSpectator = false;
let myRole = 'LOBBY';
let gameState = 'LOBBY'; // <--- OVO JE NEDOSTAJALO

// ASSETS
const loader = new GLTFLoader();
let assets = { character: null, enemy: null, map: null };

// LOADING MANAGER
async function loadAssets() {
    try {
        // Load Map
        const mapData = await loader.loadAsync('/map.glb');
        scene.add(mapData.scene);
        
        // Load Character (Survivor/Captain)
        const charData = await loader.loadAsync('/character.gltf');
        assets.character = charData;

        // Load Enemy (Skeleton)
        const enemyData = await loader.loadAsync('/assets/enemy.gltf');
        assets.enemy = enemyData;
        
        console.log("Assets loaded!");
    } catch (error) {
        console.error("Error loading models:", error);
    }
}
loadAssets();

// CONTROLS
const controls = new PointerLockControls(camera, document.body);
const moveState = { forward: false, backward: false, left: false, right: false, jump: false, sprint: false };
const velocity = new THREE.Vector3();

// DOM ELEMENTS
const menu = document.getElementById('main-menu');
const lobby = document.getElementById('lobby-screen');
const hud = document.getElementById('hud');
const btnFind = document.getElementById('btn-find-match');
const btnReady = document.getElementById('btn-ready');

// EVENT LISTENERS
btnFind.addEventListener('click', () => {
    menu.classList.add('hidden');
    lobby.classList.remove('hidden');
    controls.lock(); 
});

btnReady.addEventListener('click', () => {
    socket.emit('playerReady');
    btnReady.style.borderColor = "#00ff00"; // Visual feedback
});

document.addEventListener('keydown', (e) => {
    if(isSpectator) return;
    switch (e.code) {
        case 'KeyW': moveState.forward = true; break;
        case 'KeyA': moveState.left = true; break;
        case 'KeyS': moveState.backward = true; break;
        case 'KeyD': moveState.right = true; break;
        case 'Space': if (velocity.y === 0) velocity.y = 15; break; 
        case 'ShiftLeft': moveState.sprint = true; break;
        case 'KeyE': socket.emit('completeTask'); break; 
    }
});
document.addEventListener('keyup', (e) => {
    switch (e.code) {
        case 'KeyW': moveState.forward = false; break;
        case 'KeyA': moveState.left = false; break;
        case 'KeyS': moveState.backward = false; break;
        case 'KeyD': moveState.right = false; break;
        case 'ShiftLeft': moveState.sprint = false; break;
    }
});

document.addEventListener('mousedown', () => {
    if(!controls.isLocked) controls.lock();
    if(myRole !== 'SPECTATOR' && myRole !== 'LOBBY') {
        playAnim('Punch'); 
        
        // Raycast attack logic
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(0,0), camera);
        
        // Find intersections
        const intersects = raycaster.intersectObjects(scene.children, true);
        
        for (let i = 0; i < intersects.length; i++) {
            // Find root object (player model)
            let obj = intersects[i].object;
            while(obj.parent && !obj.userData.playerId) {
                obj = obj.parent;
            }

            if (intersects[i].distance < 3 && obj.userData.playerId && obj.userData.playerId !== myId) {
                socket.emit('attackHit', obj.userData.playerId);
                break;
            }
        }
    }
});

// SOCKET HANDLERS
socket.on('connect', () => { myId = socket.id; });

socket.on('updatePlayers', (serverPlayers) => {
    // Update UI List in Lobby
    const list = document.getElementById('player-list');
    if(list) {
        list.innerHTML = '';
        Object.values(serverPlayers).forEach(p => {
            list.innerHTML += `<div class="${p.isReady ? 'ready' : 'not-ready'}">Player ${p.id.substr(0,4)} ${p.isReady ? '(READY)' : ''}</div>`;
        });
    }

    // Handle 3D Models
    Object.keys(serverPlayers).forEach(id => {
        const pData = serverPlayers[id];

        if (id === myId) {
            // My Role Logic update
            if (myRole !== pData.role) {
                myRole = pData.role;
                updateRoleUI(pData.role);
                if (pData.role === 'SKELETON') createMyPlayer(pData.role);
                if (pData.role === 'CAPTAIN') createMyPlayer(pData.role);
                if (pData.role === 'SPECTATOR') {
                    isSpectator = true;
                    if(myModel) scene.remove(myModel);
                }
            }
            // Update HP UI
            const hpBar = document.getElementById('hp-bar-fill');
            if(hpBar) hpBar.style.width = pData.hp + '%';
            return; 
        }

        // Other players
        if (!players[id]) {
            // Create new player mesh
            if (!assets.character || !assets.enemy) return; // Wait for load

            let model = null;
            if (pData.role === 'SKELETON') model = assets.enemy.scene.clone();
            else model = assets.character.scene.clone();

            model.position.set(pData.x, pData.y, pData.z);
            model.userData.playerId = id; 
            scene.add(model);
            players[id] = { mesh: model, role: pData.role };
        } else {
            // Update position
            const p = players[id];
            if(p.mesh) {
                p.mesh.position.lerp(new THREE.Vector3(pData.x, pData.y, pData.z), 0.2);
                p.mesh.rotation.y = pData.rotation;
                
                // Check if model needs swap (e.g. became infected)
                if (p.role !== pData.role) {
                    scene.remove(p.mesh);
                    let newModel = (pData.role === 'SKELETON') ? assets.enemy.scene.clone() : assets.character.scene.clone();
                    newModel.position.copy(p.mesh.position);
                    newModel.userData.playerId = id;
                    scene.add(newModel);
                    players[id].mesh = newModel;
                    players[id].role = pData.role;
                }
            }
        }
    });

    // Remove disconnected
    Object.keys(players).forEach(id => {
        if (!serverPlayers[id]) {
            if(players[id].mesh) scene.remove(players[id].mesh);
            delete players[id];
        }
    });
});

socket.on('gameState', (state) => {
    gameState = state; // AZURIRAMO STATE
    if (state === 'PLAYING') {
        lobby.classList.add('hidden');
        hud.classList.remove('hidden');
        createMyPlayer(myRole);
    }
});

socket.on('timer', (time) => {
    const cd = document.getElementById('countdown');
    cd.classList.remove('hidden');
    cd.innerText = time;
});

socket.on('taskUpdate', (data) => {
    const pct = (data.current / data.total) * 100;
    const taskBar = document.getElementById('task-bar-fill');
    if(taskBar) taskBar.style.width = pct + '%';
});

socket.on('gameOver', (msg) => {
    document.getElementById('game-over').classList.remove('hidden');
    document.getElementById('winner-text').innerText = msg;
    hud.classList.add('hidden');
    controls.unlock();
});

// HELPERS
function createMyPlayer(role) {
    if (myModel) scene.remove(myModel);
    if (!assets.character || !assets.enemy) return;

    const source = (role === 'SKELETON') ? assets.enemy : assets.character;
    
    myModel = source.scene.clone();
    scene.add(myModel);
    
    // Setup Animations
    mixer = new THREE.AnimationMixer(myModel);
    if(source.animations) {
        source.animations.forEach((clip) => {
            animations[clip.name] = mixer.clipAction(clip);
        });
    }
    playAnim('Idle');
    
    // Reset Camera
    camera.position.set(0, 5, 10);
}

function playAnim(name) {
    if(!animations[name]) return;
    if (currentAction === name) return;
    
    if (animations[currentAction]) animations[currentAction].fadeOut(0.2);
    animations[name].reset().fadeIn(0.2).play();
    currentAction = name;
}

function updateRoleUI(role) {
    const el = document.getElementById('role-display');
    if(!el) return;
    el.innerText = role;
    if(role === 'CAPTAIN') el.style.color = 'red';
    else if (role === 'SKELETON') el.style.color = 'purple';
    else el.style.color = 'cyan';
}

// GAME LOOP
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    if (gameState === 'PLAYING' && myModel && !isSpectator) {
        // Movement Logic
        if (moveState.forward) velocity.z = moveState.sprint ? 12 : 6;
        else if (moveState.backward) velocity.z = -4;
        else velocity.z = 0;

        if (moveState.left) velocity.x = -4;
        else if (moveState.right) velocity.x = 4;
        else velocity.x = 0;

        // Apply movement relative to camera direction
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        camDir.y = 0;
        camDir.normalize();
        
        const moveVec = new THREE.Vector3();
        moveVec.add(camDir.clone().multiplyScalar(velocity.z * delta)); 
        
        const sideDir = new THREE.Vector3(-camDir.z, 0, camDir.x);
        moveVec.add(sideDir.clone().multiplyScalar(velocity.x * delta));

        myModel.position.add(moveVec);
        
        // Rotate model to face move direction
        if (velocity.length() > 0) {
            playAnim(moveState.sprint ? 'Run' : 'Walk');
            const targetRot = Math.atan2(moveVec.x, moveVec.z);
            myModel.rotation.y = targetRot;
        } else {
            playAnim('Idle');
        }

        // Camera Follow
        camera.position.x = myModel.position.x;
        camera.position.z = myModel.position.z + 5;
        camera.position.y = myModel.position.y + 5;
        camera.lookAt(myModel.position);

        // Send Data
        socket.emit('updateMove', {
            x: myModel.position.x,
            y: myModel.position.y,
            z: myModel.position.z,
            rotation: myModel.rotation.y,
            anim: currentAction
        });
    }

    if (mixer) mixer.update(delta);
    renderer.render(scene, camera);
}
animate();