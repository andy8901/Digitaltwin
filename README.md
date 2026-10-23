# Neosky Live Twin

A live digital twin of every Neosky drone in the air, anywhere in the country. One web page shows:

- **Map:** every drone on a satellite or street map, with its real flight path, home point and heading. Drones flying, on the ground, with a lost link or offline are colour-coded.
- **Camera:** live video from the selected drone (WebRTC, about half a second of delay; HLS as a fallback).
- **Attitude twin:** a 3D model of the drone that rolls and pitches with the real aircraft. Its propellers spin with the real motor outputs, and a motor pod turns red when that motor is saturated.
- **ODS (obstacle detection):** a radar of the proximity sensors and rangefinders (8 sectors plus up and down), showing the nearest obstacle.
- **Readouts:** altitude, range from home, ground speed, climb rate, satellites, HDOP, GPS fix, link quality, battery voltage, current, battery %, mAh used, distance flown, EKF variance, vibration and throttle, all colour-coded against limits.
- **Charts:** altitude, voltage, satellites and current for the last 5 minutes.
- **This flight:** time since arming, cold-start time, and every failsafe or fault with the time, distance from home, altitude and voltage when it happened. Also shows the pre-arm failures.
- **Messages:** every status message from the autopilot (errors in red, warnings in amber).
- **Fleet statistics**, for all drones or one drone, all time / today / 7 / 30 days:
  - averages per flight: flight time, distance travelled, range achieved, altitude, max voltage, min voltage, current, cold-start time
  - failsafes: average flight time when the battery failsafe triggered (and the voltage then), and average distance from home when the GCS or RC failsafe triggered
  - number of flights with a crash, potential thrust loss, motor issue, GPS issue, EKF issue, pre-arm issue, high vibration, or each failsafe
  - total system errors, pilot errors and flights yet to decide (as set in Flight history)
  - flights recorded, telemetry logs, hours and km flown
- **Flight history:** every flight from arming to disarming. For each one you can:
  - replay its path on the map, with failsafes and the crash site marked
  - set the root cause (pilot error, system error or yet to decide)
  - download its telemetry log (.tlog), which opens in Mission Planner or MAVExplorer

The twin only listens. It never sends anything to an aircraft.

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
 drone ──radio──► GCS laptop (Mission Planner / QGC) ──forward──► field_relay.py ──wss://──► Live Twin server ──► browsers
 camera ──RTSP──────────────────────────────────────────────────► field_relay.py ──rtsp──► MediaMTX (video) ─┘
```

The **field relay** (`relay/field_relay.py`) runs on the ground-station laptop:

- It receives the MAVLink stream the GCS forwards to it and sends it to the server over an ordinary HTTPS WebSocket, so no port-forwarding is needed at the field.
- It pushes the camera's RTSP stream to the server's video service.
- Both reconnect on their own. Telemetry from the last 2 minutes of an internet drop is sent when the connection comes back.

## Server setup (Docker, recommended)

You need a small cloud VM with a public DNS name, for example `twin.neosky.in`.

```bash
cd live-twin
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
2. Copy the `relay` folder to the laptop. Edit the six lines at the top of `run_relay.bat`: server address, token, MSN, model, camera URL and video password.
3. In **Mission Planner** press `Ctrl+F` → **Mavlink** → choose **UDP Client**, host `127.0.0.1`, port `14551`, and leave *Write access* unticked.
   In **QGroundControl**: Application Settings → MAVLink → *Enable MAVLink forwarding* → `127.0.0.1:14551`.
4. Double-click `run_relay.bat`. Every 10 s it prints whether the server is connected, how many packets were sent and whether video is streaming.

Without a GCS, the relay can read the telemetry radio directly: `--mavlink COM5:57600`.

**Camera:** use the camera's RTSP address, for example `rtsp://192.168.144.25:8554/main.264` for SIYI cameras. Browsers play H.264 over WebRTC everywhere. If the camera sends H.265 or a very high bitrate, add `--transcode` (re-encodes to 720p H.264 at 1.5 Mbit/s) or set the camera to H.264.

## Try it without a drone

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
