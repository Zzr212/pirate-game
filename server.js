const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    pingInterval: 2000,
    pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, 'dist')));

// --- GAME CONFIGURATION ---
const CONFIG = {
    TASKS_TO_WIN: 10,
    INFECTED_DMG: 34,    // 3 hits to kill
    SKELETON_DMG: 20,    // 5 hits to kill
    MATCH_START_TIME: 10, // Seconds (shortened for testing)
    MIN_PLAYERS: 2
};

// --- STATE ---
let players = {};
let gameState = 'LOBBY'; // LOBBY, PREGAME, PLAYING, END
let tasksCompleted = 0;
let matchTimer = null;

io.on('connection', (socket) => {
    console.log(`[+] Player connected: ${socket.id}`);

    // Init Player Data
    players[socket.id] = {
        id: socket.id,
        x: 0, y: 10, z: 0, // Spawn high to avoid floor clipping initially
        rotation: 0,
        role: gameState === 'LOBBY' ? 'LOBBY' : 'SPECTATOR',
        isReady: false,
        hp: 100,
        maxHp: 100,
        dead: false,
        anim: 'Idle',
        username: `Pirate#${socket.id.substr(0,4)}`
    };

    // Force spectator if joining mid-game
    if (gameState === 'PLAYING' || gameState === 'PREGAME') {
        players[socket.id].role = 'SPECTATOR';
        players[socket.id].dead = true;
        socket.emit('gameState', gameState);
        socket.emit('forceSpectate');
    }

    io.emit('updatePlayers', players);
    io.emit('lobbyStatus', getLobbyInfo());

    // --- EVENTS ---

    socket.on('playerReady', () => {
        if (gameState !== 'LOBBY') return;
        if (players[socket.id]) {
            players[socket.id].isReady = !players[socket.id].isReady;
            io.emit('updatePlayers', players);
            checkLobbyStart();
        }
    });

    socket.on('updateMove', (data) => {
        const p = players[socket.id];
        if (!p || p.dead) return;
        
        // Basic validation could go here
        p.x = data.x;
        p.y = data.y;
        p.z = data.z;
        p.rotation = data.rotation;
        p.anim = data.anim;

        // Broadcast raw data (Client will interpolate)
        socket.broadcast.emit('playerMoved', { 
            id: socket.id, 
            ...data 
        });
    });

    socket.on('attackHit', (targetId) => {
        if (gameState !== 'PLAYING') return;
        
        const attacker = players[socket.id];
        const victim = players[targetId];

        if (!attacker || !victim || attacker.dead || victim.dead) return;

        // Calculate Damage
        let damage = 0;
        if (attacker.role === 'CAPTAIN') damage = CONFIG.INFECTED_DMG;
        else if (attacker.role === 'SKELETON') damage = CONFIG.SKELETON_DMG;
        else return; // Crew cannot deal damage yet

        victim.hp -= damage;
        io.to(victim.id).emit('hurt', victim.hp); // Visual feedback for victim
        io.emit('playerHpUpdate', { id: victim.id, hp: victim.hp });

        // Death Logic
        if (victim.hp <= 0) {
            victim.hp = 0;
            if (attacker.role === 'CAPTAIN' && victim.role === 'CREW') {
                // Infection
                victim.role = 'SKELETON';
                victim.hp = 100;
                victim.dead = false; // Undead
                io.emit('chatMessage', { user: 'GAME', text: `${victim.username} rose as a Skeleton!` });
            } else {
                // Death
                victim.dead = true;
                victim.role = 'SPECTATOR';
                io.emit('playerDied', victim.id);
            }
            io.emit('updatePlayers', players); // Full sync on role change
            checkWinCondition();
        }
    });

    socket.on('completeTask', () => {
        if (gameState !== 'PLAYING') return;
        tasksCompleted++;
        io.emit('taskUpdate', { current: tasksCompleted, total: CONFIG.TASKS_TO_WIN });
        
        if (tasksCompleted >= CONFIG.TASKS_TO_WIN) {
            endGame('CREW ESCAPED!');
        }
    });

    socket.on('disconnect', () => {
        console.log(`[-] Player disconnected: ${socket.id}`);
        delete players[socket.id];
        io.emit('updatePlayers', players);
        checkWinCondition(); // Check if last crew left
    });
});

// --- GAME LOOP LOGIC ---

function checkLobbyStart() {
    const ids = Object.keys(players);
    const readyCount = ids.filter(id => players[id].isReady).length;
    
    // Logic: If >2 players and ALL ready -> Start
    if (ids.length >= CONFIG.MIN_PLAYERS && readyCount === ids.length) {
        startCountdown();
    }
}

function startCountdown() {
    if (gameState !== 'LOBBY') return;
    gameState = 'PREGAME';
    io.emit('gameState', 'PREGAME');
    
    let count = 5;
    const interval = setInterval(() => {
        io.emit('timer', count);
        count--;
        if (count < 0) {
            clearInterval(interval);
            startGame();
        }
    }, 1000);
}

function startGame() {
    gameState = 'PLAYING';
    tasksCompleted = 0;
    
    // Assign Roles
    const ids = Object.keys(players);
    const captainIndex = Math.floor(Math.random() * ids.length);
    
    ids.forEach((id, idx) => {
        const p = players[id];
        p.isReady = false;
        p.dead = false;
        p.hp = 100;
        p.role = (idx === captainIndex) ? 'CAPTAIN' : 'CREW';
        
        // Random Spawn Position circle
        const angle = (idx / ids.length) * Math.PI * 2;
        p.x = Math.cos(angle) * 5;
        p.z = Math.sin(angle) * 5;
    });

    io.emit('gameState', 'PLAYING');
    io.emit('updatePlayers', players);
    io.emit('chatMessage', { user: 'GAME', text: 'Find tasks! The Captain is among you...' });
}

function checkWinCondition() {
    if (gameState !== 'PLAYING') return;
    const ids = Object.keys(players);
    const crewAlive = ids.filter(id => players[id].role === 'CREW' && !players[id].dead).length;
    const infectedAlive = ids.filter(id => (players[id].role === 'CAPTAIN' || players[id].role === 'SKELETON') && !players[id].dead).length;

    if (crewAlive === 0) endGame('THE CURSE CONSUMED ALL!');
    // Infected win condition is implicit (kill all crew)
}

function endGame(reason) {
    gameState = 'END';
    io.emit('gameOver', reason);
    setTimeout(resetGame, 8000);
}

function resetGame() {
    gameState = 'LOBBY';
    tasksCompleted = 0;
    Object.values(players).forEach(p => {
        p.role = 'LOBBY';
        p.isReady = false;
        p.hp = 100;
        p.dead = false;
    });
    io.emit('gameState', 'LOBBY');
    io.emit('updatePlayers', players);
}

function getLobbyInfo() {
    return { players: Object.keys(players).length };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});