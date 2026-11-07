@echo off
REM TAVAS Digital Twin - local demo: the command centre plus 15 SIMULATED drones, on this PC.
REM Needs Python 3.10+ and an internet connection (for the satellite map and 3D terrain in your browser).
REM Everything shown is labelled SIMULATION. Close this window to stop.
cd /d "%~dp0"
if not exist .venv (
  py -3 -m venv .venv
  .venv\Scripts\pip install -r requirements.txt
)
set TWIN_DATA_DIR=%~dp0demo_data
set TWIN_PASSWORD=demo
set TWIN_SECRET_KEY=local-demo
set TWIN_INGEST_TOKEN=demo-token
set TWIN_VIDEO_PUBLISH_PASS=demo-video
start "TAVAS server" /min .venv\Scripts\uvicorn twin.app:app --host 127.0.0.1 --port 8080
timeout /t 5 /nobreak >nul
start "TAVAS simulator" /min .venv\Scripts\python tools\fleet_sim.py --server ws://127.0.0.1:8080 --token demo-token
timeout /t 3 /nobreak >nul
echo.
echo Opening http://localhost:8080  (user: admin   password: demo)
echo Live 3D satellite view: Live Flight Monitor in the menu.
start "" "http://localhost:8080/#/monitor/TAVAS-04"
pause
