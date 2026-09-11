@echo off
cd /d "%~dp0"
node prune-ignores.js
echo.
echo Done. Press any key to close this window.
pause >nul
