@echo off
rem Double-click to open the Open Tuna editor (Windows). Keep the window that opens; close it to stop.
cd /d "%~dp0"
title Open Tuna editor server
py -3 --version >nul 2>nul
if %errorlevel%==0 ( py -3 tools\serve.py --open & goto :end )
python --version >nul 2>nul
if %errorlevel%==0 ( python tools\serve.py --open & goto :end )
echo Python not found - using the built-in PowerShell server.
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\serve.ps1" -Open
:end
pause
