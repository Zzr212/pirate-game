const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// Game State
let players = {};
let gameStarted = false;
let gameTimer = null;
let infectionTimer = null;
const INFECTION_DELAY = 30000; // 30 sekundi

io.on('connection', (socket) => {
    console.log('Igrac spojen:', socket.id);

    // Kreiraj novog igraca
    players[socket.id] = {
        id: socket.id,
        x: 0,
        y: 0,
        z: 0,
        rotation: 0,
        role: 'crew', // crew, captain, skeleton
        isDead: false,
        isReady: false,
        tasksCompleted: 0,
        anim: 'Idle'
    };

    // Posalji trenutno stanje novom igracu
    socket.emit('currentPlayers', players);
    socket.emit('gameStatus', gameStarted);
    
    // Obavijesti ostale o novom igracu
    socket.broadcast.emit('newPlayer', players[socket.id]);

    // Igrac spreman (Lobby logic)
    socket.on('playerReady', () => {
        if (players[socket.id]) {
            players[socket.id].isReady = true;
            io.emit('updatePlayerStatus', { id: socket.id, isReady: true });
            checkStartGame();
        }
    });

    // Kretanje igraca
    socket.on('playerMovement', (movementData) => {
        if (players[socket.id] && !players[socket.id].isDead) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;
            players[socket.id].z = movementData.z;
            players[socket.id].rotation = movementData.rotation;
            players[socket.id].anim = movementData.anim;
            
            // Emituj samo osnovne podatke ostalima (ne spamuj cijeli objekat)
            socket.broadcast.emit('playerMoved', {
                id: socket.id,
                x: players[socket.id].x,
                y: players[socket.id].y,
                z: players[socket.id].z,
                rotation: players[socket.id].rotation,
                anim: players[socket.id].anim
            });
        }
    });

    // Napad (Melee)
    socket.on('attack', () => {
        const attacker = players[socket.id];
        if (!attacker || attacker.role === 'crew' || attacker.isDead) return;

        // Provjeri distancu do drugih igraca (Server-side validation)
        for (let id in players) {
            if (id !== socket.id) {
                const target = players[id];
                if (target.isDead) continue;
                if (attacker.role === 'skeleton' && target.role !== 'crew') continue; // Skeletoni ne napadaju kapetana

                const dx = attacker.x - target.x;
                const dz = attacker.z - target.z;
                const dist = Math.sqrt(dx*dx + dz*dz);

                if (dist < 2.5) { // Range napada
                    // Kill logic
                    if (attacker.role === 'captain') {
                        // Kapetan ubija -> postaje skeleton
                        target.isDead = true; // Tehnicki mrtav kao crew
                        target.role = 'skeleton';
                        target.isDead = false; // Ozivi kao skeleton
                        io.emit('playerInfected', { id: target.id, killerId: socket.id });
                    } else if (attacker.role === 'skeleton') {
                        // Skeleton samo ubija
                        target.isDead = true;
                        io.emit('playerKilled', { id: target.id, killerId: socket.id });
                    }
                }
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('Igrac odspojen:', socket.id);
        delete players[socket.id];
        io.emit('disconnect', socket.id);
        
        // Reset igre ako nema nikoga
        if (Object.keys(players).length === 0) {
            resetGame();
        }
    });
});

function checkStartGame() {
    const playerIds = Object.keys(players);
    if (playerIds.length >= 2 && playerIds.every(id => players[id].isReady)) {
        startGame();
    }
}

function startGame() {
    gameStarted = true;
    io.emit('gameStart');
    
    // Resetuj pozicije
    Object.keys(players).forEach((id, index) => {
        players[id].role = 'crew';
        players[id].isDead = false;
        // Rasporedi ih u krug
        players[id].x = Math.cos(index) * 5;
        players[id].z = Math.sin(index) * 5;
    });
    io.emit('currentPlayers', players);

    // Timer za infekciju
    console.log("Game started. Infection in 30s.");
    infectionTimer = setTimeout(() => {
        const playerIds = Object.keys(players);
        if (playerIds.length > 0) {
            const randomId = playerIds[Math.floor(Math.random() * playerIds.length)];
            players[randomId].role = 'captain';
            io.emit('captainSelected', { id: randomId });
            console.log(`Player ${randomId} is the Captain.`);
        }
    }, INFECTION_DELAY);
}

function resetGame() {
    gameStarted = false;
    clearTimeout(infectionTimer);
    players = {}; 
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});