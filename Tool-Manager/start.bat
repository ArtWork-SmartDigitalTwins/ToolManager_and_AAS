@echo off
setlocal
cd /d "%~dp0"

docker info >nul 2>&1
if errorlevel 1 (
    echo Docker is not running. Start Docker Desktop, wait until it says "Engine running", then run this again.
    pause
    exit /b 1
)

docker image inspect twin-base:latest >nul 2>&1
if errorlevel 1 (
    echo Loading the Twin Base image - first run only, this takes a minute...
    docker load -i twin-base-image.tar
    if errorlevel 1 (
        echo Failed to load twin-base-image.tar.
        pause
        exit /b 1
    )
)

tasklist /fi "imagename eq opcua_ijt_demo_application.exe" | find /i "opcua_ijt_demo_application.exe" >nul
if errorlevel 1 (
    echo Starting the OPC UA simulator in a new window - keep that window open...
    start "OPC UA IJT Simulator" /d "%~dp0OPC_UA_IJT_Server_Simulator" opcua_ijt_demo_application.exe
) else (
    echo OPC UA simulator is already running.
)

docker container inspect twin-base >nul 2>&1
if errorlevel 1 (
    echo Creating the Twin Base container...
    docker run -d --name twin-base -p 5050:5050 --add-host host.docker.internal:host-gateway twin-base:latest >nul
) else (
    echo Starting the Twin Base container...
    docker start twin-base >nul
)

echo Waiting for Twin Base...
ping -n 6 127.0.0.1 >nul
start "" http://localhost:5050
echo.
echo Twin Base is running at http://localhost:5050
echo Run stop.bat to stop everything.
pause
