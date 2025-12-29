import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'; // KLJUČNO ZA FIX MODELA
import { io } from 'socket.io-client';

// --- CONFIG ---
const DEBUG_COLLISION = false; // Set true to see collision rays

// --- INIT ---
const socket = io();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050505);
scene.fog = new THREE.FogExp2(0x050505, 0.015);

// --- CAMERA SETUP (THIRD PERSON) ---
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// CAMERA BOOM SYSTEM
const cameraBoom = new THREE.Object3D(); // Handles Pitch (Up/Down)
const playerPivot = new THREE.Object3D(); // Handles Yaw (Left/Right)
scene.add(playerPivot);
playerPivot.add(cameraBoom);
cameraBoom.add(camera);
camera.position.set(0, 1.5, -4); // Position behind player
cameraBoom.position.set(0, 1.5, 0); // Shoulder height
playerPivot.rotation.y = Math.PI; // Face forward initially

// --- LIGHTING ---
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(10, 20, 10);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
scene.add(dirLight);

// --- GAME STATE ---
let players = {};
let myId = null;
let myModel = null;
let mixer = null;
let animations = {};
let currentAnim = 'Idle';
let gameState = 'LOBBY';
let myRole = 'LOBBY';
const collidableObjects = []; // Map meshes go here

// MOVEMENT VARIABLES
const moveState = { fwd: false, bwd: false, left: false, right: false, sprint: false };
let isLocked = false;
let pitch = 0; // Camera Up/Down angle

// ASSETS
const loader = new GLTFLoader();
let assets = { character: null, enemy: null };

async function loadGameAssets() {
    try {
        console.log("Loading assets...");
        
        // Load Map
        const mapGltf = await loader.loadAsync('/map.glb');
        const mapModel = mapGltf.scene;
        mapModel.traverse((c) => {
            if (c.isMesh) {
                c.castShadow = true;
                c.receiveShadow = true;
                collidableObjects.push(c); // Add to collision system
            }
        });
        scene.add(mapModel);

        // Load Character
        assets.character = await loader.loadAsync('/character.gltf');
        // Load Skeleton/Enemy
        assets.enemy = await loader.loadAsync('/assets/enemy.gltf');
        
        console.log("All assets ready.");
        document.getElementById('loading-screen').classList.add('hidden');
        document.getElementById('main-menu').classList.remove('hidden');

    } catch (err) {
        console.error("Asset Load Error:", err);
        alert("Error loading game files. check console.");
    }
}
loadGameAssets();

// --- INPUT & CAMERA CONTROLS ---
document.addEventListener('click', () => {
    if (gameState === 'PLAYING' || gameState === 'LOBBY') {
        document.body.requestPointerLock();
    }
});

document.addEventListener('pointerlockchange', () => {
    isLocked = document.pointerLockElement === document.body;
});

document.addEventListener('mousemove', (e) => {
    if (!isLocked) return;

    // YAW (Left/Right) - Rotates the Player
    const sensitivity = 0.002;
    playerPivot.rotation.y -= e.movementX * sensitivity;

    // PITCH (Up/Down) - Rotates the Camera Boom ONLY
    pitch -= e.movementY * sensitivity;
    pitch = Math.max(-Math.PI / 4, Math.min(Math.PI / 3, pitch)); // Clamp angle (don't break neck)
    cameraBoom.rotation.x = pitch;
});

document.addEventListener('mousedown', () => {
    if (gameState !== 'PLAYING' || !isLocked) return;
    playAnim('Punch'); // Or Sword
    socket.emit('attackSwing');
    
    // RAYCAST ATTACK
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const intersects = raycaster.intersectObjects(scene.children, true);

    for (let hit of intersects) {
        if (hit.distance > 3.5) continue; // Melee range
        
        // Traverse up to find user data
        let obj = hit.object;
        while (obj.parent && !obj.userData.playerId) obj = obj.parent;
        
        if (obj.userData.playerId && obj.userData.playerId !== myId) {
            socket.emit('attackHit', obj.userData.playerId);
            createHitEffect(hit.point);
            break; 
        }
    }
});

document.addEventListener('keydown', (e) => {
    switch(e.code) {
        case 'KeyW': moveState.fwd = true; break;
        case 'KeyS': moveState.bwd = true; break;
        case 'KeyA': moveState.left = true; break;
        case 'KeyD': moveState.right = true; break;
        case 'ShiftLeft': moveState.sprint = true; break;
        case 'KeyE': socket.emit('completeTask'); break;
    }
});
document.addEventListener('keyup', (e) => {
    switch(e.code) {
        case 'KeyW': moveState.fwd = false; break;
        case 'KeyS': moveState.bwd = false; break;
        case 'KeyA': moveState.left = false; break;
        case 'KeyD': moveState.right = false; break;
        case 'ShiftLeft': moveState.sprint = false; break;
    }
});

// --- PHYSICS & COLLISION SYSTEM ---
function checkCollision(pos, dir) {
    // Cast a ray from players feet + slight offset up
    const rayOrigin = pos.clone();
    rayOrigin.y += 0.5; 
    
    const raycaster = new THREE.Raycaster(rayOrigin, dir, 0, 1.0); // Check 1 meter ahead
    const intersects = raycaster.intersectObjects(collidableObjects, true);
    
    return intersects.length > 0;
}

// --- PLAYER LOGIC ---
function createMyPlayer(role) {
    if (myModel) {
        playerPivot.remove(myModel); // Remove from pivot, not just scene
        mixer = null;
    }

    const asset = (role === 'SKELETON') ? assets.enemy : assets.character;
    // USE SKELETON UTILS TO CLONE CORRECTLY
    myModel = SkeletonUtils.clone(asset.scene);
    
    myModel.rotation.y = Math.PI; // Face away from camera
    myModel.position.set(0, 0, 0); // Local to pivot
    myModel.traverse(c => { if(c.isMesh) c.castShadow = true; });

    playerPivot.add(myModel);

    // Anim setup
    mixer = new THREE.AnimationMixer(myModel);
    asset.animations.forEach(clip => {
        animations[clip.name] = mixer.clipAction(clip);
    });
    playAnim('Idle');
}

function playAnim(name) {
    if (!mixer || !animations[name] || currentAnim === name) return;
    
    const fade = 0.2;
    if (animations[currentAnim]) animations[currentAnim].fadeOut(fade);
    animations[name].reset().fadeIn(fade).play();
    currentAnim = name;
}

// --- SOCKET HANDLERS ---
socket.on('connect', () => { myId = socket.id; });

socket.on('updatePlayers', (serverPlayers) => {
    updateLobbyUI(serverPlayers);

    Object.keys(serverPlayers).forEach(id => {
        const pData = serverPlayers[id];

        // 1. Handle MY Player
        if (id === myId) {
            if (myRole !== pData.role) {
                myRole = pData.role;
                updateHUD(pData.role);
                if (gameState === 'PLAYING') createMyPlayer(pData.role);
            }
            // Sync HP
            document.getElementById('hp-fill').style.width = pData.hp + '%';
            
            // Initial server position sync (teleport once)
            if (pData.role === 'LOBBY') {
               // playerPivot.position.set(pData.x, pData.y, pData.z); 
            }
            return;
        }

        // 2. Handle OTHER Players
        let p = players[id];
        
        // Spawn if new
        if (!p) {
            if (!assets.character) return;
            const asset = (pData.role === 'SKELETON') ? assets.enemy : assets.character;
            const mesh = SkeletonUtils.clone(asset.scene);
            
            mesh.userData.playerId = id;
            scene.add(mesh);
            
            // Name tag
            const sprite = createNameTag(pData.username);
            sprite.position.y = 2.2;
            mesh.add(sprite);

            players[id] = { mesh: mesh, role: pData.role, targetPos: new THREE.Vector3() };
            p = players[id];
        }

        // Role Change check
        if (p.role !== pData.role) {
            scene.remove(p.mesh);
            delete players[id]; // Will respawn next frame with correct model
            return;
        }

        // Interpolation Target
        p.targetPos.set(pData.x, pData.y, pData.z);
        
        // Smooth Move
        p.mesh.position.lerp(p.targetPos, 0.15);
        p.mesh.rotation.y = pData.rotation;

        // Particle Trail for Infected
        if (p.role === 'CAPTAIN' && gameState === 'PLAYING') {
            spawnBloodParticle(p.mesh.position);
        }
    });

    // Cleanup
    Object.keys(players).forEach(id => {
        if (!serverPlayers[id]) {
            scene.remove(players[id].mesh);
            delete players[id];
        }
    });
});

socket.on('gameState', (state) => {
    gameState = state;
    document.getElementById('main-menu').classList.add('hidden');
    document.getElementById('lobby-screen').classList.add('hidden');
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('game-over').classList.add('hidden');

    if (state === 'LOBBY') document.getElementById('lobby-screen').classList.remove('hidden');
    if (state === 'PLAYING') {
        document.getElementById('hud').classList.remove('hidden');
        if(!myModel) createMyPlayer(myRole);
    }
});

socket.on('timer', (t) => {
    const el = document.getElementById('timer-display');
    el.classList.remove('hidden');
    el.innerText = t;
});

socket.on('gameOver', (msg) => {
    document.exitPointerLock();
    document.getElementById('game-over').classList.remove('hidden');
    document.getElementById('winner-text').innerText = msg;
    // Reset pivot
    playerPivot.position.set(0,0,0);
});

// --- HELPER FUNCTIONS ---
function createNameTag(text) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256; canvas.height = 64;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0,0,256,64);
    ctx.fillStyle = 'white';
    ctx.font = 'bold 30px Arial';
    ctx.textAlign = 'center';
    ctx.fillText(text, 128, 45);
    
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
    sprite.scale.set(2, 0.5, 1);
    return sprite;
}

function spawnBloodParticle(pos) {
    // Simple mock particle
    const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const part = new THREE.Mesh(geo, mat);
    part.position.copy(pos);
    part.position.y += 0.2;
    scene.add(part);
    
    // Animate and remove
    const startTime = Date.now();
    function animPart() {
        const elapsed = Date.now() - startTime;
        part.position.y -= 0.01;
        part.rotation.x += 0.1;
        if (elapsed > 1000) scene.remove(part);
        else requestAnimationFrame(animPart);
    }
    animPart();
}

function createHitEffect(pos) {
    const light = new THREE.PointLight(0xff0000, 2, 2);
    light.position.copy(pos);
    scene.add(light);
    setTimeout(() => scene.remove(light), 100);
}

// --- UI UPDATES ---
function updateLobbyUI(players) {
    const list = document.getElementById('player-list');
    list.innerHTML = '';
    Object.values(players).forEach(p => {
        const div = document.createElement('div');
        div.className = `lobby-item ${p.isReady ? 'ready' : ''}`;
        div.innerText = `${p.username} - ${p.isReady ? 'READY' : 'WAITING'}`;
        list.appendChild(div);
    });
}

function updateHUD(role) {
    const rDiv = document.getElementById('role-text');
    rDiv.innerText = role.replace('_', ' ');
    rDiv.className = role.toLowerCase();
}

// --- MAIN LOOP ---
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    if (gameState === 'PLAYING' && myModel) {
        // --- MOVEMENT PHYSICS WITH COLLISION ---
        const speed = moveState.sprint ? 10 : 6;
        const moveDist = speed * delta;
        const currentPos = playerPivot.position.clone();
        
        const moveVec = new THREE.Vector3(0, 0, 0);
        
        // Calculate Direction relative to Pivot (Yaw)
        const forward = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0,1,0), playerPivot.rotation.y);
        const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0,1,0), playerPivot.rotation.y);

        if (moveState.fwd) {
            if (!checkCollision(currentPos, forward)) moveVec.add(forward);
        }
        if (moveState.bwd) {
            const back = forward.clone().negate();
            if (!checkCollision(currentPos, back)) moveVec.add(back);
        }
        if (moveState.right) {
            const r = right.clone().negate(); // Inverted for correct feel
            if (!checkCollision(currentPos, r)) moveVec.add(r);
        }
        if (moveState.left) {
            if (!checkCollision(currentPos, right)) moveVec.add(right);
        }

        // Apply Movement
        if (moveVec.length() > 0) {
            moveVec.normalize().multiplyScalar(moveDist);
            playerPivot.position.add(moveVec);
            playAnim(moveState.sprint ? 'Run' : 'Walk');
        } else {
            playAnim('Idle');
        }

        // Gravity (Simple)
        // In real navmesh we would check floor Y, here we assume flat 0
        if (playerPivot.position.y > 0) playerPivot.position.y = 0;

        // Send to Server
        socket.emit('updateMove', {
            x: playerPivot.position.x,
            y: playerPivot.position.y,
            z: playerPivot.position.z,
            rotation: playerPivot.rotation.y, // Model rotates with pivot
            anim: currentAnim
        });
    }

    if (mixer) mixer.update(delta);
    renderer.render(scene, camera);
}

// BIND MENU BUTTONS
document.getElementById('btn-find').addEventListener('click', () => {
    socket.emit('playerReady'); // In this simplified version, Join = Ready toggle logic
});
document.getElementById('btn-ready').addEventListener('click', () => {
    socket.emit('playerReady');
});

animate();