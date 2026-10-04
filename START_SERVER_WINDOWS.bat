@echo off
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo Node.js 22 or newer is required: https://nodejs.org
  pause
  exit /b 1
)
echo Open http://localhost:8080 in your browser.
node server\server.js
pause
