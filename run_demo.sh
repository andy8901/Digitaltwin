#!/usr/bin/env bash
# TAVAS Digital Twin - local demo (macOS / Linux): the command centre plus 15 SIMULATED drones.
# Needs Python 3.10+ and internet in your browser (satellite map, 3D terrain). Ctrl+C stops everything.
set -e
cd "$(dirname "$0")"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -r requirements.txt; }
export TWIN_DATA_DIR="$PWD/demo_data" TWIN_PASSWORD=demo TWIN_SECRET_KEY=local-demo TWIN_INGEST_TOKEN=demo-token TWIN_VIDEO_PUBLISH_PASS=demo-video
.venv/bin/uvicorn twin.app:app --host 127.0.0.1 --port 8080 & SRV=$!
sleep 5
.venv/bin/python tools/fleet_sim.py --server ws://127.0.0.1:8080 --token demo-token & SIM=$!
trap 'kill $SIM $SRV 2>/dev/null' EXIT
echo "Open http://localhost:8080/#/monitor/TAVAS-04   (user admin, password demo)"
(command -v xdg-open >/dev/null && xdg-open "http://localhost:8080/#/monitor/TAVAS-04") || (command -v open >/dev/null && open "http://localhost:8080/#/monitor/TAVAS-04") || true
wait
