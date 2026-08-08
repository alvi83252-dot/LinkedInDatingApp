@echo off
cd /d "%~dp0"
start "" node server.js
timeout /t 1 >nul
start "" http://localhost:3456
