# NovaRemote Windows Auto-Start Installation Script
# This script sets up NovaRemote server and player to launch automatically in fullscreen on Windows startup.

$projectDir = "C:\Users\shaun\.gemini\antigravity\scratch\novaremote"
$batPath = Join-Path $projectDir "start_novaremote.bat"
$chromeProfile = "C:\Users\shaun\novaremote_chrome_profile"

# 1. Create the Batch execution file
$batContent = @"
@echo off
title NovaRemote Startup Orchestrator
cd /d "$projectDir"

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
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk "http://localhost:5000/player.html?screenId=default" --user-data-dir="$chromeProfile" --no-first-run --no-default-browser-check
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk "http://localhost:5000/player.html?screenId=default" --user-data-dir="$chromeProfile" --no-first-run --no-default-browser-check
) else (
    echo Chrome not found. Falling back to Microsoft Edge...
    start "" msedge --kiosk "http://localhost:5000/player.html?screenId=default" --edge-kiosk-type=fullscreen --no-first-run
)

exit
"@

Set-Content -Path $batPath -Value $batContent -Force
Write-Host "Created batch startup launcher at: $batPath"

# 2. Register LNK shortcut in the Windows Startup Folder
$startupFolder = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\Startup")
$shortcutPath = Join-Path $startupFolder "NovaRemotePlayer.lnk"

try {
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut($shortcutPath)
    $Shortcut.TargetPath = $batPath
    $Shortcut.WorkingDirectory = $projectDir
    $Shortcut.Description = "Starts NovaRemote Node Server and Fullscreen Kiosk Player"
    $Shortcut.Save()
    
    Write-Host "`n=======================================================" -ForegroundColor Green
    Write-Host " SUCCESS: Startup shortcut successfully registered!" -ForegroundColor Green
    Write-Host " Shortcut Path: $shortcutPath" -ForegroundColor Green
    Write-Host "=======================================================" -ForegroundColor Green
    Write-Host "NovaRemote Node server and Kiosk player will now start automatically in fullscreen whenever this PC restarts."
} catch {
    Write-Error "Failed to create startup shortcut: $_"
}
