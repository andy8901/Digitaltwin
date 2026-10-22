@echo off
REM Neosky Live Twin field relay for the ground-station laptop. Edit the five lines below once per drone/laptop.
set SERVER=wss://twin.example.com
set TOKEN=change-this-ingest-token
set MSN=064
set MODEL=Tavas
set CAMERA=rtsp://192.168.144.25:8554/main.264
set VIDEOPASS=change-this-video-password

cd /d "%~dp0"
if not exist .venv (
  py -3 -m venv .venv
  .venv\Scripts\pip install -r requirements.txt
)
REM In Mission Planner: Ctrl+F, "Mavlink", UDP Client, 127.0.0.1, port 14551.
.venv\Scripts\python field_relay.py --server %SERVER% --token %TOKEN% --msn %MSN% --model %MODEL% --rtsp %CAMERA% --video-pass %VIDEOPASS%
pause
