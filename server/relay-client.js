const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

class RelayClient {
  constructor(relayUrl) {
    this.relayUrl = relayUrl;
    this.ws = null;
    this.roomCode = null;
    this.reconnectionToken = null;
    this.isConnected = false;
    this.messageHandlers = [];
    this.reconnectInterval = null;
    this.configPath = path.join(__dirname, '.relay-config.json');

    // Load saved room code and token if exists
    this.loadSavedConfig();
  }

  // Load saved room code and reconnection token
  loadSavedConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.roomCode = config.roomCode;
        this.reconnectionToken = config.reconnectionToken;
        console.log(`📂 Loaded saved room code: ${this.roomCode}`);
      }
    } catch (error) {
      console.error('Error loading saved config:', error.message);
    }
  }

  // Save room code and reconnection token
  saveConfig() {
    try {
      const config = {
        roomCode: this.roomCode,
        reconnectionToken: this.reconnectionToken,
        lastSaved: new Date().toISOString()
      };
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      console.log(`💾 Saved room code: ${this.roomCode}`);
    } catch (error) {
      console.error('Error saving config:', error.message);
    }
  }

  // Connect to relay server and register as PC
  connect() {
    return new Promise((resolve, reject) => {
      try {
        console.log(`Connecting to relay server: ${this.relayUrl}`);
        this.ws = new WebSocket(this.relayUrl);

        this.ws.on('open', () => {
          console.log('Connected to relay server');

          // Register as PC (with reconnection token if available)
          const registrationMessage = {
            type: 'register_pc'
          };

          // Include reconnection token if we have one (for reconnection with same code)
          if (this.reconnectionToken) {
            registrationMessage.reconnectionToken = this.reconnectionToken;
            registrationMessage.requestedRoomCode = this.roomCode;
            console.log(`🔄 Attempting to reconnect with saved room code: ${this.roomCode}`);
          }

          this.ws.send(JSON.stringify(registrationMessage));
        });

        this.ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());

            // Handle registration response
            if (message.type === 'registered') {
              this.roomCode = message.roomCode;
              this.reconnectionToken = message.reconnectionToken;
              this.isConnected = true;

              // Save the config for future reconnections
              this.saveConfig();

              console.log(`✅ Registered with room code: ${this.roomCode}`);
              if (message.isReconnection) {
                console.log(`🔄 Successfully reconnected with same room code!`);
              }
              resolve(this.roomCode);
            }

            // Handle mobile connection
            else if (message.type === 'mobile_connected') {
              console.log('📱 Mobile device connected');
            }

            // Handle mobile disconnection
            else if (message.type === 'mobile_disconnected') {
              console.log('📱 Mobile device disconnected');
            }

            // Handle data from mobile
            else if (message.type === 'data') {
              // Forward to all registered message handlers
              this.messageHandlers.forEach(handler => {
                try {
                  handler(message.payload);
                } catch (err) {
                  console.error('Error in message handler:', err);
                }
              });
            }

            // Handle errors
            else if (message.type === 'error') {
              console.error('Relay error:', message.message);
            }

          } catch (err) {
            console.error('Error parsing relay message:', err);
          }
        });

        this.ws.on('close', () => {
          console.log('Disconnected from relay server');
          this.isConnected = false;
          this.roomCode = null;

          // Auto-reconnect after 5 seconds
          this.reconnectInterval = setTimeout(() => {
            console.log('Attempting to reconnect...');
            this.connect().catch(console.error);
          }, 5000);
        });

        this.ws.on('error', (error) => {
          console.error('Relay WebSocket error:', error.message);
          reject(error);
        });

        // Timeout if no registration within 10 seconds
        setTimeout(() => {
          if (!this.isConnected) {
            reject(new Error('Registration timeout'));
          }
        }, 10000);

      } catch (error) {
        reject(error);
      }
    });
  }

  // Send data to mobile device
  sendToMobile(data) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('Cannot send: Not connected to relay');
      return false;
    }

    try {
      this.ws.send(JSON.stringify({
        type: 'relay',
        payload: data
      }));
      return true;
    } catch (error) {
      console.error('Error sending to mobile:', error);
      return false;
    }
  }

  // Register a handler for messages from mobile
  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  // Get the room code
  getRoomCode() {
    return this.roomCode;
  }

  // Check if connected
  isRelayConnected() {
    return this.isConnected;
  }

  // Disconnect from relay
  disconnect() {
    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    this.roomCode = null;
  }
}

module.exports = RelayClient;
