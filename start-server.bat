@echo off
title FreeLLMAPI Server
cd /d "%~dp0"
echo ===================================================
echo     DANG KHOI CHAY FREELMMAPI TAI PORT 3001
echo ===================================================
echo Dashboard: http://localhost:3001
echo Endpoint:  http://localhost:3001/v1
echo.
node server/dist/index.js
pause
