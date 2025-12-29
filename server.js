const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- SERVIRANJE FAJLOVA (RENDER FIX) ---
// 1. Serviraj static fajlove iz roota (za public folder)
app.use(express.static(path.join(__dirname, 'public')));
// 2. Serviraj dist ako postoji
app.use(express.static(path.join(__dirname, 'dist')));
// 3. Eksplicitno serviraj assets
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));

const CONFIG = {
    graceTime: 60,
    gameDuration: 600,
    minPlayers: 2
};

const GAME_STATE = { LOBBY: 0, GRACE: 1, PLAYING: 2, ENDED: 3 };

const STATE = {
    status: GAME_STATE.LOBBY,
    players: {},
    timer: 0,
    tasksCompleted: 0,
    tasksRequired: 0,
    portalOpen: false,
    mapConfig: { 
        spawns: [{x:0, y:5, z:0}, {x:5, y:5, z:5}, {x:-5, y:5, z:-5}],
        tasks: [],
        portal: {x: 0, y: 2, z: 20}
    }
};

let gameInterval = null;

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('joinLobby', (data) => {
        // Late joiner = Spectator
        if (STATE.status !== GAME_STATE.LOBBY) {
            STATE.players[socket.id] = createPlayer(socket.id, data.name, 'spectator');
            socket.emit('gameStart', { 
                mapConfig: STATE.mapConfig, 
                players: STATE.players, 
                timeLeft: STATE.timer,
                status: STATE.status,
                isSpectator: true
            });
            return;
        }

        STATE.players[socket.id] = createPlayer(socket.id, data.name, 'survivor');
        io.emit('lobbyUpdate', { players: STATE.players, status: STATE.status });
    });

    socket.on('playerReady', () => {
        if(STATE.players[socket.id]) {
            STATE.players[socket.id].isReady = !STATE.players[socket.id].isReady;
            io.emit('lobbyUpdate', { players: STATE.players, status: STATE.status });
            checkAutoStart();
        }
    });

    socket.on('updatePos', (data) => {
        const p = STATE.players[socket.id];
        if(p && p.role !== 'spectator') {
            p.x = data.x; p.y = data.y; p.z = data.z;
            p.rot = data.rot; p.anim = data.anim;
            socket.broadcast.volatile.emit('updatePlayer', p);
        }
    });

    socket.on('completeTask', () => {
        STATE.tasksCompleted++;
        io.emit('taskUpdate', { completed: STATE.tasksCompleted, required: STATE.tasksRequired });
        if(STATE.tasksCompleted >= STATE.tasksRequired && STATE.tasksRequired > 0) {
            STATE.portalOpen = true;
            io.emit('portalOpened', STATE.mapConfig.portal);
        }
    });

    socket.on('attackPlayer', (targetId) => {
        const attacker = STATE.players[socket.id];
        const target = STATE.players[targetId];
        
        if(!attacker || !target || STATE.status !== GAME_STATE.PLAYING) return;

        if(attacker.role === 'captain' && target.role === 'survivor') {
            target.role = 'skeleton';
            io.emit('playerInfected', { id: targetId, role: 'skeleton' });
            checkWinCondition();
        }
        else if(attacker.role === 'skeleton' && target.role === 'survivor') {
            target.role = 'skeleton';
            io.emit('playerInfected', { id: targetId, role: 'skeleton' });
            checkWinCondition();
        }
    });

    socket.on('escape', () => {
        if(STATE.portalOpen && STATE.players[socket.id]) {
            io.emit('gameOver', { winner: 'SURVIVORS', reason: `${STATE.players[socket.id].name} escaped!` });
            resetGame();
        }
    });

    socket.on('saveMapConfig', (cfg) => { 
        STATE.mapConfig = cfg; 
        console.log("Map config saved");
    });

    socket.on('disconnect', () => {
        const p = STATE.players[socket.id];
        if (p) {
            const wasCaptain = (p.role === 'captain');
            delete STATE.players[socket.id];
            io.emit('playerLeft', socket.id);
            io.emit('lobbyUpdate', { players: STATE.players, status: STATE.status });
            
            if (STATE.status === GAME_STATE.PLAYING) {
                if (wasCaptain) {
                    io.emit('gameOver', { winner: 'SURVIVORS', reason: "The Captain fled!" });
                    resetGame();
                } else {
                    checkWinCondition();
                }
            }
        }
    });
});

function createPlayer(id, name, role) {
    return { id, name, role, isReady: false, x: 0, y: 10, z: 0, rot: 0, anim: 'Idle' };
}

function checkAutoStart() {
    const players = Object.values(STATE.players);
    const readyCount = players.filter(p => p.isReady).length;
    if(players.length >= CONFIG.minPlayers && readyCount === players.length) {
        startGame();
    }
}

function startGame() {
    STATE.status = GAME_STATE.GRACE;
    STATE.timer = CONFIG.graceTime;
    STATE.tasksCompleted = 0;
    STATE.tasksRequired = Object.keys(STATE.players).length * 2; 
    STATE.portalOpen = false;

    const pArray = Object.values(STATE.players);
    pArray.forEach((p, i) => {
        const spawn = STATE.mapConfig.spawns[i % STATE.mapConfig.spawns.length] || {x:0, y:5, z:0};
        p.x = spawn.x; p.y = spawn.y + 2; p.z = spawn.z; 
        p.role = 'survivor';
    });

    io.emit('gameStart', { 
        mapConfig: STATE.mapConfig, 
        players: STATE.players,
        status: STATE.status,
        timeLeft: STATE.timer
    });

    if(gameInterval) clearInterval(gameInterval);
    gameInterval = setInterval(gameLoop, 1000);
}

function gameLoop() {
    STATE.timer--;
    io.emit('timerUpdate', STATE.timer);

    if (STATE.status === GAME_STATE.GRACE) {
        if (STATE.timer <= 0) startInfection();
    } else if (STATE.status === GAME_STATE.PLAYING) {
        if (STATE.timer <= 0) {
            io.emit('gameOver', { winner: 'INFECTED', reason: "Time ran out!" });
            resetGame();
        }
    }
}

function startInfection() {
    STATE.status = GAME_STATE.PLAYING;
    STATE.timer = CONFIG.gameDuration; 
    const survivors = Object.values(STATE.players).filter(p => p.role === 'survivor');
    if(survivors.length > 0) {
        const captain = survivors[Math.floor(Math.random() * survivors.length)];
        captain.role = 'captain';
        io.emit('infectionStarted', { captainId: captain.id, timeLeft: STATE.timer });
    } else {
        io.emit('gameOver', { winner: 'DRAW', reason: "Not enough players." });
        resetGame();
    }
}

function checkWinCondition() {
    const survivors = Object.values(STATE.players).filter(p => p.role === 'survivor');
    if(survivors.length === 0) {
        io.emit('gameOver', { winner: 'INFECTED', reason: "All survivors infected!" });
        resetGame();
    }
}

function resetGame() {
    clearInterval(gameInterval);
    STATE.status = GAME_STATE.ENDED;
    setTimeout(() => {
        STATE.status = GAME_STATE.LOBBY;
        Object.values(STATE.players).forEach(p => { p.isReady = false; p.role = 'survivor'; });
        io.emit('lobbyUpdate', { players: STATE.players, status: STATE.status });
    }, 5000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});