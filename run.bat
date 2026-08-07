@echo off
setlocal

rem Race Day Dashboard launcher
rem -----------------------------
rem Installs dependencies (first run only), starts server.js in its own
rem console window, then opens the dashboard in Chrome (falling back to the
rem default browser if Chrome isn't found).

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [run.bat] Node.js was not found on PATH. Install Node.js from https://nodejs.org/ and try again.
    exit /b 1
)

set "NEED_INSTALL="
if not exist "node_modules" set "NEED_INSTALL=1"
if not exist "node_modules\express" set "NEED_INSTALL=1"
if not exist "node_modules\mongodb" set "NEED_INSTALL=1"
if not exist "node_modules\exceljs" set "NEED_INSTALL=1"
if not exist "node_modules\pdfkit" set "NEED_INSTALL=1"

if defined NEED_INSTALL (
    echo [run.bat] Installing/updating dependencies ^(express, mongodb, exceljs, pdfkit^)...
    call npm install
    if errorlevel 1 (
        echo [run.bat] npm install failed. See errors above.
        exit /b 1
    )
)

if not defined DB_CONFIG_PATH (
    set "DB_CONFIG_PATH=C:\Users\Dinesh\projects-config\db.json"
)
if not defined PORT (
    set "PORT=3000"
)
set "URL=http://localhost:%PORT%/"

echo [run.bat] Using config file: %DB_CONFIG_PATH%
echo [run.bat] Starting race day dashboard on port %PORT% in its own window ...
start "Race Day Dashboard Server" cmd /k "node server.js"

echo [run.bat] Waiting for the server to come up ...
timeout /t 3 /nobreak >nul

set "CHROME_EXE="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME_EXE if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME_EXE=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if defined CHROME_EXE (
    echo [run.bat] Opening %URL% in Chrome ...
    start "" "%CHROME_EXE%" "%URL%"
) else (
    echo [run.bat] Chrome not found in common install locations - opening in your default browser instead.
    start "" "%URL%"
)

echo [run.bat] The server keeps running in the "Race Day Dashboard Server" window.
echo [run.bat] Close that window to stop the service.

endlocal
