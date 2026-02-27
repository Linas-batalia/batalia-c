/**
 * Batalia Multiplayer Server
 * Simple room-based multiplayer using Socket.io
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

// Store active rooms
const rooms = new Map();

// Generate a random 4-character room code
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars (0,O,1,I)
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    // Make sure code doesn't already exist
    if (rooms.has(code)) {
        return generateRoomCode();
    }
    return code;
}

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Create a new room
    socket.on('create-room', (playerName, callback) => {
        const roomCode = generateRoomCode();

        rooms.set(roomCode, {
            code: roomCode,
            host: {
                id: socket.id,
                name: playerName || 'Player 1',
                color: 'green',
                ready: false
            },
            guest: null,
            gameStarted: false,
            currentTurn: 'green',
            turnNumber: 1,
            gameState: null
        });

        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.playerColor = 'green';

        console.log(`Room ${roomCode} created by ${playerName}`);

        callback({
            success: true,
            roomCode: roomCode,
            playerColor: 'green'
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
            ready: false
        };

        socket.join(roomCode.toUpperCase());
        socket.roomCode = roomCode.toUpperCase();
        socket.playerColor = 'red';

        console.log(`${playerName} joined room ${roomCode}`);

        // Notify host that someone joined
        socket.to(roomCode.toUpperCase()).emit('player-joined', {
            playerName: room.guest.name,
            playerColor: 'red'
        });

        callback({
            success: true,
            roomCode: roomCode.toUpperCase(),
            playerColor: 'red',
            hostName: room.host.name
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

        // Check if both players are ready
        if (room.host.ready && room.guest && room.guest.ready) {
            room.gameStarted = true;
            io.to(socket.roomCode).emit('game-start', {
                hostName: room.host.name,
                guestName: room.guest.name,
                firstTurn: 'green'
            });
            console.log(`Game started in room ${socket.roomCode}`);
        } else {
            // Notify other player
            socket.to(socket.roomCode).emit('opponent-ready');
        }

        if (callback) callback({ success: true });
    });

    // Relay game actions to opponent
    socket.on('game-action', (action) => {
        const room = rooms.get(socket.roomCode);
        if (!room || !room.gameStarted) return;

        // Only allow actions from the player whose turn it is
        if (socket.playerColor !== room.currentTurn) {
            console.log(`Rejected action from ${socket.playerColor} - not their turn`);
            return;
        }

        console.log(`Action in room ${socket.roomCode}:`, action.type);

        // Relay action to opponent
        socket.to(socket.roomCode).emit('opponent-action', action);
    });

    // End turn
    socket.on('end-turn', () => {
        const room = rooms.get(socket.roomCode);
        if (!room || !room.gameStarted) return;

        if (socket.playerColor !== room.currentTurn) return;

        // Switch turn
        room.currentTurn = room.currentTurn === 'green' ? 'red' : 'green';
        if (room.currentTurn === 'green') {
            room.turnNumber++;
        }

        console.log(`Turn ended in room ${socket.roomCode}. Now: ${room.currentTurn}, Turn #${room.turnNumber}`);

        io.to(socket.roomCode).emit('turn-changed', {
            currentTurn: room.currentTurn,
            turnNumber: room.turnNumber
        });
    });

    // Sync game state (for reconnection or validation)
    socket.on('sync-state', (gameState) => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;

        room.gameState = gameState;
        socket.to(socket.roomCode).emit('state-sync', gameState);
    });

    // Game over
    socket.on('game-over', (data) => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;

        io.to(socket.roomCode).emit('game-ended', data);

        // Clean up room after a delay
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

        // Notify other player
        socket.to(roomCode).emit('opponent-disconnected', {
            playerColor: socket.playerColor
        });

        // If game hasn't started, clean up the room
        if (!room.gameStarted) {
            if (socket.playerColor === 'green') {
                // Host left, destroy room
                rooms.delete(roomCode);
                console.log(`Room ${roomCode} destroyed (host left)`);
            } else {
                // Guest left, just remove them
                room.guest = null;
            }
        } else {
            // Game in progress - keep room for potential reconnection
            // Mark player as disconnected
            if (socket.playerColor === 'green') {
                room.host.connected = false;
            } else if (room.guest) {
                room.guest.connected = false;
            }

            // Clean up after 60 seconds if not reconnected
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
            currentTurn: room.currentTurn
        });
    });
    res.json(roomList);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Batalia server running on port ${PORT}`);
});
