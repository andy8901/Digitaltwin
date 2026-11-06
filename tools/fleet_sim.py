#!/usr/bin/env python3
"""Fleet simulator: 15 TAVAS drones, each behind its OWN simulated GCS link, with its own camera feed.

Used for Phase 1 (complete prototype on simulated data) and to test the command centre end to end without hardware.
Each simulated GCS connects separately to /ws/ingest?gcs=GCS-NN exactly like a real field relay, and sends the
MAVLink a TAVAS (ArduCopter) sends: heartbeat, attitude, position, GPS, battery, EKF, vibration, motor outputs,
ESC telemetry, temperatures, radio status, 6-sided obstacle sensors, mission progress and status texts.

Scripted situations (so every alert type and tile colour can be seen):
  TAVAS 03  starts with a weak battery: low battery, then a battery failsafe and RTL
  TAVAS 05  battery drains abnormally fast
  TAVAS 06  GPS degrades (few satellites, high HDOP, "GPS Glitch")
  TAVAS 08  powered on, on the ground (standby)
  TAVAS 09  its GCS link drops for 25 s mid-flight
  TAVAS 11  compass variance rises (compass inconsistency)
  TAVAS 13  motor 2 saturates and its ESC overheats
  TAVAS 14  camera feed drops for 30 s
  TAVAS 15  GCS never connects (offline)
  others    normal patrol missions

The status texts imitate ArduPilot's wording, but they are SIMULATED. Every simulated camera frame says "SIMULATED".

    python tools/fleet_sim.py --server ws://localhost:8080 --token <TWIN_INGEST_TOKEN> \
        [--video rtsp://relay:<TWIN_VIDEO_PUBLISH_PASS>@localhost:8554] [--codec h264|vp8] [--drones 15]
"""
import argparse
import asyncio
import math
import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

from pymavlink import mavutil
from pymavlink.dialects.v20 import ardupilotmega as mav2

M = mavutil.mavlink
COPTER = {"STABILIZE": 0, "ALT_HOLD": 2, "AUTO": 3, "GUIDED": 4, "LOITER": 5, "RTL": 6, "LAND": 9}
# Bengaluru-area sites (railway yards, police patrol areas)
SITES = [(13.0277, 77.5862), (12.9783, 77.5725), (13.0045, 77.5513), (12.9561, 77.7015), (12.9172, 77.6227),
         (13.0991, 77.5963), (12.9698, 77.7500), (13.0358, 77.6200), (12.8456, 77.6603), (13.0108, 77.6948),
         (12.9255, 77.5468), (13.0607, 77.4728), (12.9082, 77.4859), (13.1007, 77.6410), (12.9850, 77.6101)]


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def offset(lat, lon, north, east):
    return lat + north / 111320.0, lon + east / (111320.0 * math.cos(math.radians(lat)))


def dist_bearing(lat1, lon1, lat2, lon2):
    dn = (lat2 - lat1) * 111320.0
    de = (lon2 - lon1) * 111320.0 * math.cos(math.radians(lat1))
    return math.hypot(dn, de), (math.degrees(math.atan2(de, dn)) + 360) % 360


class Buf:
    def __init__(self):
        self.data = bytearray()

    def write(self, b):
        self.data += b


class SimDrone:
    def __init__(self, n, scenario):
        self.n = n
        self.scn = scenario
        self.rng = random.Random(n * 7919)
        self.home = SITES[(n - 1) % len(SITES)]
        self.lat, self.lon = self.home
        self.alt = 0.0
        self.vn = self.ve = self.vz = 0.0
        self.heading = self.rng.uniform(0, 360)
        self.roll = self.pitch = 0.0
        self.armed = False
        self.mode = "LOITER"
        self.batt = {3: 34.0, 5: 96.0}.get(n, self.rng.uniform(78, 100))
        self.mah = 0.0
        self.cells = 6
        self.boot = time.time() - self.rng.uniform(60, 200)
        self.phase = "ground"
        self.phase_t = time.time() + self.rng.uniform(5, 25) if scenario != "standby" else 1e18
        self.wps = []
        self.wp_i = 0
        self.cruise_alt = self.rng.choice([40, 50, 60, 70, 80])
        self.out = Buf()
        self.mav = mav2.MAVLink(self.out, srcSystem=1, srcComponent=1)
        self.last = {}
        self.texts = []
        self.compass_var = 0.05
        self.gps_bad = False
        self.motor_bad = False
        self.flights = 0
        self.esc_temp = 38.0
        self.t0 = time.time()

    # ------------------------------------------------------------ behaviour
    def say(self, sev, text):
        self.texts.append((sev, text))

    def plan_mission(self):
        r = self.rng.uniform(250, 650)
        start = self.rng.uniform(0, 360)
        k = self.rng.choice([4, 5, 6])
        self.wps = [offset(*self.home, r * math.cos(math.radians(start + i * 360 / k)), r * math.sin(math.radians(start + i * 360 / k))) for i in range(k)]
        self.wp_i = 0

    def step(self, dt, now):
        el = now - self.t0
        # scripted faults
        if self.scn == "gps" and self.phase == "auto" and el > 70 and not self.gps_bad:
            self.gps_bad = True
            self.say(2, "GPS Glitch")
        if self.scn == "compass" and self.armed and el > 60:
            self.compass_var = min(0.85, self.compass_var + 0.004 * dt * 10)
        if self.scn == "motor" and self.phase == "auto" and el > 80 and not self.motor_bad:
            self.motor_bad = True
        if self.motor_bad:
            self.esc_temp = min(76, self.esc_temp + dt * 0.6)

        if self.phase == "ground":
            self.alt, self.vn, self.ve, self.vz = 0.0, 0.0, 0.0, 0.0
            if now >= self.phase_t and self.batt > 40:
                self.plan_mission()
                self.armed = True
                self.mode = "GUIDED"
                self.say(6, "Arming motors")
                self.phase = "takeoff"
                self.flights += 1
            elif now >= self.phase_t and self.batt <= 40 and self.scn not in ("lowbatt",):
                self.batt = self.rng.uniform(92, 100)  # battery swap on the ground
                self.say(6, "Battery 1 replaced")
                self.phase_t = now + 20
            elif now >= self.phase_t and self.scn == "lowbatt":
                self.plan_mission()
                self.armed, self.mode, self.phase = True, "GUIDED", "takeoff"
                self.say(6, "Arming motors")
        elif self.phase == "takeoff":
            self.vz = 2.5
            self.vn = self.ve = 0
            if self.alt >= self.cruise_alt - 0.5:
                self.vz = 0
                self.mode = "AUTO"
                self.phase = "auto"
                self.say(6, "Mission: 1 WP")
        elif self.phase == "auto":
            tgt = self.wps[self.wp_i]
            self.fly_to(tgt, 9.0 if not self.gps_bad else 6.0, dt)
            d, _ = dist_bearing(self.lat, self.lon, *tgt)
            if d < 8:
                self.say(6, f"Reached command #{self.wp_i + 1}")
                self.mav.send(self.mav.mission_item_reached_encode(self.wp_i + 1))
                self.wp_i += 1
                if self.wp_i >= len(self.wps):
                    self.wp_i = 0
                    if self.scn not in ("lowbatt", "drain") and self.rng.random() < 0.5:
                        self.start_rtl("mission")
            if self.scn == "lowbatt" and self.batt < 22 and self.mode == "AUTO":
                self.say(2, f"Battery 1 is critical {self.cells * 3.42:.2f}V used {self.mah:.0f} mAh")
                self.start_rtl("failsafe")
            elif self.batt < 25 and self.mode == "AUTO" and self.scn != "lowbatt":
                self.start_rtl("mission")
            if self.scn == "gps" and self.gps_bad and el > 160:
                self.gps_bad = False
                self.say(6, "GPS Glitch cleared")
        elif self.phase == "rtl":
            d, _ = dist_bearing(self.lat, self.lon, *self.home)
            if d > 3:
                self.fly_to(self.home, 9.0, dt, keep_alt=True)
            else:
                self.vn = self.ve = 0
                self.mode = "LAND"
                self.phase = "land"
        elif self.phase == "land":
            self.vn = self.ve = 0
            self.vz = -1.5 if self.alt > 8 else -0.6
            if self.alt <= 0.05:
                self.alt = 0
                self.vz = 0
                self.armed = False
                self.mode = "LOITER"
                self.say(6, "Disarming motors")
                self.phase = "ground"
                self.phase_t = now + self.rng.uniform(25, 60)
        # integrate
        self.lat, self.lon = offset(self.lat, self.lon, self.vn * dt, self.ve * dt)
        self.alt = max(0.0, self.alt + self.vz * dt)
        # battery: about 35 min of flight on a full pack (compressed for the demo)
        if self.armed:
            rate = 100 / (35 * 60) * (4.5 if self.scn == "drain" else 1.8)  # compressed: ~19 min flights
            self.batt = max(0.0, self.batt - rate * dt)
            self.mah += (18 + 6 * math.hypot(self.vn, self.ve) / 9) * dt / 3.6
        # attitude follows motion
        speed = math.hypot(self.vn, self.ve)
        tgt_pitch = -clamp(speed / 10 * 14, 0, 18) if self.armed and self.alt > 1 else 0
        self.pitch += (tgt_pitch - self.pitch) * min(1, dt * 3)
        self.roll += ((self.rng.uniform(-2, 2) if self.alt > 1 else 0) - self.roll) * min(1, dt * 2)

    def fly_to(self, tgt, spd, dt, keep_alt=False):
        d, brg = dist_bearing(self.lat, self.lon, *tgt)
        diff = (brg - self.heading + 540) % 360 - 180
        turn = clamp(diff, -60 * dt, 60 * dt)
        self.heading = (self.heading + turn) % 360
        self.roll = clamp(turn / max(dt, 1e-3) / 60 * 18, -20, 20)
        v = min(spd, d / 2 + 0.5)
        self.vn = v * math.cos(math.radians(self.heading))
        self.ve = v * math.sin(math.radians(self.heading))
        self.vz = clamp((self.cruise_alt - self.alt) * 0.5, -2, 2)

    def start_rtl(self, why):
        self.mode = "RTL"
        self.phase = "rtl"
        if why == "failsafe":
            self.say(4, "Battery failsafe: RTL")

    # ------------------------------------------------------------ MAVLink
    def due(self, k, hz, now):
        if now - self.last.get(k, 0) >= 1 / hz:
            self.last[k] = now
            return True
        return False

    def packets(self, now):
        m = self.mav
        ms = int((now - self.boot) * 1000) & 0xFFFFFFFF
        speed = math.hypot(self.vn, self.ve)
        if self.due("hb", 1, now):
            base = M.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED | (M.MAV_MODE_FLAG_SAFETY_ARMED if self.armed else 0)
            m.send(m.heartbeat_encode(M.MAV_TYPE_QUADROTOR, M.MAV_AUTOPILOT_ARDUPILOTMEGA, base, COPTER[self.mode],
                                      M.MAV_STATE_ACTIVE if self.armed else M.MAV_STATE_STANDBY))
            m.send(m.system_time_encode(int(now * 1e6), ms))
        if self.due("att", 10, now):
            m.send(m.attitude_encode(ms, math.radians(self.roll), math.radians(self.pitch), math.radians(self.heading), 0, 0, 0))
        if self.due("pos", 5, now):
            m.send(m.global_position_int_encode(ms, int(self.lat * 1e7), int(self.lon * 1e7), int((self.alt + 900) * 1000), int(self.alt * 1000),
                                                int(self.vn * 100), int(self.ve * 100), int(-self.vz * 100), int(self.heading * 100)))
        if self.due("gps", 2, now):
            sats = self.rng.randint(4, 6) if self.gps_bad else self.rng.randint(16, 22)
            hdop = self.rng.uniform(2.6, 3.4) if self.gps_bad else self.rng.uniform(0.6, 0.9)
            m.send(m.gps_raw_int_encode(int(now * 1e6), 3, int(self.lat * 1e7), int(self.lon * 1e7), int((self.alt + 900) * 1000),
                                        int(hdop * 100), 65535, int(speed * 100), int(self.heading * 100), sats))
        if self.due("hud", 4, now):
            thr = 0 if not self.armed else int(clamp(48 + self.vz * 6 + speed * 0.8, 0, 100))
            m.send(m.vfr_hud_encode(speed, speed, int(self.heading), thr, self.alt, self.vz))
        if self.due("sys", 2, now):
            volt = self.cells * (3.45 + 0.75 * self.batt / 100) - (0.25 if self.armed else 0)
            cur = (16 + speed * 0.9 + max(0, self.vz) * 2 + self.rng.uniform(-0.6, 0.6)) if self.armed else 0.4
            sensors = (M.MAV_SYS_STATUS_SENSOR_3D_GYRO | M.MAV_SYS_STATUS_SENSOR_3D_ACCEL | M.MAV_SYS_STATUS_SENSOR_3D_MAG |
                       M.MAV_SYS_STATUS_SENSOR_ABSOLUTE_PRESSURE | M.MAV_SYS_STATUS_SENSOR_GPS | M.MAV_SYS_STATUS_SENSOR_MOTOR_OUTPUTS |
                       M.MAV_SYS_STATUS_SENSOR_RC_RECEIVER | M.MAV_SYS_STATUS_AHRS | M.MAV_SYS_STATUS_SENSOR_BATTERY | M.MAV_SYS_STATUS_SENSOR_PROXIMITY)
            health = sensors & ~(M.MAV_SYS_STATUS_SENSOR_GPS if self.gps_bad else 0) & ~(M.MAV_SYS_STATUS_SENSOR_3D_MAG if self.compass_var > 0.5 else 0)
            m.send(m.sys_status_encode(sensors, sensors, health, 320, int(volt * 1000), int(cur * 100), int(self.batt), 0, 0, 0, 0, 0, 0))
            m.send(m.battery_status_encode(0, 0, 0, int((31 + (6 if self.armed else 0)) * 100), [int(volt / self.cells * 1000)] * self.cells + [65535] * (10 - self.cells),
                                           int(cur * 100), int(self.mah), -1, int(self.batt)))
        if self.due("ekf", 1, now):
            m.send(m.ekf_status_report_encode(0x1FF, self.rng.uniform(0.05, 0.15), (0.6 if self.gps_bad else self.rng.uniform(0.05, 0.12)),
                                              self.rng.uniform(0.05, 0.1), self.compass_var, 0))
        if self.due("vib", 1, now):
            base = 6 if self.armed else 0.5
            m.send(m.vibration_encode(int(now * 1e6), base + self.rng.uniform(0, 3), base + self.rng.uniform(0, 3), base * 1.5 + self.rng.uniform(0, 4), 0, 0, 0))
        if self.due("srv", 4, now):
            if self.armed:
                hover = 1480 + int(self.vz * 25) + int(speed * 6)
                outs = [hover + self.rng.randint(-25, 25) for _ in range(4)]
                outs[0] += int(-self.pitch * 3)
                outs[2] += int(-self.pitch * 3)
                if self.motor_bad:
                    outs[1] = 1965
            else:
                outs = [1000] * 4
            m.send(m.servo_output_raw_encode(ms * 1000 & 0xFFFFFFFF, 0, *outs, 0, 0, 0, 0))
            self._outs = outs
        if self.due("esc", 1, now):
            outs = getattr(self, "_outs", [1000] * 4)
            rpm = [0 if o <= 1000 else int((o - 1000) * 9.5) for o in outs]
            temps = [int(self.esc_temp if (i == 1 and self.motor_bad) else 36 + (6 if self.armed else 0) + self.rng.randint(0, 3)) for i in range(4)]
            volts = [int(self.cells * 3.9 * 100)] * 4
            amps = [int((o - 1000) / 100 * 100) if o > 1000 else 0 for o in outs]
            m.send(m.esc_telemetry_1_to_4_encode(temps, volts, amps, [int(self.mah / 4)] * 4, rpm, [0] * 4))
        if self.due("press", 1, now):
            m.send(m.scaled_pressure_encode(ms, 1013.0 - self.alt * 0.12, 0, int((44 + (4 if self.armed else 0)) * 100)))
        if self.due("radio", 1, now):
            rssi = clamp(int(220 - self.dist_home() / 10 + self.rng.randint(-6, 6)), 60, 254)
            m.send(m.radio_status_encode(rssi, rssi - 10, 40, 42, 100, 0, 0))
            m.send(m.rc_channels_encode(ms, 8, *([1500] * 18), rssi))
        if self.due("home", 0.2, now):
            m.send(m.home_position_encode(int(self.home[0] * 1e7), int(self.home[1] * 1e7), 900000, 0, 0, 0, [1, 0, 0, 0], 0, 0, 0))
        if self.due("mis", 1, now) and self.wps:
            m.send(m.mission_current_encode(self.wp_i + 1, total=len(self.wps) + 1))
        if self.due("ods", 2, now):
            # 6-sided obstacle sensors: front, right, back, left (sectors), up, down
            for orient, base in ((0, 22), (2, 30), (4, 28), (6, 26)):
                d = clamp(base + self.rng.uniform(-3, 3) - (12 if (self.n % 4 == 0 and orient == 0 and self.alt < 25 and self.armed) else 0), 0.3, 40)
                m.send(m.distance_sensor_encode(ms, 30, 4000, int(d * 100), 0, orient, orient, 0))
            m.send(m.distance_sensor_encode(ms, 30, 4000, 4000, 0, 4, M.MAV_SENSOR_ROTATION_PITCH_90, 0))
            m.send(m.distance_sensor_encode(ms, 10, 4000, int(clamp(self.alt + 0.25, 0.1, 40) * 100), 0, 5, M.MAV_SENSOR_ROTATION_PITCH_270, 0))
        while self.texts:
            sev, text = self.texts.pop(0)
            m.send(m.statustext_encode(sev, text.encode()[:50]))
        data = bytes(self.out.data)
        self.out.data.clear()
        return data

    def dist_home(self):
        return dist_bearing(self.lat, self.lon, *self.home)[0]


SCENARIOS = {3: "lowbatt", 5: "drain", 6: "gps", 8: "standby", 9: "linkdrop", 11: "compass", 13: "motor", 14: "videodrop", 15: "offline"}


async def run_gcs(args, drone):
    """One independent simulated GCS link."""
    import websockets
    if drone.scn == "offline":
        return
    url = f"{args.server.rstrip('/')}/ws/ingest?token={args.token}&gcs=GCS-{drone.n:02d}"
    last = time.time()
    dropped = False
    while True:
        try:
            async with websockets.connect(url, max_size=None) as ws:
                async def reader():
                    async for msg in ws:
                        if isinstance(msg, str) and msg.startswith("ping "):
                            await ws.send("pong " + msg[5:])
                rt = asyncio.ensure_future(reader())
                while True:
                    await asyncio.sleep(0.05)
                    now = time.time()
                    drone.step(now - last, now)
                    last = now
                    data = drone.packets(now)
                    if drone.scn == "linkdrop" and not dropped and drone.phase == "auto" and now - drone.t0 > 90:
                        dropped = True
                        rt.cancel()
                        await ws.close()
                        print(f"[sim] GCS {drone.n:02d}: link dropped for 25 s")
                        t_end = time.time() + 25
                        while time.time() < t_end:   # the drone keeps flying while its GCS link is down
                            await asyncio.sleep(0.1)
                            now = time.time()
                            drone.step(now - last, now)
                            last = now
                            drone.packets(now)
                        break
                    if data:
                        await ws.send(data)
        except Exception as e:
            print(f"[sim] GCS {drone.n:02d}: {e}; reconnecting")
            await asyncio.sleep(2)


# ---------------------------------------------------------------- simulated cameras
def make_clips(folder, n_drones, codec):
    ff = shutil.which("ffmpeg")
    if not ff:
        sys.exit("ffmpeg is needed for the simulated camera feeds")
    folder.mkdir(parents=True, exist_ok=True)
    font = next((f for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "C:/Windows/Fonts/arialbd.ttf",
                             "/System/Library/Fonts/Supplemental/Arial Bold.ttf") if os.path.exists(f)), None)
    ext = "mkv"
    enc = (["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "{br}", "-g", "25"] if codec == "vp8" else
           ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-b:v", "{br}", "-g", "25", "-bf", "0"])
    clips = {}
    for n in range(1, n_drones + 1):
        for sub, size, br in ((False, "960x540", "900k"), (True, "384x216", "180k")):
            out = folder / f"tavas{n:02d}{'_sub' if sub else ''}_{codec}.{ext}"
            clips[(n, sub)] = out
            if out.exists():
                continue
            txt = f"TAVAS {n:02d}  SIMULATED CAMERA"
            hue = (n * 37) % 360
            draw = (f",drawtext=fontfile='{font}':text='{txt}':fontcolor=white:fontsize=h/12:x=(w-tw)/2:y=h*0.08:box=1:boxcolor=black@0.55:boxborderw=12"
                    if font else "")
            vf = f"hue=h={hue}:s=0.55,scale={size}{draw}"
            cmd = [ff, "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=25:duration=20", "-vf", vf,
                   *[x.format(br=br) for x in enc], str(out)]
            subprocess.run(cmd, check=True)
    return clips


def push_video(ff_clip, url):
    return subprocess.Popen(["ffmpeg", "-loglevel", "error", "-re", "-stream_loop", "-1", "-i", str(ff_clip), "-c", "copy", "-an",
                             "-f", "rtsp", "-rtsp_transport", "tcp", url], stdin=subprocess.DEVNULL)


async def run_video(args, drones):
    folder = Path(args.clips)
    clips = await asyncio.to_thread(make_clips, folder, len(drones), args.codec)
    procs = {}
    t0 = time.time()
    while True:
        for d in drones:
            if d.scn == "offline":
                continue
            for sub in (False, True):
                k = (d.n, sub)
                down = d.scn == "videodrop" and 100 < time.time() - t0 < 130
                p = procs.get(k)
                if down:
                    if p and p.poll() is None:
                        p.terminate()
                        print(f"[sim] TAVAS {d.n:02d}: camera feed stopped for 30 s")
                    procs.pop(k, None)
                    continue
                if p is None or p.poll() is not None:
                    procs[k] = push_video(clips[k], f"{args.video.rstrip('/')}/tavas-{d.n:02d}{'_sub' if sub else ''}")
        await asyncio.sleep(2)


async def main_async(args):
    drones = [SimDrone(n, SCENARIOS.get(n, "normal") if not args.no_faults else "normal") for n in range(1, args.drones + 1)]
    tasks = [run_gcs(args, d) for d in drones]
    if args.video:
        tasks.append(run_video(args, drones))
    print(f"[sim] {len(drones)} simulated GCS links -> {args.server}" + (f", video -> {args.video}" if args.video else ""))
    await asyncio.gather(*tasks)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", default="ws://localhost:8080")
    ap.add_argument("--token", default="change-me")
    ap.add_argument("--drones", type=int, default=15)
    ap.add_argument("--video", help="MediaMTX publish base, e.g. rtsp://relay:PASS@localhost:8554")
    ap.add_argument("--codec", default="h264", choices=["h264", "vp8"])
    ap.add_argument("--clips", default=str(Path(__file__).resolve().parent.parent / "data" / "sim_clips"))
    ap.add_argument("--no-faults", action="store_true", help="all drones fly normal missions")
    try:
        asyncio.run(main_async(ap.parse_args()))
    except KeyboardInterrupt:
        print("Simulator stopped.")


if __name__ == "__main__":
    main()
