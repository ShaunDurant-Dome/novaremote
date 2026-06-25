@echo off
title NovaRemote Player Launcher
echo ===================================================
echo  Launching Microsoft Edge in Fullscreen Player...
echo ===================================================

:: The URL of the player page on portal.thedomenamibia.com
set "PLAYER_URL=https://portal.thedomenamibia.com/digital/player.html?screenId=default&width=1920&height=384"

:: Kill any existing edge instances to allow the player to launch cleanly
echo [INFO] Closing existing Microsoft Edge instances...
taskkill /F /IM msedge.exe >nul 2>&1
timeout /t 1 >nul

:: Start Edge in fullscreen/app mode pointing to the player
echo [INFO] Starting Edge fullscreen player...
start msedge --start-fullscreen --no-first-run --no-default-browser-check "%PLAYER_URL%"

echo [INFO] Player launched successfully!
echo ===================================================
timeout /t 3 >nul
