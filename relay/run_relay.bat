@echo off
REM TAVAS Digital Twin field relay for one ground station (GCS 01 ... GCS 15). Edit the lines below once per GCS.
REM The relay only listens to the GCS and forwards to the command centre; it never sends anything to the drone.
set SERVER=wss://twin.example.com
set TOKEN=change-this-ingest-token
set GCS=GCS 01
set CAMERA=rtsp://192.168.144.25:8554/main.264
REM Optional low-bitrate stream for the video wall (leave empty if the camera has none)
set CAMERA_SUB=
set VIDEOPASS=change-this-video-password

cd /d "%~dp0"
if not exist .venv (
  py -3 -m venv .venv
  .venv\Scripts\pip install -r requirements.txt
)
set SUBARG=
if not "%CAMERA_SUB%"=="" set SUBARG=--rtsp-sub %CAMERA_SUB%
REM In Mission Planner: Ctrl+F, "Mavlink", UDP Client, 127.0.0.1, port 14551.
.venv\Scripts\python field_relay.py --server %SERVER% --token %TOKEN% --gcs "%GCS%" --rtsp %CAMERA% %SUBARG% --video-pass %VIDEOPASS%
pause
