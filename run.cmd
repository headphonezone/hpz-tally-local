@echo off
cd /d "%~dp0"
echo Starting HPZ Tally app (Material Out + Stock Journal)...
if not exist .env echo WARNING: no .env found - copy .env.example to .env, or the Stock Journal tab cannot reach RMS.
start "" http://localhost:7654
node server.mjs
pause
