@echo off
setlocal
cd /d "%~dp0"
title AAS Generator

rem --- Pick a Node runtime: bundled one first, then system-installed ---
set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js was not found.
    echo Either install Node 18+ from https://nodejs.org or place node.exe in the "runtime" folder.
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

rem --- Dependencies (normally shipped in node_modules) ---
if not exist "node_modules\express" (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo node_modules is missing and npm is not available to install it.
    pause
    exit /b 1
  )
  echo Installing dependencies...
  call npm install --omit=dev
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

rem --- First run: create .env and ask for the API key ---
if exist ".env" goto :have_env
echo First-time setup.
set "API_KEY="
set /p "API_KEY=Paste your Anthropic API key: "
> ".env" echo ANTHROPIC_API_KEY=%API_KEY%
>> ".env" echo PORT=4100
echo Saved to .env
echo.
:have_env

set "PORT=4100"
for /f "usebackq tokens=1,* delims==" %%A in (".env") do if /i "%%A"=="PORT" set "PORT=%%B"

echo Starting AAS Generator on http://localhost:%PORT%  (close this window to stop)
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"
"%NODE_EXE%" server.js
echo.
echo Server stopped.
pause
