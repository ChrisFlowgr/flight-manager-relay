const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store active rooms: { roomCode: { pc: WebSocket, mobile: WebSocket, reconnectionToken: string, createdAt: Date } }
const rooms = new Map();

// Store reconnection tokens: { token: roomCode }
const reconnectionTokens = new Map();

// Generate random 6-character room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluding similar chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Generate reconnection token (longer, more secure)
function generateReconnectionToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  let currentRoom = null;
  let deviceType = null; // 'pc' or 'mobile'

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Handle PC server registration
      if (data.type === 'register_pc') {
        let roomCode;
        let reconnectionToken;
        let isReconnection = false;

        // Check if PC is attempting reconnection with existing token
        if (data.reconnectionToken && data.requestedRoomCode) {
          const storedRoomCode = reconnectionTokens.get(data.reconnectionToken);

          // If token is valid and room still exists, reuse it
          if (storedRoomCode === data.requestedRoomCode && rooms.has(storedRoomCode)) {
            const existingRoom = rooms.get(storedRoomCode);

            // Cancel cleanup timeout if reconnecting
            if (existingRoom.cleanupTimeout) {
              clearTimeout(existingRoom.cleanupTimeout);
              delete existingRoom.cleanupTimeout;
            }

            // Close old PC connection if exists
            if (existingRoom.pc && existingRoom.pc.readyState === WebSocket.OPEN) {
              try {
                existingRoom.pc.close();
              } catch (e) {
                console.error('Error closing old PC connection:', e);
              }
            }

            // Reuse the room and token
            roomCode = storedRoomCode;
            reconnectionToken = data.reconnectionToken;
            existingRoom.pc = ws;
            isReconnection = true;

            console.log(`PC reconnected with existing room code: ${roomCode}`);
          }
        }

        // If not reconnection, create new room
        if (!roomCode) {
          roomCode = generateRoomCode();
          reconnectionToken = generateReconnectionToken();

          rooms.set(roomCode, {
            pc: ws,
            mobile: null,
            reconnectionToken: reconnectionToken,
            createdAt: new Date()
          });

          reconnectionTokens.set(reconnectionToken, roomCode);

          console.log(`PC registered with new room code: ${roomCode}`);
        }

        currentRoom = roomCode;
        deviceType = 'pc';

        ws.send(JSON.stringify({
          type: 'registered',
          roomCode: roomCode,
          reconnectionToken: reconnectionToken,
          isReconnection: isReconnection,
          message: `PC registered with code: ${roomCode}`
        }));
      }

      // Handle mobile app connection
      else if (data.type === 'join_room') {
        const roomCode = data.roomCode.toUpperCase();

        if (!rooms.has(roomCode)) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Invalid room code'
          }));
          return;
        }

        const room = rooms.get(roomCode);

        // If there's already a mobile connection, close it first (reconnection)
        if (room.mobile) {
          console.log(`Replacing existing mobile connection in room ${roomCode}`);
          try {
            if (room.mobile.readyState === WebSocket.OPEN) {
              room.mobile.close();
            }
          } catch (e) {
            console.error('Error closing old mobile connection:', e);
          }
          room.mobile = null;
        }

        currentRoom = roomCode;
        deviceType = 'mobile';
        room.mobile = ws;

        // Notify both devices
        ws.send(JSON.stringify({
          type: 'connected',
          message: 'Connected to PC successfully'
        }));

        if (room.pc && room.pc.readyState === WebSocket.OPEN) {
          room.pc.send(JSON.stringify({
            type: 'mobile_connected',
            message: 'Mobile device connected'
          }));
        }

        console.log(`Mobile joined room: ${roomCode}`);
      }

      // Relay messages between PC and mobile
      else if (data.type === 'relay') {
        if (!currentRoom || !rooms.has(currentRoom)) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Not in a room'
          }));
          return;
        }

        const room = rooms.get(currentRoom);

        // If message from PC, send to mobile
        if (deviceType === 'pc' && room.mobile && room.mobile.readyState === WebSocket.OPEN) {
          room.mobile.send(JSON.stringify({
            type: 'data',
            payload: data.payload
          }));
        }
        // If message from mobile, send to PC
        else if (deviceType === 'mobile' && room.pc && room.pc.readyState === WebSocket.OPEN) {
          room.pc.send(JSON.stringify({
            type: 'data',
            payload: data.payload
          }));
        }
      }

    } catch (error) {
      console.error('Error processing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }));
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');

    // Clean up room when device disconnects
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);

      if (deviceType === 'pc') {
        // Notify mobile that PC disconnected
        if (room.mobile && room.mobile.readyState === WebSocket.OPEN) {
          room.mobile.send(JSON.stringify({
            type: 'pc_disconnected',
            message: 'PC disconnected'
          }));
        }

        // Keep room and token for 1 hour to allow reconnection
        // Set a timeout to cleanup later
        const cleanupTimeout = setTimeout(() => {
          if (rooms.has(currentRoom)) {
            const room = rooms.get(currentRoom);

            // Remove reconnection token
            if (room.reconnectionToken) {
              reconnectionTokens.delete(room.reconnectionToken);
            }

            // Remove the room
            rooms.delete(currentRoom);
            console.log(`Room ${currentRoom} cleaned up after timeout`);
          }
        }, 3600000); // 1 hour

        // Store cleanup timeout in room for potential cancellation
        room.cleanupTimeout = cleanupTimeout;

        console.log(`PC disconnected from room ${currentRoom} (room kept for reconnection)`);
      } else if (deviceType === 'mobile') {
        // Just remove mobile from room
        room.mobile = null;
        // Notify PC that mobile disconnected
        if (room.pc && room.pc.readyState === WebSocket.OPEN) {
          room.pc.send(JSON.stringify({
            type: 'mobile_disconnected',
            message: 'Mobile disconnected'
          }));
        }
        console.log(`Mobile left room ${currentRoom}`);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeRooms: rooms.size,
    uptime: process.uptime()
  });
});

// Get room status (for debugging)
app.get('/rooms', (req, res) => {
  const roomList = [];
  rooms.forEach((room, code) => {
    roomList.push({
      code,
      hasPc: room.pc !== null,
      hasMobile: room.mobile !== null
    });
  });
  res.json({ rooms: roomList });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║     FLIGHT MANAGER RELAY SERVER                        ║
╚════════════════════════════════════════════════════════╝

Server running on port ${PORT}
WebSocket endpoint: ws://localhost:${PORT}
Health check: http://localhost:${PORT}/health

Ready to relay connections between PCs and mobile devices!
  `);
});
