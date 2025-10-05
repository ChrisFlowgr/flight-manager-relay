# Flight Manager Cloud Relay Server

This relay server enables remote connections between Flight Simulator PCs and mobile devices without port forwarding or ngrok.

## How It Works

1. **PC Server** connects to this relay and gets a 6-digit room code (e.g., "ABC123")
2. **Mobile App** connects using the same room code
3. **Relay Server** forwards all messages between PC and mobile

## Deployment Options

### Option 1: Railway.app (Recommended)

1. Create account at https://railway.app
2. Click "New Project" → "Deploy from GitHub repo"
3. Connect this repository
4. Railway auto-detects Node.js and deploys
5. Get your URL: `https://your-app.railway.app`

### Option 2: Render.com

1. Create account at https://render.com
2. Click "New" → "Web Service"
3. Connect this repository
4. Set build command: `npm install`
5. Set start command: `npm start`
6. Deploy and get URL

### Option 3: Glitch.com

1. Go to https://glitch.com
2. Click "New Project" → "Import from GitHub"
3. Paste this repository URL
4. Glitch auto-deploys
5. Get your URL

## Environment Variables

No environment variables needed! The server uses `PORT` provided by the hosting platform.

## Testing Locally

```bash
npm install
npm start
```

Server runs on http://localhost:3000

## API Endpoints

- `GET /health` - Health check
- `GET /rooms` - List active rooms (for debugging)
- WebSocket endpoint at `/`

## WebSocket Protocol

### PC Registration
```json
{
  "type": "register_pc"
}
```

Response:
```json
{
  "type": "registered",
  "roomCode": "ABC123"
}
```

### Mobile Join Room
```json
{
  "type": "join_room",
  "roomCode": "ABC123"
}
```

### Relay Messages
```json
{
  "type": "relay",
  "payload": { /* any data */ }
}
```

## Security Notes

- Room codes are randomly generated (6 characters, ~2 billion combinations)
- Rooms are automatically deleted when PC disconnects
- Only one mobile device per room
- No data is stored - purely a relay

## Scaling

The free tiers support:
- Railway: 500 hours/month (always-on = ~20 days)
- Render: Unlimited (spins down after 15 min inactive)
- Glitch: Unlimited (sleeps after 5 min inactive)

For production with 100+ users, consider upgrading to paid tier (~$5-10/month).
