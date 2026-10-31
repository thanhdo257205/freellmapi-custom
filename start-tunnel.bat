@echo off
title FreeLLMAPI Tunnel for Cursor
cd /d "%~dp0"
echo =====================================================================
echo           KHOI TAO DUONG TRUYEN HTTPS CONG KHAI CHO CURSOR
echo =====================================================================
echo.
echo He thong dang ket noi toi dich vu Tunnel...
echo Khi man hinh hien thi dia chi https://... (vi du: https://xxxx.a.pinggy.link)
echo Ban hay copy link do, them "/v1" o cuoi va dan vao Cursor!
echo.
ssh -p 443 -R0:localhost:3001 a.pinggy.io
pause
