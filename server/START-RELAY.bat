@echo off
setlocal
color 0B
title Flight Manager - Cloud Relay Mode

cls
echo.
echo ===============================================================
echo          FLIGHT MANAGER - CLOUD RELAY MODE
echo ===============================================================
echo.
echo This mode connects your PC to a cloud relay server.
echo No ngrok or port forwarding needed!
echo.
echo You will get a 6-digit code to enter in your mobile app.
echo.
echo Press any key to start...
pause >nul

cls
echo.
echo ===============================================================
echo          STARTING CLOUD RELAY MODE
echo ===============================================================
echo.

REM Check if Node.js is installed
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed!
    echo.
    echo Please install Node.js from: https://nodejs.org
    echo.
    pause
    exit /b
)

REM Check if ws package is installed
if not exist "node_modules\ws" (
    echo Installing required packages...
    call npm install
    echo.
)

REM Set cloud relay URL (update this with your deployed relay server URL)
REM For local testing, use: ws://localhost:3000
REM For production, use: wss://your-relay-server.railway.app
set RELAY_URL=ws://localhost:3000
set USE_RELAY=true

echo.
echo Starting server with cloud relay...
echo.

node simconnect-server.js

pause
