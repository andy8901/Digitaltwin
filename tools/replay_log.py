#!/usr/bin/env python3
"""Replay an ArduPilot dataflash log (.bin) as a live MAVLink stream, as if the drone were flying now.

Used to test and demonstrate the Live Twin without a real aircraft: the log's GPS, attitude, battery, EKF,
vibration, motor outputs, rangefinder/proximity, modes, arming, status messages and error events are turned
into the MAVLink messages ArduPilot sends to a ground station, at real speed (or faster with --speed).

    python tools/replay_log.py flight.bin --server ws://localhost:8080 --token change-me --msn 064 --model Tavas
    python tools/replay_log.py flight.bin --udp 127.0.0.1:14550 --sysid 3
    # also push a test video for this drone to MediaMTX:
    python tools/replay_log.py flight.bin ... --test-video rtsp://relay:PASS@localhost:8554/064
"""
import argparse
import asyncio
import math
import socket
import subprocess
import sys
import time

from pymavlink import mavutil
from pymavlink.dialects.v20 import ardupilotmega as mav2

ERR_TEXT = {  # (subsystem, code) -> STATUSTEXT ArduPilot would send; code 0 is the "cleared" message
    5: ("Radio Failsafe", "Radio Failsafe Cleared"),
    6: ("Battery 1 is low, battery failsafe", None),
    8: ("GCS Failsafe", "GCS Failsafe Cleared"),
    11: ("GPS Glitch", "GPS Glitch cleared"),
    12: ("Crash: Disarming", None),
    16: ("EKF variance", "EKF variance cleared"),
    17: ("EKF Failsafe", "EKF Failsafe Cleared"),
    25: ("Potential Thrust Loss", None),
}


def clamp16(v):
    return max(-32767, min(32767, int(v)))


class Buf:
    def __init__(self):
        self.data = bytearray()

    def write(self, b):
        self.data += b


def load(path):
    log = mavutil.mavlink_connection(path, robust_parsing=True)
    want = {"GPS", "POS", "ATT", "BAT", "CTUN", "XKF4", "NKF4", "VIBE", "RCOU", "RFND", "PRX", "MSG", "ERR", "EV", "ARM",
            "MODE", "PARM", "ORGN"}
    recs = []
    while True:
        m = log.recv_match(type=list(want))
        if m is None:
            break
        t = getattr(m, "TimeUS", None)
        if t is None:
            continue
        recs.append((t / 1e6, m))
    return recs


async def run(args):
    print(f"Reading {args.log} ...")
    recs = load(args.log)
    if not recs:
        sys.exit("No usable messages in the log.")
    params = {}
    arm_t = None
    first_arm_evt = None
    for t, m in recs:
        typ = m.get_type()
        if typ == "PARM":
            params[m.Name] = m.Value
        elif typ in ("EV", "ARM"):
            armed = (m.Id == 10) if typ == "EV" else bool(getattr(m, "ArmState", 0))
            disarmed = (m.Id == 11) if typ == "EV" else not armed
            if first_arm_evt is None and (armed or disarmed):
                first_arm_evt = "arm" if armed else "disarm"
            if arm_t is None and armed:
                arm_t = t
    # Logging usually starts at arming (LOG_DISARMED=0): if the first event is a disarm, it was armed from the start.
    start_armed = first_arm_evt == "disarm"
    if start_armed:
        arm_t = recs[0][0]
    t0 = recs[0][0]
    if arm_t is not None and args.lead is not None:
        t0 = max(t0, arm_t - args.lead)
    cap = params.get("BATT_CAPACITY") or 0
    print(f"{len(recs)} records, armed at {arm_t:.0f} s after boot" if arm_t else f"{len(recs)} records")

    out = Buf()
    mav = mav2.MAVLink(out, srcSystem=args.sysid, srcComponent=1)
    mav.robust_parsing = True

    sock = ws = None
    if args.udp:
        host, port = args.udp.rsplit(":", 1)
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        dest = (host, int(port))
    else:
        import websockets
        url = f"{args.server.rstrip('/')}/ws/ingest?token={args.token}&msn={args.msn}&model={args.model or ''}"
        ws = await websockets.connect(url, max_size=None)

    video = None
    if args.test_video:
        video = subprocess.Popen(
            ["ffmpeg", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25",
             "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
             "-g", "25", "-b:v", "1500k", "-f", "rtsp", "-rtsp_transport", "tcp", args.test_video])

    async def flush():
        if not out.data:
            return
        data = bytes(out.data)
        out.data.clear()
        if sock:
            for i in range(0, len(data), 1400):
                sock.sendto(data[i:i + 1400], dest)
        else:
            await ws.send(data)

    st = {"armed": False, "pending_arm": start_armed, "mode": 0, "lat": None, "lon": None, "alt": 0.0, "msl": 0.0, "home": None, "home_msl": None,
          "crs": 0.0, "spd": 0.0, "crt": 0.0, "tho": 0.0, "vz": 0.0}
    last = {}

    def due(key, t, hz):
        if t - last.get(key, -1e9) >= 1.0 / hz:
            last[key] = t
            return True
        return False

    def ms(t):
        return int(t * 1000) & 0xFFFFFFFF

    def text(sev, s):
        mav.send(mav.statustext_encode(sev, s.encode()[:50]))

    wall0 = time.time()
    flush_at = 0
    sent = 0
    for t, m in recs:
        if t < t0:
            # still apply state (mode, params) from before the replay window
            typ = m.get_type()
            if typ == "MODE":
                st["mode"] = m.ModeNum
            continue
        target = wall0 + (t - t0) / args.speed
        now = time.time()
        if target > now:
            await flush()
            await asyncio.sleep(target - now)
        typ = m.get_type()

        if st["pending_arm"] and st["lat"] is not None:
            st["pending_arm"] = False
            st["armed"] = True
            st["home"] = (st["lat"], st["lon"])
            st["home_msl"] = st["msl"]
            last.pop("hb", None)
        if due("hb", t, 1):
            base = mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED | (mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED if st["armed"] else 0)
            mav.send(mav.heartbeat_encode(mavutil.mavlink.MAV_TYPE_QUADROTOR, mavutil.mavlink.MAV_AUTOPILOT_ARDUPILOTMEGA,
                                          base, st["mode"], 4 if st["armed"] else 3))
            mav.send(mav.system_time_encode(int(time.time() * 1e6), ms(t)))
            if st["home"] and due("home", t, 0.1):
                mav.send(mav.home_position_encode(int(st["home"][0] * 1e7), int(st["home"][1] * 1e7), int((st["home_msl"] or 0) * 1000),
                                                  0, 0, 0, [1, 0, 0, 0], 0, 0, 0))

        if typ == "MODE":
            st["mode"] = m.ModeNum
        elif typ == "EV":
            if m.Id == 10:
                st["armed"] = True
                if st["lat"] is not None:
                    st["home"] = (st["lat"], st["lon"])
                    st["home_msl"] = st["msl"]
                last.pop("hb", None)
            elif m.Id == 11:
                st["armed"] = False
                last.pop("hb", None)
        elif typ == "ARM":
            a = bool(getattr(m, "ArmState", 0))
            if a != st["armed"]:
                st["armed"] = a
                if a and st["lat"] is not None:
                    st["home"] = (st["lat"], st["lon"])
                    st["home_msl"] = st["msl"]
                last.pop("hb", None)
        elif typ == "ATT" and due("att", t, 10):
            mav.send(mav.attitude_encode(ms(t), math.radians(m.Roll), math.radians(m.Pitch), math.radians(m.Yaw), 0, 0, 0))
        elif typ == "CTUN":
            st["tho"] = getattr(m, "ThO", 0) or 0
            st["crt"] = (getattr(m, "CRt", 0) or 0) / 100.0  # cm/s in the log
        elif typ == "GPS" and getattr(m, "I", 0) == 0:
            st["crs"], st["spd"] = m.GCrs, m.Spd
            if m.Status >= 3:
                st["lat"], st["lon"], st["msl"] = m.Lat, m.Lng, m.Alt
            if due("gps", t, 5):
                mav.send(mav.gps_raw_int_encode(int(t * 1e6), m.Status, int(m.Lat * 1e7), int(m.Lng * 1e7), int(m.Alt * 1000),
                                                int(m.HDop * 100), 65535, int(m.Spd * 100), int(m.GCrs * 100) % 36000, m.NSats))
                mav.send(mav.vfr_hud_encode(m.Spd, m.Spd, int(m.GCrs) % 360, int(st["tho"] * 100) if st["tho"] <= 1 else int(st["tho"]),
                                            st["alt"], st["crt"]))
        elif typ == "POS" and due("pos", t, 5):
            rel = getattr(m, "RelHomeAlt", None)
            if rel is None:
                rel = getattr(m, "RelOriginAlt", 0)
            st["alt"] = rel
            mav.send(mav.global_position_int_encode(ms(t), int(m.Lat * 1e7), int(m.Lng * 1e7), int(m.Alt * 1000), int(rel * 1000),
                                                    clamp16(st["spd"] * 100 * math.cos(math.radians(st["crs"]))),
                                                    clamp16(st["spd"] * 100 * math.sin(math.radians(st["crs"]))),
                                                    clamp16(-st["crt"] * 100), int(st["crs"] * 100) % 36000))
        elif typ == "BAT" and getattr(m, "Inst", getattr(m, "Instance", 0)) == 0 and due("bat", t, 2):
            used = getattr(m, "CurrTot", 0) or 0
            pct = getattr(m, "RemPct", None)
            if pct is None:
                pct = max(0, min(100, int(100 - used / cap * 100))) if cap else -1
            mav.send(mav.sys_status_encode(0, 0, 0, 500, int(m.Volt * 1000), int(m.Curr * 100), pct, 0, 0, 0, 0, 0, 0))
            mav.send(mav.battery_status_encode(0, 0, 0, 32767, [int(m.Volt * 1000)] + [65535] * 9, int(m.Curr * 100), int(used), -1, pct))
        elif typ in ("XKF4", "NKF4") and getattr(m, "C", 0) == 0 and due("ekf", t, 2):
            mav.send(mav.ekf_status_report_encode(0x1FF, abs(m.SV), abs(m.SP), abs(m.SH), abs(m.SM), 0))
        elif typ == "VIBE" and getattr(m, "IMU", 0) == 0 and due("vibe", t, 2):
            c0 = getattr(m, "Clip0", getattr(m, "Clip", 0))
            mav.send(mav.vibration_encode(int(t * 1e6), m.VibeX, m.VibeY, m.VibeZ, int(c0), int(getattr(m, "Clip1", 0)), int(getattr(m, "Clip2", 0))))
        elif typ == "RCOU" and due("rcou", t, 5):
            ch = [int(getattr(m, f"C{i}", 0) or 0) for i in range(1, 9)]
            mav.send(mav.servo_output_raw_encode(ms(t) * 1000 & 0xFFFFFFFF, 0, *ch))
        elif typ == "RFND":
            inst = getattr(m, "Instance", 0)
            if due(f"rfnd{inst}", t, 4):
                n = inst + 1
                mx = params.get(f"RNGFND{n}_MAX") or ((params.get(f"RNGFND{n}_MAX_CM") or 4000) / 100.0)
                stat = getattr(m, "Stat", 4)
                d = m.Dist
                if stat in (0, 1, 2):
                    pass  # not connected / no data / below minimum range (unreliable)
                else:
                    if stat == 3:      # out of range high: nothing in view
                        d = mx
                    orient = getattr(m, "Orient", mavutil.mavlink.MAV_SENSOR_ROTATION_PITCH_270)
                    mav.send(mav.distance_sensor_encode(ms(t), 20, int(mx * 100), int(d * 100), 0, inst, orient, 0))
        elif typ == "PRX" and due("prx", t, 2):
            up = getattr(m, "DUp", 0) or 0
            if up > 0:
                mav.send(mav.distance_sensor_encode(ms(t), 20, 4000, int(up * 100), 0, 0, mavutil.mavlink.MAV_SENSOR_ROTATION_PITCH_90, 0))
            for i in range(8):
                d = getattr(m, f"D{i * 45}", None)
                if d is None:
                    d = getattr(m, f"D{i}", None)
                if d is not None and d > 0:
                    mav.send(mav.distance_sensor_encode(ms(t), 20, 4000, int(d * 100), 0, 0, i, 0))
        elif typ == "MSG":
            s = m.Message
            sev = 2 if s.lower().startswith(("prearm", "arm:", "crash")) else 6
            text(sev, s)
        elif typ == "ERR":
            pair = ERR_TEXT.get(m.Subsys)
            if pair:
                s = pair[0] if m.ECode else pair[1]
                if s:
                    text(2 if m.ECode else 6, s)

        sent += 1
        if time.time() >= flush_at:
            await flush()
            flush_at = time.time() + 0.05
    await flush()
    print(f"Replay finished: {sent} records.")
    if ws:
        await asyncio.sleep(1)
        await ws.close()
    if video:
        video.terminate()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("log")
    ap.add_argument("--server", default="ws://localhost:8080", help="Live Twin server (ws:// or wss://)")
    ap.add_argument("--token", default="change-me", help="TWIN_INGEST_TOKEN of the server")
    ap.add_argument("--msn", default="SIM-1")
    ap.add_argument("--model", default="")
    ap.add_argument("--udp", help="send raw MAVLink over UDP to host:port instead of the WebSocket")
    ap.add_argument("--sysid", type=int, default=1)
    ap.add_argument("--speed", type=float, default=1.0, help="replay speed factor (2 = twice as fast)")
    ap.add_argument("--lead", type=float, default=30.0, help="start this many seconds before arming (default 30; -1 = whole log)")
    ap.add_argument("--test-video", help="also push a test pattern video to this rtsp:// URL")
    a = ap.parse_args()
    if a.lead is not None and a.lead < 0:
        a.lead = None
    asyncio.run(run(a))


if __name__ == "__main__":
    main()
