const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'dist')));

// GAME STATE
let players = {};
let gameState = 'LOBBY'; // LOBBY, COUNTDOWN, PLAYING, END
let gameTimer = 0;
let tasksCompleted = 0;
const TOTAL_TASKS_REQUIRED = 10;
let lobbyTimer = null;

// Helper: Reset Game
function resetGame() {
    gameState = 'LOBBY';
    tasksCompleted = 0;
    Object.keys(players).forEach(id => {
        players[id].role = 'LOBBY';
        players[id].isReady = false;
        players[id].hp = 100;
        players[id].dead = false;
        players[id].tasks = [];
    });
    io.emit('gameState', gameState);
    io.emit('updatePlayers', players);
}

io.on('connection', (socket) => {
    console.log('New player:', socket.id);

    // Init player
    players[socket.id] = {
        id: socket.id,
        x: 0, y: 0, z: 0,
        rotation: 0,
        role: 'LOBBY', // LOBBY, CREW, CAPTAIN, SKELETON, SPECTATOR
        isReady: false,
        hp: 100,
        dead: false,
        anim: 'Idle'
    };

    // Ako se spoji usred igre, ide u spectator
    if (gameState === 'PLAYING') {
        players[socket.id].role = 'SPECTATOR';
        players[socket.id].dead = true;
        socket.emit('forceSpectate');
    }

    io.emit('updatePlayers', players);

    // Player Ready Logic
    socket.on('playerReady', () => {
        if (gameState !== 'LOBBY') return;
        players[socket.id].isReady = !players[socket.id].isReady;
        io.emit('updatePlayers', players);
        checkLobbyStart();
    });

    // Movement & Animation Sync
    socket.on('updateMove', (data) => {
        if (!players[socket.id]) return;
        players[socket.id].x = data.x;
        players[socket.id].y = data.y;
        players[socket.id].z = data.z;
        players[socket.id].rotation = data.rotation;
        players[socket.id].anim = data.anim;
        
        // Broadcast drugima (osim sebi da ne laga)
        socket.broadcast.emit('playerMoved', players[socket.id]);
    });

    // Combat Logic
    socket.on('attackHit', (targetId) => {
        if (gameState !== 'PLAYING') return;
        const attacker = players[socket.id];
        const victim = players[targetId];

        if (!attacker || !victim || attacker.dead || victim.dead) return;

        // Captain zarazi Crew -> Skeleton
        if (attacker.role === 'CAPTAIN' && victim.role === 'CREW') {
            victim.hp -= 35; // 3 udarca ubijaju
            if (victim.hp <= 0) {
                victim.role = 'SKELETON';
                victim.hp = 100;
                victim.x = (Math.random() * 20) - 10; // Random respawn
                victim.z = (Math.random() * 20) - 10;
                io.emit('playerInfected', victim.id);
                io.emit('chatMessage', `Player ${victim.id.substr(0,4)} is now a Skeleton!`);
            }
        }
        // Skeleton ubija Crew -> Spectator
        else if (attacker.role === 'SKELETON' && victim.role === 'CREW') {
            victim.hp -= 20;
            if (victim.hp <= 0) {
                victim.dead = true;
                victim.role = 'SPECTATOR';
                io.emit('playerDied', victim.id);
            }
        }
        // Crew ne moze da bije (ili dodaj logiku za odbranu ovdje)

        io.emit('updatePlayers', players);
        checkWinCondition();
    });

    // Task Logic
    socket.on('completeTask', () => {
        if (gameState !== 'PLAYING') return;
        tasksCompleted++;
        io.emit('taskUpdate', { current: tasksCompleted, total: TOTAL_TASKS_REQUIRED });
        
        if (tasksCompleted >= TOTAL_TASKS_REQUIRED) {
            io.emit('portalOpen');
            // Ovdje bi isla logika da moraju do portala, ali za sad recimo da pobjedjuju
            io.emit('gameOver', 'CREW WINS');
            setTimeout(resetGame, 5000);
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('updatePlayers', players);
    });
});

function checkLobbyStart() {
    const playerIds = Object.keys(players);
    const readyCount = playerIds.filter(id => players[id].isReady).length;
    const totalCount = playerIds.length;

    if (totalCount === 0) return;

    // Svi spremni
    if (readyCount === totalCount && totalCount >= 2) { 
        startCountdown();
    } 
    // Vise od 15 ljudi
    else if (totalCount >= 15 && !lobbyTimer) {
        // Auto start za 60 sekundi
        lobbyTimer = setTimeout(startCountdown, 60000);
    }
}

function startCountdown() {
    gameState = 'COUNTDOWN';
    io.emit('gameState', 'COUNTDOWN');
    let count = 3;
    let int = setInterval(() => {
        io.emit('timer', count);
        count--;
        if (count < 0) {
            clearInterval(int);
            startGame();
        }
    }, 1000);
}

function startGame() {
    gameState = 'PLAYING';
    tasksCompleted = 0;
    
    const ids = Object.keys(players);
    // Odaberi Random Captain-a
    const captainIndex = Math.floor(Math.random() * ids.length);
    
    ids.forEach((id, index) => {
        players[id].isReady = false;
        players[id].dead = false;
        players[id].hp = 100;
        
        if (index === captainIndex) {
            players[id].role = 'CAPTAIN'; // Initially hidden usually, but for now specific
        } else {
            players[id].role = 'CREW';
        }
    });

    io.emit('gameState', 'PLAYING');
    io.emit('updatePlayers', players);
    
    // 30 sekundi grace perioda pa Infected krece da siri zarazu (visual effect)
    setTimeout(() => {
        io.emit('infectionStart'); // Client pali crveni trag
    }, 30000);
}

function checkWinCondition() {
    const ids = Object.keys(players);
    const crewAlive = ids.filter(id => players[id].role === 'CREW' && !players[id].dead).length;
    
    if (crewAlive === 0) {
        io.emit('gameOver', 'INFECTED WIN');
        setTimeout(resetGame, 5000);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});