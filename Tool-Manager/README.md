# Twin Base – demo package

This package runs the Twin Base web app together with a simulated tightening tool (the
OPC UA IJT simulator). Everything runs on your own Windows PC.

## Requirements

- Windows 10/11
- [Docker Desktop](https://www.docker.com/products/docker-desktop/), installed and started

## Quick start

1. Unzip this folder anywhere.
2. Start Docker Desktop and wait until it shows "Engine running".
3. Double-click **`start.bat`**.

`start.bat` does the following:
- the first time only, loads the Twin Base image into Docker (`twin-base-image.tar`)
- starts the OPC UA simulator in its own window. **Leave that window open**: closing it or pressing a key in it stops the simulator.
- starts the Twin Base container
- opens http://localhost:5050 in your browser

The first time the simulator starts, Windows may ask whether to allow network access.
**Allow it**, or Twin Base can't connect to the simulator.

To stop everything, double-click **`stop.bat`**.

## Troubleshooting

- **The page loads but shows no tool data.** Check that the simulator window is open.
  Twin Base keeps retrying and connects within a few seconds once the simulator is running.
- **The joint shows as unknown right after starting.** That's normal on a fresh simulator.
  Select a joint in the UI once.
- **Port 5050 is already in use.** Something else is using that port. Stop it, or run the
  container on another port:
  `docker rm -f twin-base` and then
  `docker run -d --name twin-base -p 8080:5050 --add-host host.docker.internal:host-gateway twin-base:latest`,
  then open http://localhost:8080.
- **See what Twin Base is doing:** `docker logs -f twin-base`

## Manual commands (without the .bat files)

```powershell
docker load -i twin-base-image.tar
# in OPC_UA_IJT_Server_Simulator, leave running:
.\opcua_ijt_demo_application.exe
docker run -d --name twin-base -p 5050:5050 --add-host host.docker.internal:host-gateway twin-base:latest
```

## Contents

| Item | What it is |
| --- | --- |
| `twin-base-image.tar` | Twin Base Docker image |
| `OPC_UA_IJT_Server_Simulator/` | Simulated tightening tool (OPC UA server, port 40451) |
| `start.bat` / `stop.bat` | Start and stop everything |
