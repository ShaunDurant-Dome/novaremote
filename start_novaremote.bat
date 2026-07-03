@echo off
title NovaRemote Startup Orchestrator
cd /d "C:\Users\shaun\.gemini\antigravity\scratch\novaremote"

echo ==============================================
echo  Starting NovaRemote Backend Server...
echo ==============================================
start "NovaRemote Server" /min cmd /c "node server.js"

echo Waiting 5 seconds for server to initialize...
timeout /t 5 >nul

echo ==============================================
echo  Launching Player in Fullscreen Kiosk Mode...
echo ==============================================

:: Check Chrome path variations, fallback to Edge if Chrome is not installed
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk "http://localhost:5000/player.html?screenId=default" --user-data-dir="C:\Users\shaun\novaremote_chrome_profile" --no-first-run --no-default-browser-check
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk "http://localhost:5000/player.html?screenId=default" --user-data-dir="C:\Users\shaun\novaremote_chrome_profile" --no-first-run --no-default-browser-check
) else (
    echo Chrome not found. Falling back to Microsoft Edge...
    start "" msedge --kiosk "http://localhost:5000/player.html?screenId=default" --edge-kiosk-type=fullscreen --no-first-run
)

exit
