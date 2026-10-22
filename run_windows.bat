@echo off
REM Run the Live Twin server on a Windows PC (for a single site / testing). Uses the settings in .env.
cd /d "%~dp0"
if not exist .venv (
  py -3 -m venv .venv
  .venv\Scripts\pip install -r requirements.txt
)
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  echo %%a| findstr /r "^#" >nul || if not "%%a"=="" set "%%a=%%b"
)
echo Starting Neosky Live Twin on http://localhost:8080
echo (start MediaMTX separately for video: mediamtx.exe deploy\mediamtx-local.yml)
.venv\Scripts\uvicorn twin.app:app --host 0.0.0.0 --port 8080
