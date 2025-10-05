# Flight Manager - Cloud Relay Setup Guide

## 🎯 What This Does

Instead of ngrok (which requires each user to set up an account), we use a **cloud relay server** that you deploy ONCE, and ALL users can connect through it with just a 6-digit code.

## 📋 How It Works

1. **You deploy the relay server** to Railway/Render (free, takes 5 minutes)
2. **Users start their PC server** - gets a 6-digit code like "ABC123"
3. **Users open mobile app** - enter "ABC123" to connect
4. **Done!** No ngrok, no setup, no complexity

---

## 🚀 Deploy Relay Server (One-Time Setup)

### Option 1: Railway.app (Recommended - Easiest)

1. **Create Railway Account**
   - Go to https://railway.app
   - Click "Login with GitHub" (or create account)
   - Free tier: 500 hours/month ($5 credit, no credit card needed)

2. **Deploy the Relay Server**
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Connect your GitHub account
   - Select the `relay-server` folder from this repository
   - Railway auto-detects Node.js and deploys!

3. **Get Your Relay URL**
   - Once deployed, click on your service
   - Click "Settings" → "Networking"
   - Copy the public URL (looks like: `https://your-app.railway.app`)
   - **Important**: Change `https://` to `wss://` (WebSocket Secure)
   - Your relay URL will be: `wss://your-app.railway.app`

4. **Update PC Server**
   - Open `server/START-RELAY.bat`
   - Find line: `set RELAY_URL=ws://localhost:3000`
   - Change to: `set RELAY_URL=wss://your-app.railway.app`
   - Save the file

### Option 2: Render.com (Alternative)

1. Go to https://render.com
2. Click "New" → "Web Service"
3. Connect GitHub and select `relay-server` folder
4. Settings:
   - Name: flight-manager-relay
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Deploy and copy the URL (change https to wss)

### Option 3: Glitch.com (Simplest, but sleeps after 5 min)

1. Go to https://glitch.com
2. Click "New Project" → "Import from GitHub"
3. Paste repository URL
4. Glitch auto-deploys
5. Get URL from project settings

---

## 💻 Using Cloud Relay Mode

### For End Users:

**On PC:**
1. Double-click `START-RELAY.bat`
2. Server shows a 6-digit code: **ABC123**
3. Leave this window open

**On Mobile:**
4. Open Flight Manager app
5. Enter code: **ABC123**
6. Connected! ✅

### Testing Locally First:

Before deploying to cloud, test locally:

1. **Start Local Relay Server:**
   ```bash
   cd relay-server
   npm install
   npm start
   ```
   (Runs on http://localhost:3000)

2. **Start PC Server with Relay:**
   ```bash
   cd server
   START-RELAY.bat
   ```

3. **Update Mobile App** to connect to relay (see mobile app update section)

---

## 📱 Mobile App Updates Needed

Update your mobile app to support cloud relay:

1. Add relay connection option
2. Show input field for 6-digit code
3. Connect to relay WebSocket instead of direct HTTP
4. Send/receive messages through relay

(Detailed mobile app code will be provided separately)

---

## 🔧 Configuration

### Environment Variables (Optional)

For the relay server, you can set:
- `PORT` - Server port (default: 3000, Railway sets this automatically)

For the PC server:
- `RELAY_URL` - Cloud relay WebSocket URL
- `USE_RELAY` - Set to "true" to enable relay mode

---

## 📊 Monitoring

### Check Relay Server Status:

- Health check: `https://your-relay-url/health`
- Active rooms: `https://your-relay-url/rooms`

### Expected Response:
```json
{
  "status": "ok",
  "activeRooms": 5,
  "uptime": 12345
}
```

---

## 💰 Costs

### Free Tiers:
- **Railway**: 500 hours/month free ($5 credit)
- **Render**: Unlimited (spins down after 15 min inactive)
- **Glitch**: Unlimited (sleeps after 5 min inactive)

### For 100 Users:
- Railway free tier is enough for ~20 days of 24/7 uptime
- For always-on: Upgrade to $5/month plan
- Render free tier works well if traffic is intermittent

---

## 🛡️ Security

- Room codes are randomly generated (36^6 = ~2 billion combinations)
- Rooms auto-delete when PC disconnects
- No data storage - purely a relay
- WebSocket Secure (WSS) encryption on cloud deployments
- One mobile device per room limit

---

## 🐛 Troubleshooting

**Problem**: Can't connect to relay server
**Solution**: Check relay URL is correct and starts with `wss://` (not `https://`)

**Problem**: Invalid room code
**Solution**: Room codes expire when PC disconnects. Start PC server again to get new code.

**Problem**: Mobile says "Room already has a device"
**Solution**: Only one mobile per PC. Disconnect other mobile first.

**Problem**: Relay server sleeps (Render/Glitch)
**Solution**: First connection wakes it up (takes ~30 seconds). Consider Railway for always-on.

---

## 📝 Summary

1. ✅ Deploy relay server to Railway (5 minutes, one-time)
2. ✅ Update `START-RELAY.bat` with your relay URL
3. ✅ Users get a 6-digit code when starting PC server
4. ✅ Users enter code in mobile app
5. ✅ Connected remotely - no ngrok, no setup!

**This is WAY simpler than ngrok for end users!** 🎉
