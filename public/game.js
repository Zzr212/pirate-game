import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SkeletonUtils } from 'three/addons/utils/SkeletonUtils.js';

const socket = io();

// Scene Setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB); // Sky blue
scene.fog = new THREE.Fog(0x87CEEB, 10, 50);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
// Pticija perspektiva (Among Us style)
camera.position.set(0, 15, 10);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(10, 20, 10);
dirLight.castShadow = true;
scene.add(dirLight);

// Floor (The Ship Deck)
const planeGeo = new THREE.PlaneGeometry(50, 50);
const planeMat = new THREE.MeshStandardMaterial({ color: 0x8B4513 }); // Brown wood
const floor = new THREE.Mesh(planeGeo, planeMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// Assets
let charModel = null;
let enemyModel = null;
const loader = new GLTFLoader();

// Ucitaj modele
loader.load('assets/character.gltf', (gltf) => {
    charModel = gltf.scene;
    // Podesi skalu ako je model prevelik/premali
    charModel.scale.set(1, 1, 1);
    charModel.traverse(c => { if(c.isMesh) c.castShadow = true; });
    console.log("Character loaded");
});

loader.load('assets/enemy.gltf', (gltf) => {
    enemyModel = gltf.scene;
    enemyModel.scale.set(1, 1, 1);
    console.log("Enemy loaded");
});

// Players State
const players = {}; // Lokalna kopija
const mixers = {}; // Animation mixers

// Input
const keys = { w: false, a: false, s: false, d: false };
window.addEventListener('keydown', (e) => {
    if(e.key.toLowerCase() in keys) keys[e.key.toLowerCase()] = true;
    if(e.code === 'Space') attack();
});
window.addEventListener('keyup', (e) => {
    if(e.key.toLowerCase() in keys) keys[e.key.toLowerCase()] = false;
});

// Attack Logic
function attack() {
    socket.emit('attack');
}

// Socket Events
socket.on('currentPlayers', (serverPlayers) => {
    for (let id in serverPlayers) {
        if (!players[id]) addPlayer(serverPlayers[id]);
    }
});

socket.on('newPlayer', (playerInfo) => {
    addPlayer(playerInfo);
});

socket.on('playerMoved', (data) => {
    if (players[data.id]) {
        // Interpolacija bi bila bolja, ali za jednostavnost direktno postavljamo
        players[data.id].mesh.position.set(data.x, data.y, data.z);
        players[data.id].mesh.rotation.y = data.rotation;
        updateAnim(data.id, data.anim);
    }
});

socket.on('disconnect', (id) => {
    if (players[id]) {
        scene.remove(players[id].mesh);
        delete players[id];
        delete mixers[id];
    }
});

socket.on('captainSelected', (data) => {
    showMessage(data.id === socket.id ? "YOU ARE THE CAPTAIN!" : "A CAPTAIN IS INFECTED!");
    
    if (players[data.id]) {
        // Dodaj crveni dim (pojednostavljeno kao crveno svjetlo ili sfera)
        const smoke = new THREE.PointLight(0xff0000, 2, 5);
        smoke.position.y = 2;
        players[data.id].mesh.add(smoke);
        
        // Promjeni boju materijala privremeno da se zna ko je
        players[data.id].mesh.traverse((child) => {
            if (child.isMesh) child.material.color.setHex(0xffaaaa);
        });
    }
});

socket.on('playerInfected', (data) => {
    transformToSkeleton(data.id);
    if(data.id === socket.id) showMessage("YOU ARE NOW A SKELETON!");
});

socket.on('playerKilled', (data) => {
    if (players[data.id]) {
        players[data.id].mesh.rotation.x = -Math.PI / 2; // Lezi dolje
        players[data.id].mesh.position.y = 0.5;
    }
    if(data.id === socket.id) showMessage("YOU DIED!");
});

socket.on('gameStart', () => {
    document.getElementById('lobby-screen').style.display = 'none';
    document.getElementById('game-ui').style.display = 'block';
});

// UI Listeners
document.getElementById('ready-btn').addEventListener('click', () => {
    socket.emit('playerReady');
    document.getElementById('ready-btn').innerText = "WAITING...";
    document.getElementById('ready-btn').disabled = true;
});

// Helper Functions
function addPlayer(info) {
    if (!charModel) return; // Cekaj da se model ucita

    // Koristi SkeletonUtils za kloniranje rigovanih modela
    const mesh = info.role === 'skeleton' && enemyModel ? SkeletonUtils.clone(enemyModel) : SkeletonUtils.clone(charModel);
    
    scene.add(mesh);
    mesh.position.set(info.x, info.y, info.z);

    // Setup Animation Mixer
    const mixer = new THREE.AnimationMixer(mesh);
    // Pretpostavljamo da GLTF ima animacije po imenu
    // Ovdje moras mapirati tvoje stvarne animacije iz GLTF-a
    // const clips = gltf.animations; 
    // Za demo, preskacemo kompleksno ucitavanje klipova bez fajla
    
    players[info.id] = {
        mesh: mesh,
        id: info.id
    };
    mixers[info.id] = mixer;
}

function transformToSkeleton(id) {
    if (players[id] && enemyModel) {
        scene.remove(players[id].mesh);
        const mesh = SkeletonUtils.clone(enemyModel);
        mesh.position.copy(players[id].mesh.position);
        scene.add(mesh);
        players[id].mesh = mesh;
    }
}

function updateAnim(id, animName) {
    // Logika za play/stop animacija u mixeru
    // Zahtjeva pristup 'clips' iz originalnog GLTF loadera
}

function showMessage(msg) {
    const el = document.getElementById('message-area');
    el.innerText = msg;
    setTimeout(() => el.innerText = '', 5000);
}

// Game Loop
const clock = new THREE.Clock();
const mySpeed = 5;

function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    // Lokalno kretanje
    if (players[socket.id] && !document.getElementById('lobby-screen').style.display === 'block') {
        const mesh = players[socket.id].mesh;
        let moved = false;
        const oldPos = mesh.position.clone();

        if (keys.w) { mesh.position.z -= mySpeed * delta; moved = true; mesh.rotation.y = Math.PI; }
        if (keys.s) { mesh.position.z += mySpeed * delta; moved = true; mesh.rotation.y = 0; }
        if (keys.a) { mesh.position.x -= mySpeed * delta; moved = true; mesh.rotation.y = -Math.PI/2; }
        if (keys.d) { mesh.position.x += mySpeed * delta; moved = true; mesh.rotation.y = Math.PI/2; }

        // Kamera prati igraca
        camera.position.x = mesh.position.x;
        camera.position.z = mesh.position.z + 10;
        camera.lookAt(mesh.position);

        if (moved) {
            socket.emit('playerMovement', {
                x: mesh.position.x,
                y: mesh.position.y,
                z: mesh.position.z,
                rotation: mesh.rotation.y,
                anim: 'Run'
            });
        }
    }

    // Update mixers
    for (let id in mixers) {
        mixers[id].update(delta);
    }

    renderer.render(scene, camera);
}

// Pokreni loop tek kad se model ucita, ili provjeravaj unutar loopa
animate();