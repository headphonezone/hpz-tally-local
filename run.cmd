@echo off
cd /d "%~dp0"
echo Starting HPZ Material Out app...
start "" http://localhost:7654
node server.mjs
pause
