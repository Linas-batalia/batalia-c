/**
 * Batalia Multiplayer Server
 * Centralized state management - active player is the source of truth
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

// Serve static files from client folder
app.use(express.static(path.join(__dirname, 'client')));

// Trust proxy for Railway/Render
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// Store active rooms with authoritative game state
const rooms = new Map();

// Generate a random 4-character room code
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    if (rooms.has(code)) {
        return generateRoomCode();
    }
    return code;
}

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Create a new room
    socket.on('create-room', (data, callback) => {
        // Support both old format (string) and new format (object with gameVersion)
        const playerName = typeof data === 'string' ? data : (data.playerName || 'Player 1');
        const gameVersion = typeof data === 'object' ? (data.gameVersion || 'classic') : 'classic';

        const roomCode = generateRoomCode();

        rooms.set(roomCode, {
            code: roomCode,
            host: {
                id: socket.id,
                name: playerName,
                color: 'green',
                ready: false,
                connected: true
            },
            guest: null,
            gameStarted: false,
            gameVersion: gameVersion, // Store game version selected by host
            currentTurn: 'green',
            turnNumber: 1,
            // Authoritative game state - single source of truth
            gameState: null,
            stateVersion: 0
        });

        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.playerColor = 'green';

        console.log(`Room ${roomCode} created by ${playerName} (${gameVersion} mode)`);

        callback({
            success: true,
            roomCode: roomCode,
            playerColor: 'green',
            gameVersion: gameVersion
        });
    });

    // Join an existing room
    socket.on('join-room', (data, callback) => {
        const { roomCode, playerName } = data;
        const room = rooms.get(roomCode.toUpperCase());

        if (!room) {
            callback({ success: false, error: 'Room not found' });
            return;
        }

        if (room.guest) {
            callback({ success: false, error: 'Room is full' });
            return;
        }

        if (room.gameStarted) {
            callback({ success: false, error: 'Game already in progress' });
            return;
        }

        room.guest = {
            id: socket.id,
            name: playerName || 'Player 2',
            color: 'red',
            ready: false,
            connected: true
        };

        socket.join(roomCode.toUpperCase());
        socket.roomCode = roomCode.toUpperCase();
        socket.playerColor = 'red';

        console.log(`${playerName} joined room ${roomCode}`);

        socket.to(roomCode.toUpperCase()).emit('player-joined', {
            playerName: room.guest.name,
            playerColor: 'red'
        });

        callback({
            success: true,
            roomCode: roomCode.toUpperCase(),
            playerColor: 'red',
            hostName: room.host.name,
            gameVersion: room.gameVersion || 'classic'
        });
    });

    // Player ready to start
    socket.on('player-ready', (callback) => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;

        if (socket.playerColor === 'green') {
            room.host.ready = true;
        } else {
            room.guest.ready = true;
        }

        if (room.host.ready && room.guest && room.guest.ready) {
            room.gameStarted = true;
            room.stateVersion = 0;
            io.to(socket.roomCode).emit('game-start', {
                hostName: room.host.name,
                guestName: room.guest.name,
                firstTurn: 'green',
                gameVersion: room.gameVersion || 'classic'
            });
            console.log(`Game started in room ${socket.roomCode} (${room.gameVersion} mode)`);
        } else {
            socket.to(socket.roomCode).emit('opponent-ready');
        }

        if (callback) callback({ success: true });
    });

    // Receive and store authoritative state from active player
    socket.on('update-state', (gameState) => {
        const room = rooms.get(socket.roomCode);
        if (!room || !room.gameStarted) return;

        // Only accept state updates from the active player
        if (socket.playerColor !== room.currentTurn) {
            console.log(`Rejected state update from ${socket.playerColor} - not their turn`);
            return;
        }

        // Update authoritative state
        room.stateVersion++;
        room.gameState = {
            ...gameState,
            version: room.stateVersion,
            timestamp: Date.now(),
            source: socket.playerColor
        };

        console.log(`State updated in room ${socket.roomCode} v${room.stateVersion} by ${socket.playerColor}`);

        // Broadcast to opponent
        socket.to(socket.roomCode).emit('state-update', room.gameState);
    });

    // Relay game actions to opponent (for animations)
    socket.on('game-action', (action) => {
        const room = rooms.get(socket.roomCode);
        if (!room || !room.gameStarted) return;

        if (socket.playerColor !== room.currentTurn) {
            console.log(`Rejected action from ${socket.playerColor} - not their turn`);
            return;
        }

        console.log(`Action in room ${socket.roomCode}:`, action.type);

        // Relay action to opponent for animation
        socket.to(socket.roomCode).emit('opponent-action', action);
    });

    // End turn - switch control and sync state
    socket.on('end-turn', (finalState) => {
        const room = rooms.get(socket.roomCode);
        if (!room || !room.gameStarted) return;

        if (socket.playerColor !== room.currentTurn) return;

        // Store final state from ending player
        if (finalState) {
            room.stateVersion++;
            room.gameState = {
                ...finalState,
                version: room.stateVersion,
                timestamp: Date.now(),
                source: socket.playerColor
            };
        }

        // Switch turn
        const previousTurn = room.currentTurn;
        room.currentTurn = room.currentTurn === 'green' ? 'red' : 'green';
        if (room.currentTurn === 'green') {
            room.turnNumber++;
        }

        console.log(`Turn ended in room ${socket.roomCode}. ${previousTurn} -> ${room.currentTurn}, Turn #${room.turnNumber}`);

        // Send turn change with authoritative state
        io.to(socket.roomCode).emit('turn-changed', {
            currentTurn: room.currentTurn,
            turnNumber: room.turnNumber,
            gameState: room.gameState,
            stateVersion: room.stateVersion
        });
    });

    // Request current authoritative state (for resync)
    socket.on('request-state', (callback) => {
        const room = rooms.get(socket.roomCode);
        if (!room || !room.gameState) {
            if (callback) callback({ success: false, error: 'No state available' });
            return;
        }

        console.log(`State requested by ${socket.playerColor} in room ${socket.roomCode}`);

        if (callback) {
            callback({
                success: true,
                gameState: room.gameState,
                currentTurn: room.currentTurn,
                turnNumber: room.turnNumber,
                stateVersion: room.stateVersion
            });
        }
    });

    // Game over
    socket.on('game-over', (data) => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;

        io.to(socket.roomCode).emit('game-ended', data);

        setTimeout(() => {
            rooms.delete(socket.roomCode);
            console.log(`Room ${socket.roomCode} closed`);
        }, 5000);
    });

    // Chat message
    socket.on('chat-message', (message) => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;

        const playerName = socket.playerColor === 'green' ? room.host.name : room.guest?.name;

        io.to(socket.roomCode).emit('chat-message', {
            sender: playerName,
            color: socket.playerColor,
            message: message,
            timestamp: Date.now()
        });
    });

    // Leave room
    socket.on('leave-room', () => {
        handleDisconnect(socket);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        handleDisconnect(socket);
    });

    function handleDisconnect(socket) {
        const roomCode = socket.roomCode;
        if (!roomCode) return;

        const room = rooms.get(roomCode);
        if (!room) return;

        console.log(`Player ${socket.playerColor} disconnected from room ${roomCode}`);

        socket.to(roomCode).emit('opponent-disconnected', {
            playerColor: socket.playerColor
        });

        if (!room.gameStarted) {
            if (socket.playerColor === 'green') {
                rooms.delete(roomCode);
                console.log(`Room ${roomCode} destroyed (host left)`);
            } else {
                room.guest = null;
            }
        } else {
            if (socket.playerColor === 'green') {
                room.host.connected = false;
            } else if (room.guest) {
                room.guest.connected = false;
            }

            setTimeout(() => {
                const currentRoom = rooms.get(roomCode);
                if (currentRoom) {
                    const hostConnected = currentRoom.host.connected !== false;
                    const guestConnected = currentRoom.guest?.connected !== false;
                    if (!hostConnected || !guestConnected) {
                        rooms.delete(roomCode);
                        console.log(`Room ${roomCode} cleaned up after disconnect timeout`);
                    }
                }
            }, 60000);
        }
    }
});

// Serve game.html on root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'client', 'game.html'));
});

// Health check endpoint
app.get('/status', (req, res) => {
    res.json({
        status: 'Batalia server running',
        rooms: rooms.size,
        uptime: process.uptime()
    });
});

// List active rooms (for debugging)
app.get('/rooms', (req, res) => {
    const roomList = [];
    rooms.forEach((room, code) => {
        roomList.push({
            code: code,
            host: room.host.name,
            guest: room.guest?.name || null,
            gameStarted: room.gameStarted,
            currentTurn: room.currentTurn,
            stateVersion: room.stateVersion
        });
    });
    res.json(roomList);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Batalia server running on port ${PORT}`);
});
