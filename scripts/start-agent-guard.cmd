@echo off
setlocal

cd /d "%~dp0.."

echo.
echo ==========================================
echo   Agent Guard One-Click Start
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  echo.
  echo Please install Node.js LTS first, then double-click this file again.
  echo Download: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo [1/3] Node.js detected:
node --version
echo.

echo [2/3] Starting Agent Guard Workbench and Sample HTTP Agent...
echo.
echo Browser URL: http://localhost:5177
echo If the browser does not open automatically, copy the URL above manually.
echo.
echo Keep this window open while using the demo.
echo Press Ctrl+C or close this window to stop services.
echo.

start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:5177'"

node scripts\start-demo.mjs

echo.
echo Services stopped.
pause
