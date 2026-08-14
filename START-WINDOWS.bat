@echo off
setlocal
cd /d "%~dp0"
title IBuild Company Management System
color 0B

echo ================================================
echo       IBuild Company Management System
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not in PATH.
  echo Install Node.js LTS, reopen this window, and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" (
  echo Installing project dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo.
echo Starting IBuild System...
echo Open: http://localhost:3000
 echo Press Ctrl+C to stop the server.
echo.
node server.js
pause
