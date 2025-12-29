const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'dist')));

// --- DEFAULT MAP CONFIG (Fallback ako nema map buildera) ---
let MAP_CONFIG = {
    spawns: [{x:0, y:2, z:0}, {x:5, y:2, z:0}, {x:-5, y:2, z:0}],
    tasks: [
        {id: 't1', type: 'wires', x: 10, y: 1, z: 10},
        {id: 't2', type: 'debris', x: -10, y: 1, z: -10},
        {id: 't3', type: 'wheel', x: 15, y: 1, z: -5},
        {id: 't4', type: 'cannons', x: -15, y: 1, z: 5}
    ],
    portal: {x: 0, y: 2, z: 20}
};

const GAME_STATE = {
    LOBBY: 0,
    GRACE: 1,      // 60s trcanja prije infekcije
    PLAYING: 2,    // Infekcija aktivna, rjesavanje taskova
    ENDED: 3
};

const STATE = {
    status: GAME_STATE.LOBBY,
    players: {},
    timer: 0,
    tasksCompleted: 0,
    tasksRequired: 0,
    portalOpen: false,
    mapConfig: MAP_CONFIG
};

const CONFIG = {
    graceTime: 60, // 60 sekundi prije infekcije
    minPlayers: 2, // Smanjeno za testiranje, stavi 10 kasnije
    autoStartTime: 60
};

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('joinLobby', (data) => {
        STATE.players[socket.id] = {
            id: socket.id,
            name: data.name,
            charModel: data.model || 'pirate_1',
            role: 'survivor', // survivor, captain, skeleton, spectator
            isReady: false,
            x: 0, y: 0, z: 0, rot: 0, anim: 'Idle',
            tasks: [], // Lista ID-eva taskova za ovog igraca
            isDead: false
        };
        
        // Posalji mu stanje lobbyja
        socket.emit('lobbyUpdate', { players: STATE.players, status: STATE.status, timer: STATE.timer });
        io.emit('playerJoined', STATE.players[socket.id]);
    });

    socket.on('playerReady', () => {
        if(STATE.players[socket.id]) {
            STATE.players[socket.id].isReady = !STATE.players[socket.id].isReady;
            io.emit('lobbyUpdate', { players: STATE.players, status: STATE.status });
            checkAutoStart();
        }
    });

    socket.on('spectateSwitch', (targetId) => {
        // Logika za spectate switchanje kamere salje se samo tom klijentu
        socket.emit('spectateTarget', targetId);
    });

    socket.on('updatePos', (data) => {
        const p = STATE.players[socket.id];
        if(p && !p.isDead && STATE.status !== GAME_STATE.LOBBY) {
            p.x = data.x; p.y = data.y; p.z = data.z;
            p.rot = data.rot; p.anim = data.anim;
            socket.broadcast.volatile.emit('updatePlayer', p);
        }
    });

    socket.on('completeTask', (taskId) => {
        const p = STATE.players[socket.id];
        if(p && p.role === 'survivor' && p.tasks.includes(taskId)) {
            // Ukloni task
            p.tasks = p.tasks.filter(t => t !== taskId);
            STATE.tasksCompleted++;
            
            // Provjeri portal
            if(STATE.tasksCompleted >= STATE.tasksRequired) {
                STATE.portalOpen = true;
                io.emit('portalOpened', STATE.mapConfig.portal);
            }

            io.emit('taskUpdate', { 
                id: taskId, 
                completed: STATE.tasksCompleted, 
                required: STATE.tasksRequired,
                playerId: socket.id
            });
        }
    });

    socket.on('attackPlayer', (targetId) => {
        const attacker = STATE.players[socket.id];
        const target = STATE.players[targetId];
        
        if(!attacker || !target || STATE.status !== GAME_STATE.PLAYING) return;

        // Validacija distance (jednostavna)
        const dist = Math.sqrt((attacker.x-target.x)**2 + (attacker.z-target.z)**2);
        if(dist > 3.0) return; 

        // 1. CAPTAIN ATTACKS SURVIVOR -> BECOMES SKELETON
        if(attacker.role === 'captain' && target.role === 'survivor') {
            target.role = 'skeleton';
            // Smanji broj potrebnih taskova jer je ovaj postao zao
            recalculateTasks(); 
            io.emit('playerInfected', { id: targetId, role: 'skeleton' });
        }
        // 2. SKELETON ATTACKS SURVIVOR -> DIES (SPECTATOR)
        else if(attacker.role === 'skeleton' && target.role === 'survivor') {
            target.role = 'spectator';
            target.isDead = true;
            recalculateTasks();
            io.emit('playerDied', { id: targetId });
        }
    });

    socket.on('escape', () => {
        if(STATE.portalOpen && STATE.players[socket.id]) {
            // Igrac je pobjegao
            io.emit('playerEscaped', { id: socket.id, name: STATE.players[socket.id].name });
            STATE.players[socket.id].role = 'spectator'; // Mice se s mape
        }
    });

    // --- MAP BUILDER SUPPORT ---
    socket.on('saveMapConfig', (config) => {
        console.log("New Map Config Received!");
        MAP_CONFIG = config;
        STATE.mapConfig = config;
    });

    socket.on('disconnect', () => {
        delete STATE.players[socket.id];
        io.emit('playerLeft', socket.id);
        // Ako je kapetan otisao, igra bi trebala zavrsiti ili birati novog (pojednostavljeno: game over)
        if(STATE.status === GAME_STATE.PLAYING) {
             const activePlayers = Object.values(STATE.players).filter(p => !p.isDead);
             if(activePlayers.length < 1) endGame("Everyone Left");
        }
    });
});

function checkAutoStart() {
    const players = Object.values(STATE.players);
    const readyCount = players.filter(p => p.isReady).length;
    
    if(STATE.status === GAME_STATE.LOBBY && players.length >= 2 && readyCount === players.length) {
        startGame();
    }
}

function startGame() {
    STATE.status = GAME_STATE.GRACE;
    STATE.timer = CONFIG.graceTime;
    STATE.portalOpen = false;
    STATE.tasksCompleted = 0;

    // 1. Assign Tasks & Spawns
    const players = Object.values(STATE.players);
    const tasks = STATE.mapConfig.tasks;
    
    players.forEach((p, index) => {
        p.role = 'survivor';
        p.isDead = false;
        // Random spawn point
        const spawn = STATE.mapConfig.spawns[index % STATE.mapConfig.spawns.length];
        p.x = spawn.x; p.y = spawn.y; p.z = spawn.z;
        
        // Dodijeli 3 random taska svakom igracu
        p.tasks = [];
        for(let i=0; i<3; i++) {
            const t = tasks[Math.floor(Math.random() * tasks.length)];
            if(t) p.tasks.push(t.id);
        }
    });

    recalculateTasks();

    io.emit('gameStart', { 
        mapConfig: STATE.mapConfig,
        players: STATE.players,
        graceTime: CONFIG.graceTime
    });

    // Grace Period Loop
    let graceInt = setInterval(() => {
        STATE.timer--;
        io.emit('timerUpdate', STATE.timer);
        if(STATE.timer <= 0) {
            clearInterval(graceInt);
            startInfection();
        }
    }, 1000);
}

function startInfection() {
    STATE.status = GAME_STATE.PLAYING;
    const survivors = Object.values(STATE.players).filter(p => p.role === 'survivor');
    
    if(survivors.length > 0) {
        const captain = survivors[Math.floor(Math.random() * survivors.length)];
        captain.role = 'captain';
        // Kapetan nema taskove
        captain.tasks = [];
        recalculateTasks();
        
        io.emit('infectionStarted', { captainId: captain.id });
    } else {
        endGame("No players to infect!");
    }
}

function recalculateTasks() {
    // Ukupan broj taskova = suma svih taskova prezivjelih
    let total = 0;
    Object.values(STATE.players).forEach(p => {
        if(p.role === 'survivor') total += p.tasks.length;
    });
    // Dodamo vec zavrsene na to
    STATE.tasksRequired = total + STATE.tasksCompleted;
    
    // Ako su svi taskovi gotovi (ili nema survivor-a), otvori portal
    if(STATE.tasksRequired > 0 && STATE.tasksCompleted >= STATE.tasksRequired) {
        STATE.portalOpen = true;
        io.emit('portalOpened', STATE.mapConfig.portal);
    }
}

function endGame(reason) {
    STATE.status = GAME_STATE.ENDED;
    io.emit('gameEnded', { reason });
    setTimeout(() => {
        STATE.status = GAME_STATE.LOBBY;
        Object.values(STATE.players).forEach(p => {
            p.role = 'survivor';
            p.isReady = false;
            p.isDead = false;
        });
        io.emit('lobbyUpdate', { players: STATE.players, status: STATE.status });
    }, 5000);
}

server.listen(3000, () => {
    console.log('Cursed Gold Server running on port 3000');
});