@echo off
title NovaRemote LED Controller Startup
cd /d %~dp0

echo ===================================================
echo  Starting NovaRemote LED Control System...
echo ===================================================

:: Check if node_modules folder exists, if not run npm install
if not exist node_modules (
    echo [INFO] Node dependencies not found. Installing now...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed. Please ensure Node.js is installed.
        pause
        exit /b 1
    )
)

:: Start the node server in a separate background window
echo [INFO] Starting Node.js Server on port 5000...
start "NovaRemote Backend" /min node server.js

:: Wait for server to start up
timeout /t 2 >nul

:: Open the Admin Dashboard in the default web browser
echo [INFO] Launching Admin Dashboard...
start http://localhost:5000/

echo ===================================================
echo  NovaRemote is now running!
echo  Access it at: http://localhost:5000/
echo  Close this window to stop the launcher.
echo ===================================================
pause
