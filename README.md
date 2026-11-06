# TAVAS Digital Twin Command Centre

One control-room application that watches **15 TAVAS drones at once**. Each drone has its own ground station (GCS 01 → TAVAS 01 … GCS 15 → TAVAS 15); the command centre collects telemetry and video from every GCS independently and shows them together.

> **Status: Phase 1 prototype.** Everything below runs today against the included 15-drone simulator. It is **not production-ready** until it has been connected to the real TAVAS GCS units and tested with several drones flying at once. The GCS protocol of the TAVAS handheld controller has not been verified yet (see *Connecting the ground stations*).

**Monitoring only.** The command centre never sends commands to a drone and never writes to a GCS. Any future command interface would have to be built and safety-validated separately.

## Sections

| Section | What it shows |
|---|---|
| **Fleet Overview** | 5 × 3 tiles, one per drone: live video, status, battery, altitude, ground speed, GPS, signal, mode, flight time, link and a warning badge. Tile colour: green normal, blue airborne, yellow warning, red critical, grey offline. The top bar counts total / airborne / on ground / warnings / critical / disconnected, average battery and the fleet's flight time today. |
| **Live Video Wall** | All 15 feeds in a 5 × 3 grid, each independent (one feed failing never stops the others). Click a feed to enlarge it, open its digital twin, go full screen, or go back to the grid. Unavailable feeds are marked. The wall uses each camera's low-bitrate sub-stream when one is set up, and feeds scrolled off screen pause. |
| **Drone Digital Twin** | One drone in detail: full-screen video with ID, timestamp, recording and measured latency; a 3D model of the TAVAS that follows pitch, roll and yaw (drag to rotate, scroll to zoom) with motor outputs and direction of travel; every telemetry value; battery / voltage / altitude / speed / signal charts; a map with position, home, take-off point, trajectory, geofence and the other drones; open alerts, flight-controller messages, component health and obstacle-sensor (ODS) distances. |
| **Fleet Map** | All drones on one map with their trajectories, homes and geofences. |
| **Alerts & Notifications** | Open and past alerts with drone, GCS, message, severity, time, position, the parameter that triggered it, its source and acknowledgement. Critical alerts flash in a banner until someone acknowledges them. Clicking an alert opens that drone. |
| **Fleet Health** | A score per drone from the components it actually reports (battery, motors, ESC, GPS, flight controller, link, camera, sensors, temperature). Components without data are shown as "no data" and left out of the score. |
| **GCS Connections** | Each GCS's adapter, connection state, last data, telemetry round-trip, data rate, link quality, video stream and 24-hour disconnection history. |
| **Flight History** | Every flight per drone with take-off, landing, duration, altitude, speed, battery used, mission completion, events and root cause; per-flight map replay, PDF report and telemetry CSV. |
| **Analytics & Reports** | Flight hours, distance and alerts by drone and by type; fleet PDF report; flight and alert CSV exports. |
| **Demo Planner** | Checks a customer's demo site against DGCA zones, obstacles, terrain and weather and suggests the safest flying direction (see below). |
| **System Settings** | Per-GCS adapter and video settings, alert thresholds, users and roles. |

### Where alerts come from

Alerts are never invented. Each one has a `source`:

- **flight controller**: the autopilot's own STATUSTEXT message, quoted as sent (failsafes, EKF/compass/GPS errors, crash and thrust-loss messages, severity ERROR or worse);
- **threshold rule**: a measured value crossing a limit set in *System settings → Alert thresholds* (battery %, cell voltage, satellites, HDOP, link and RSSI, telemetry and video loss, discharge rate, ESC/motor temperature, compass variance, attitude, descent rate, geofence, saturated motor output). The alert shows the parameter, its value and the limit.

Condition alerts clear themselves when the value recovers; critical alerts stay listed until acknowledged.

### Roles

| Role | Can |
|---|---|
| viewer | watch everything |
| operator | also acknowledge alerts, set flight root causes, use the demo planner, reconnect a GCS adapter |
| admin | also change GCS adapters, thresholds and users |

Users are stored in the database. On the first start, the users from `TWIN_PASSWORD` / `TWIN_USERS` are created (the first is admin).

## Connecting the ground stations

Each of the 15 slots has its own **telemetry adapter** and **video source**, set in *System settings → Fleet & GCS adapters*. Every adapter runs on its own; a GCS that drops out or sends bad data never affects the others, and the app reconnects by itself.

| Adapter | Status | Use when |
|---|---|---|
| Field relay (WebSocket) | tested with the 15-drone simulator; not yet with a real GCS | the GCS forwards MAVLink to `relay/field_relay.py` (Mission Planner, QGroundControl, or a telemetry radio on a laptop) |
| MAVLink over UDP | tested with a MAVLink test sender; not yet with a real GCS | the GCS sends MAVLink straight to the server over a LAN/VPN (port 14600 + slot number) |
| MAVLink over TCP | tested with a MAVLink test server; not yet with a real GCS | the GCS offers a MAVLink TCP server |
| REST / manufacturer protocol | **awaiting protocol verification** | placeholders: they show as "Awaiting protocol verification" and stay off until the GCS maker's protocol is documented and tested |

| Video source | |
|---|---|
| Pushed by the field relay | the relay pushes the camera's RTSP (and optional sub-stream) to the video server |
| Pull RTSP | the video server pulls the camera or GCS RTSP address directly |

**Not yet verified:** which app runs on the TAVAS 7-inch handheld GCS, whether it can forward MAVLink, and the camera's RTSP address. These must be confirmed on real hardware before field use.

## Try it with 15 simulated drones

```bash
pip install -r requirements.txt
mediamtx deploy/mediamtx-local.yml &                 # MediaMTX v1.9.3
TWIN_INGEST_TOKEN=tok TWIN_VIDEO_PUBLISH_PASS=vpub uvicorn twin.app:app --port 8080 &
python tools/fleet_sim.py --server ws://127.0.0.1:8080 --token tok --video rtsp://relay:vpub@127.0.0.1:8554
```

The simulator opens 15 separate GCS connections and 15 camera streams (test patterns labelled "SIMULATED CAMERA"). Each drone takes off, flies a patrol and returns. Some slots play scenarios so every alert path can be seen: 03 low battery, 05 fast discharge, 06 GPS degradation, 08 stays on the ground, 09 telemetry drop, 11 compass inconsistency, 13 motor failure, 14 video drop, 15 never connects. Use `--no-faults` for a clean fleet.

## Web interface source

The interface is a React + TypeScript app in `frontend/` (Three.js for the 3D model, Leaflet for maps). A built copy is committed in `twin/static/cc`, so the server runs without Node. After changing the interface:

```bash
cd frontend && npm ci && npm run build      # type-checks, then writes twin/static/cc
```

The Docker image builds it automatically.

## Demo planner

The **Demo planner** button checks a customer's demo site before you travel. Paste the coordinates the customer sent: decimal (`12.9716, 77.5946`), degrees-minutes-seconds, or a Google Maps link. You can also click the map. Then choose the demo date and time and the flight height.

| What it shows | How |
|---|---|
| **DGCA zone** at the take-off point (red / yellow / green) and the height that stays green | Estimated from the Drone Airspace Map rules (Drone Rules 2021) and public data; see the table below |
| **Best direction to fly** | 16 directions around the take-off point are scored on the factors listed after this table |
| **Demo route** inside the best direction | Climb-out, out to the demo point (10 s hold), a short camera sweep, return. Shows distance, flight time and battery use, and downloads as a Mission Planner `.waypoints` or QGroundControl `.plan` file |
| **Drone limits on the day** | Launch altitude, height, wind at 10/120 m and gusts, temperature, rain, visibility and daylight, checked against the drone's spec sheet (`twin/data/drone_profiles.json`, TAVAS from the Neosky spec sheet). Also shows the calmest dry window that day |
| **Verdict** | Good to fly / Fly with care / Permission needed / Do not fly, with the reasons |

Each of the 16 directions is scored on:

- how far it stays green at the planned height
- obstacles within 20 m of the flight height: buildings with their heights, masts, towers, chimneys
- power lines, which are thin wires that obstacle sensors can miss
- anything over 10 m on the climb-out
- roads and railways (don't hover over traffic) and crowds (schools, hospitals, temples, markets, stadiums)
- building density (emergency landing spots), water and trees
- terrain rise
- wind: flying out into the wind keeps the return leg downwind
- sun glare on the camera

Every check is saved under *Saved sites*.

**Your restricted areas** are added under the planner and used for every site. Add a circle, or import polygons as GeoJSON or KML. Use this for areas the planner can't know about, such as a red zone you saw on DigitalSky or a customer's no-fly area.

**Zone rules used (estimates — always confirm on [DigitalSky](https://digitalsky.dgca.gov.in)):**

| Rule | Zone |
|---|---|
| Operational airport (and military aerodromes), 0–5 km from the perimeter | red (treated as no-fly) |
| 5–8 km from the perimeter | yellow (ATC permission) |
| 8–12 km from the perimeter | green up to 200 ft / 60 m (the planner lowers the flight height to stay green) |
| Elsewhere | green up to 400 ft / 120 m |
| Airstrips without scheduled service, within 5 km; heliports within 2 km | yellow (confirm on DigitalSky) |
| International border / LoC / LAC, within 25 km | red; 25–35 km yellow because the public border lines can be a few km off |
| Vijay Chowk, New Delhi, within 5 km | red |
| Military areas, nuclear plants and government seats in OpenStreetMap | red inside, yellow (verify) nearby |

The airport perimeter is approximated as 500 m around the runways (OurAirports data, bundled in `twin/data/airspace_india.json`; refresh it with `python tools/build_airspace_data.py`).

**Internet access:** the server needs outbound internet for live data:

- obstacles: OpenStreetMap via the Overpass API (set `TWIN_OVERPASS_URL` to use your own server)
- terrain and weather: Open-Meteo

If a source can't be reached, the plan says what wasn't checked and carries on.

**Data credits:**

- map data © OpenStreetMap contributors (ODbL)
- weather and elevation by Open-Meteo.com (CC BY 4.0)
- airports from OurAirports (public domain)
- borders from Natural Earth (public domain)

## How the data gets there

```
 drone ──radio──► GCS NN (Mission Planner / QGC) ──forward──► field_relay.py --gcs "GCS NN" ──wss://──► command centre ──► browsers
 camera ──RTSP──────────────────────────────────────────────────► field_relay.py ──rtsp──► MediaMTX (video) ─┘
```

The **field relay** (`relay/field_relay.py`) runs on the ground-station laptop:

- It receives the MAVLink stream the GCS forwards to it and sends it to the server over an ordinary HTTPS WebSocket, so no port-forwarding is needed at the field.
- It pushes the camera's RTSP stream to the server's video service.
- Both reconnect on their own. Telemetry from the last 2 minutes of an internet drop is sent when the connection comes back.

## Server setup (Docker, recommended)

You need a small cloud VM with a public DNS name, for example `twin.neosky.in`.

```bash
cp .env.example .env        # set every password/secret, TWIN_DOMAIN and PUBLIC_HOST to your DNS name
docker compose up -d --build
```

Open these ports in the firewall:

| Port | Used for |
|---|---|
| 80, 443 | the web page and the relays (Caddy gets the HTTPS certificate automatically) |
| 8554/tcp | relays publish camera video |
| 8189/udp and tcp | live video to browsers (WebRTC) |

Sign in at `https://twin.neosky.in` with `admin` and `TWIN_PASSWORD`, or with the users in `TWIN_USERS`.

Run **one** app process only, because live drone state is kept in memory. Recorded flights, tracks, messages and .tlog files are kept in the `twin-data` volume (`data/` without Docker).

### Without Docker (one PC, testing)

```bash
pip install -r requirements.txt
uvicorn twin.app:app --host 0.0.0.0 --port 8080            # Windows: run_windows.bat
mediamtx deploy/mediamtx-local.yml                         # video; MediaMTX v1.9.3 from github.com/bluenviron/mediamtx/releases
```

## Field laptop setup (once per laptop)

1. Install Python 3.10 or newer and ffmpeg (`winget install ffmpeg`).
2. Copy the `relay` folder to the laptop. Edit the lines at the top of `run_relay.bat`: server address, token, GCS name (`GCS 01` … `GCS 15`), camera URL, optional sub-stream and video password.
3. In **Mission Planner** press `Ctrl+F` → **Mavlink** → choose **UDP Client**, host `127.0.0.1`, port `14551`, and leave *Write access* unticked.
   In **QGroundControl**: Application Settings → MAVLink → *Enable MAVLink forwarding* → `127.0.0.1:14551`.
4. Double-click `run_relay.bat`. Every 10 s it prints whether the server is connected, how many packets were sent and whether video is streaming.

Without a GCS, the relay can read the telemetry radio directly: `--mavlink COM5:57600`.

**Camera:** use the camera's RTSP address, for example `rtsp://192.168.144.25:8554/main.264` for SIYI cameras. Browsers play H.264 over WebRTC everywhere. If the camera sends H.265 or a very high bitrate, add `--transcode` (re-encodes to 720p H.264 at 1.5 Mbit/s) or set the camera to H.264.

## Replay a real flight log

`tools/replay_log.py` plays an ArduPilot `.bin` log as if the drone were flying now. It turns GPS, attitude, battery, EKF, vibration, motor outputs, proximity/rangefinders, modes, arming, messages and error events into live MAVLink:

```bash
python tools/replay_log.py flight.bin --server ws://localhost:8080 --token <TWIN_INGEST_TOKEN> --msn 064 --model Tavas --speed 2
# add a test-pattern camera:  --test-video rtsp://relay:<TWIN_VIDEO_PUBLISH_PASS>@localhost:8554/064
# or feed the relay like a GCS would:  --udp 127.0.0.1:14551
```

## How the figures are worked out

| Figure | How |
|---|---|
| Flight | from arming to disarming (HEARTBEAT armed flag); the flight time uses the autopilot's own clock |
| Distance travelled | sum of GPS steps while armed (jumps over 150 m ignored) |
| Range achieved | farthest distance from home (HOME_POSITION, or where it armed) |
| Altitude | highest height above home in the flight |
| Max / min voltage, current | battery readings while armed (SYS_STATUS) |
| Cold-start time | autopilot time since power-on at the moment of arming |
| Battery / GCS / RC failsafe | the autopilot's failsafe messages; the flight time, distance from home and voltage at that moment are recorded |
| Potential thrust loss, crash | ArduPilot's "Potential Thrust Loss" and "Crash: Disarming" messages |
| Motor issue | one motor output at 1900 µs or more and 300 µs above the others for 1 s while airborne |
| GPS issue | less than a 3D fix, fewer than 6 satellites or HDOP over 2.5 for 3 s, or a GPS glitch message |
| EKF issue | an EKF variance of 0.8 or more for 2 s (ArduPilot's EKF failsafe level), or an EKF failsafe message |
| Pre-arm issue | "PreArm:" / "Arm:" messages before the flight |
| High vibration | vibration over 60 m/s² for 2 s, or more than 50 accelerometer clipping events |

## Security notes

- Viewers need a login. Video goes through the app, so the camera feeds are protected by the same login.
- Relays need `TWIN_INGEST_TOKEN` (sent over HTTPS) to send telemetry. Video publishing needs `TWIN_VIDEO_PUBLISH_PASS`.
- RTSP publishing is not encrypted. For sensitive missions, run the relays over a VPN (for example WireGuard) or switch MediaMTX to RTSPS.
- The optional raw-UDP input (`TWIN_UDP_PORT`) has no authentication. Only use it on a LAN or VPN.
