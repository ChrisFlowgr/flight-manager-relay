const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const ENABLE_DEBUG_ENDPOINTS = process.env.ENABLE_RELAY_DEBUG_ENDPOINTS === 'true';
const ROOM_CLEANUP_TTL_MS = 60 * 60 * 1000;
const WS_HEARTBEAT_INTERVAL_MS = 30000;
const ROOM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const TURN_SHARED_SECRET = process.env.TURN_SHARED_SECRET || '';
const TURN_PUBLIC_HOST = process.env.TURN_PUBLIC_HOST || '';
const TURN_PORT = Number(process.env.TURN_PORT || 3478);
const TURN_TLS_PORT = Number(process.env.TURN_TLS_PORT || 5349);
const TURN_ENABLE_UDP = process.env.TURN_ENABLE_UDP !== 'false';
const TURN_ENABLE_TCP = process.env.TURN_ENABLE_TCP !== 'false';
const TURN_ENABLE_TLS = process.env.TURN_ENABLE_TLS !== 'false';
const TURN_CREDENTIAL_TTL_SECONDS = Math.max(
  60,
  Number(process.env.TURN_CREDENTIAL_TTL_SECONDS || 600),
);

// Store active rooms: { roomCode: { pc: WebSocket, mobile: WebSocket, reconnectionToken: string, createdAt: Date } }
const rooms = new Map();

// Store reconnection tokens: { token: roomCode }
const reconnectionTokens = new Map();

// Generate random 6-character room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluding similar chars
  let code = '';
  const randomBytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(randomBytes[i] % chars.length);
  }
  return code;
}

// Generate reconnection token (longer, more secure)
function generateReconnectionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateUniqueRoomCode() {
  let roomCode = generateRoomCode();

  while (rooms.has(roomCode)) {
    roomCode = generateRoomCode();
  }

  return roomCode;
}

function normalizeRequestedRoomCode(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return ROOM_CODE_PATTERN.test(normalized) ? normalized : null;
}

function toIsoString(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  return null;
}

function isTurnConfigured() {
  return Boolean(TURN_SHARED_SECRET && TURN_PUBLIC_HOST);
}

function buildTurnCredentialUrls() {
  if (!isTurnConfigured()) {
    return [];
  }

  const urls = [`stun:${TURN_PUBLIC_HOST}:${TURN_PORT}`];

  if (TURN_ENABLE_UDP) {
    urls.push(`turn:${TURN_PUBLIC_HOST}:${TURN_PORT}?transport=udp`);
  }

  if (TURN_ENABLE_TCP) {
    urls.push(`turn:${TURN_PUBLIC_HOST}:${TURN_PORT}?transport=tcp`);
  }

  if (TURN_ENABLE_TLS) {
    urls.push(`turns:${TURN_PUBLIC_HOST}:${TURN_TLS_PORT}?transport=tcp`);
  }

  return urls;
}

function buildTurnCredentials(roomCode) {
  const expiresAtUnix = Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL_SECONDS;
  const username = `${expiresAtUnix}:flightmanager:${roomCode}`;
  const credential = crypto
    .createHmac('sha1', TURN_SHARED_SECRET)
    .update(username)
    .digest('base64');

  return {
    username,
    credential,
    credentialType: 'password',
    ttlSeconds: TURN_CREDENTIAL_TTL_SECONDS,
    expiresAt: new Date(expiresAtUnix * 1000).toISOString(),
    iceServers: [
      {
        urls: buildTurnCredentialUrls(),
        username,
        credential,
        credentialType: 'password',
      },
    ],
  };
}

function touchRoomActivity(room, updates = {}) {
  room.updatedAt = new Date();
  Object.assign(room, updates);
}

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.isAlive === false) {
      client.terminate();
      return;
    }

    client.isAlive = false;

    if (client.readyState === WebSocket.OPEN) {
      client.ping();
    }
  });
}, WS_HEARTBEAT_INTERVAL_MS);

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  let currentRoom = null;
  let deviceType = null; // 'pc' or 'mobile'

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    try {
      ws.isAlive = true;
      const data = JSON.parse(message);

      // Handle PC server registration
      if (data.type === 'register_pc') {
        let roomCode;
        let reconnectionToken;
        let isReconnection = false;
        const requestedRoomCode = normalizeRequestedRoomCode(data.requestedRoomCode);

        // Check if PC is attempting reconnection with existing token
        if (data.reconnectionToken && requestedRoomCode) {
          const storedRoomCode = reconnectionTokens.get(data.reconnectionToken);

          // If token is valid and room still exists, reuse it
          if (storedRoomCode === requestedRoomCode && rooms.has(storedRoomCode)) {
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
            touchRoomActivity(existingRoom, {
              pcLastSeenAt: new Date(),
            });
            isReconnection = true;

            console.log(`PC reconnected with existing room code: ${roomCode}`);

            // Notify mobile client that the PC has returned
            if (existingRoom.mobile && existingRoom.mobile.readyState === WebSocket.OPEN) {
              try {
                existingRoom.mobile.send(JSON.stringify({
                  type: 'pc_reconnected',
                  message: 'PC reconnected to relay server'
                }));
              } catch (error) {
                console.error('Error notifying mobile about PC reconnection:', error);
              }
            }
          }
        }

        // If not reconnection, create new room
        if (!roomCode) {
          let previousMobileSocket = null;

          // If a reconnection token was provided, try to migrate the existing session
          if (data.reconnectionToken) {
            reconnectionToken = data.reconnectionToken;
            const previousRoomCode = reconnectionTokens.get(reconnectionToken);

            if (previousRoomCode && rooms.has(previousRoomCode)) {
              const previousRoom = rooms.get(previousRoomCode);

              // Cancel any pending cleanup for the old room
              if (previousRoom.cleanupTimeout) {
                clearTimeout(previousRoom.cleanupTimeout);
                delete previousRoom.cleanupTimeout;
              }

              // Capture mobile socket to notify it about the room change
              if (previousRoom.mobile && previousRoom.mobile.readyState === WebSocket.OPEN) {
                previousMobileSocket = previousRoom.mobile;
              }

              // Remove the old room entry
              rooms.delete(previousRoomCode);
            }
          }

          if (requestedRoomCode && !rooms.has(requestedRoomCode)) {
            roomCode = requestedRoomCode;
            console.log(`PC reclaimed cached room code: ${roomCode}`);
          } else {
            roomCode = generateUniqueRoomCode();
          }

          if (!reconnectionToken) {
            reconnectionToken = generateReconnectionToken();
          }

          rooms.set(roomCode, {
            pc: ws,
            mobile: null,
            reconnectionToken: reconnectionToken,
            createdAt: new Date(),
            updatedAt: new Date(),
            pcLastSeenAt: new Date(),
            mobileLastSeenAt: null,
            lastTelemetryAt: null,
            lastBridgeHeartbeatAt: null,
            simulatorConnected: null,
          });

          reconnectionTokens.set(reconnectionToken, roomCode);

          console.log(`PC registered with new room code: ${roomCode}`);

          // Let any previously connected mobile client know about the new code
          if (previousMobileSocket) {
            try {
              previousMobileSocket.send(JSON.stringify({
                type: 'room_code_update',
                roomCode,
                reconnectionToken,
                message: 'PC reconnected with new room code'
              }));

              // Give the client time to receive the message before closing
              setTimeout(() => {
                try {
                  previousMobileSocket.close(4001, 'Room code updated');
                } catch (error) {
                  console.error('Error closing previous mobile connection after room update:', error);
                }
              }, 100);
            } catch (error) {
              console.error('Error notifying mobile client about new room code:', error);
            }
          }
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
        touchRoomActivity(room, {
          mobileLastSeenAt: new Date(),
        });

        // Notify both devices
        ws.send(JSON.stringify({
          type: 'connected',
          message: 'Connected to PC successfully',
          roomCode,
          reconnectionToken: room.reconnectionToken
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
          const payloadType = data.payload?.type;
          const now = new Date();

          touchRoomActivity(room, {
            pcLastSeenAt: now,
          });

          if (payloadType === 'session_info') {
            touchRoomActivity(room, {
              lastBridgeHeartbeatAt: now,
            });
          } else if (payloadType === 'bridge_status') {
            touchRoomActivity(room, {
              lastBridgeHeartbeatAt: now,
              simulatorConnected: typeof data.payload?.simulatorConnected === 'boolean'
                ? data.payload.simulatorConnected
                : room.simulatorConnected,
            });

            if (data.payload?.lastTelemetryAt) {
              const parsedTelemetryDate = new Date(data.payload.lastTelemetryAt);
              if (!Number.isNaN(parsedTelemetryDate.getTime())) {
                room.lastTelemetryAt = parsedTelemetryDate;
              }
            }
          } else if (payloadType === 'telemetry' || data.payload?.data) {
            touchRoomActivity(room, {
              lastTelemetryAt: now,
              simulatorConnected: data.payload?.simulatorConnected ?? data.payload?.data?.isConnected ?? true,
            });
          }

          room.mobile.send(JSON.stringify({
            type: 'data',
            payload: data.payload
          }));
        }
        // If message from mobile, send to PC
        else if (deviceType === 'mobile' && room.pc && room.pc.readyState === WebSocket.OPEN) {
          touchRoomActivity(room, {
            mobileLastSeenAt: new Date(),
          });
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
        }, ROOM_CLEANUP_TTL_MS);

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
    uptime: process.uptime(),
    turnConfigured: isTurnConfigured(),
  });
});

// Lookup session details by reconnection token
app.get('/session/:token', (req, res) => {
  const { token } = req.params;
  const roomCode = reconnectionTokens.get(token);

  if (!roomCode) {
    return res.status(404).json({
      error: 'Session not found'
    });
  }

  const room = rooms.get(roomCode);
  const pcConnected = Boolean(room && room.pc && room.pc.readyState === WebSocket.OPEN);
  const mobileConnected = Boolean(room && room.mobile && room.mobile.readyState === WebSocket.OPEN);

  res.json({
    roomCode,
    reconnectionToken: room?.reconnectionToken ?? token,
    pcConnected,
    mobileConnected,
    simulatorConnected: typeof room?.simulatorConnected === 'boolean' ? room.simulatorConnected : null,
    createdAt: toIsoString(room?.createdAt),
    updatedAt: toIsoString(room?.updatedAt),
    pcLastSeenAt: toIsoString(room?.pcLastSeenAt),
    mobileLastSeenAt: toIsoString(room?.mobileLastSeenAt),
    lastTelemetryAt: toIsoString(room?.lastTelemetryAt),
    lastBridgeHeartbeatAt: toIsoString(room?.lastBridgeHeartbeatAt),
  });
});

app.get('/turn-credentials', (req, res) => {
  if (!isTurnConfigured()) {
    return res.status(503).json({
      success: false,
      configured: false,
      message: 'TURN is not configured on this relay server',
    });
  }

  const sessionToken = String(req.get('x-relay-session-token') || '').trim();
  const requestedRoomCode = String(req.get('x-relay-room-code') || '')
    .trim()
    .toUpperCase();

  if (!sessionToken) {
    return res.status(401).json({
      success: false,
      configured: true,
      message: 'Relay session token is required',
    });
  }

  const roomCode = reconnectionTokens.get(sessionToken);
  if (!roomCode || !rooms.has(roomCode)) {
    return res.status(404).json({
      success: false,
      configured: true,
      message: 'Relay session was not found',
    });
  }

  if (requestedRoomCode && requestedRoomCode !== roomCode) {
    return res.status(403).json({
      success: false,
      configured: true,
      message: 'Relay room code does not match the session token',
    });
  }

  const room = rooms.get(roomCode);
  const pcConnected = Boolean(room?.pc && room.pc.readyState === WebSocket.OPEN);

  if (!pcConnected) {
    return res.status(409).json({
      success: false,
      configured: true,
      message: 'PC host is not currently connected to the relay',
    });
  }

  const credentials = buildTurnCredentials(roomCode);

  res.json({
    success: true,
    configured: true,
    roomCode,
    ttlSeconds: credentials.ttlSeconds,
    expiresAt: credentials.expiresAt,
    iceServers: credentials.iceServers,
    message: 'TURN credentials issued successfully',
  });
});

// Get room status (for debugging)
app.get('/rooms', (req, res) => {
  if (!ENABLE_DEBUG_ENDPOINTS) {
    return res.status(404).json({
      error: 'Not found'
    });
  }

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

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});
