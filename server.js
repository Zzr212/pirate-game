const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'dist')));

// CONFIG
const CONFIG = {
    graceTime: 60,       // 60 sekundi prije infekcije
    gameDuration: 600,   // 10 minuta za Survivor pobjedu
    minPlayers: 2        // Minimum za start
};

const GAME_STATE = { LOBBY: 0, GRACE: 1, PLAYING: 2, ENDED: 3 };

const STATE = {
    status: GAME_STATE.LOBBY,
    players: {},
    timer: 0,
    tasksCompleted: 0,
    tasksRequired: 0,
    portalOpen: false,
    mapConfig: { // Default map config
        spawns: [{x:0, y:5, z:0}, {x:5, y:5, z:5}, {x:-5, y:5, z:-5}, {x:5, y:5, z:-5}, {x:-5, y:5, z:5}],
        tasks: [],
        portal: {x: 0, y: 2, z: 20}
    }
};

let gameInterval = null;

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('joinLobby', (data) => {
        // Ako je igra vec u toku, baci ga u spectator mode
        if (STATE.status !== GAME_STATE.LOBBY) {
            STATE.players[socket.id] = createPlayer(socket.id, data.name, 'spectator');
            socket.emit('gameStart', { 
                mapConfig: STATE.mapConfig, 
                players: STATE.players, 
                timeLeft: STATE.timer,
                status: STATE.status
            });
            return;
        }

        // Inace, normalan join
        STATE.players[socket.id] = createPlayer(socket.id, data.name, 'survivor');
        
        // Update svima
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

        // Captain infects Survivor
        if(attacker.role === 'captain' && target.role === 'survivor') {
            target.role = 'skeleton';
            io.emit('playerInfected', { id: targetId });
            checkWinCondition();
        }
        // Skeleton kills Survivor
        else if(attacker.role === 'skeleton' && target.role === 'survivor') {
            target.role = 'spectator';
            io.emit('playerDied', { id: targetId });
            checkWinCondition();
        }
    });

    socket.on('escape', () => {
        if(STATE.portalOpen) {
            io.emit('gameOver', { winner: 'SURVIVORS', reason: `${STATE.players[socket.id].name} escaped!` });
            resetGame();
        }
    });

    socket.on('saveMapConfig', (cfg) => { STATE.mapConfig = cfg; });

    socket.on('disconnect', () => {
        delete STATE.players[socket.id];
        io.emit('playerLeft', socket.id);
        io.emit('lobbyUpdate', { players: STATE.players, status: STATE.status });
        if(STATE.status !== GAME_STATE.LOBBY) checkWinCondition();
    });
});

function createPlayer(id, name, role) {
    return {
        id, name, role, isReady: false,
        x: 0, y: 10, z: 0, rot: 0, anim: 'Idle'
    };
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
    STATE.tasksRequired = Object.keys(STATE.players).length * 2; // 2 taska po igracu
    STATE.portalOpen = false;

    // Assign Spawns
    const pArray = Object.values(STATE.players);
    pArray.forEach((p, i) => {
        const spawn = STATE.mapConfig.spawns[i % STATE.mapConfig.spawns.length];
        p.x = spawn.x; p.y = spawn.y + 2; p.z = spawn.z; // Malo u zraku da ne propadnu
        p.role = 'survivor';
    });

    io.emit('gameStart', { 
        mapConfig: STATE.mapConfig, 
        players: STATE.players,
        status: STATE.status,
        timeLeft: STATE.timer
    });

    // Start Timer Loop
    if(gameInterval) clearInterval(gameInterval);
    gameInterval = setInterval(gameLoop, 1000);
}

function gameLoop() {
    STATE.timer--;
    io.emit('timerUpdate', STATE.timer);

    if (STATE.status === GAME_STATE.GRACE) {
        if (STATE.timer <= 0) {
            startInfection();
        }
    } else if (STATE.status === GAME_STATE.PLAYING) {
        if (STATE.timer <= 0) {
            // Time is up, Pirates win!
            io.emit('gameOver', { winner: 'INFECTED', reason: "Time ran out!" });
            resetGame();
        }
    }
}

function startInfection() {
    STATE.status = GAME_STATE.PLAYING;
    STATE.timer = CONFIG.gameDuration; // 10 minuta
    
    const survivors = Object.values(STATE.players).filter(p => p.role === 'survivor');
    if(survivors.length > 0) {
        const captain = survivors[Math.floor(Math.random() * survivors.length)];
        captain.role = 'captain';
        io.emit('infectionStarted', { captainId: captain.id, timeLeft: STATE.timer });
    } else {
        resetGame();
    }
}

function checkWinCondition() {
    const survivors = Object.values(STATE.players).filter(p => p.role === 'survivor');
    if(survivors.length === 0) {
        io.emit('gameOver', { winner: 'INFECTED', reason: "No survivors left!" });
        resetGame();
    }
}

function resetGame() {
    clearInterval(gameInterval);
    STATE.status = GAME_STATE.ENDED;
    setTimeout(() => {
        STATE.status = GAME_STATE.LOBBY;
        Object.values(STATE.players).forEach(p => {
            p.isReady = false;
            p.role = 'survivor';
        });
        io.emit('lobbyUpdate', { players: STATE.players, status: STATE.status });
    }, 5000);
}

server.listen(3000, () => {
    console.log('Server running on 3000');
});