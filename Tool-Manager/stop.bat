@echo off
echo Stopping Twin Base...
docker stop twin-base >nul 2>&1
echo Stopping the OPC UA simulator...
taskkill /im opcua_ijt_demo_application.exe /f >nul 2>&1
echo Done.
pause
