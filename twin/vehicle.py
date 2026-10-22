"""Live state of each drone, built from its MAVLink stream (ArduPilot), plus flight recording.

Every packet that arrives (through a field relay or over UDP) goes to Hub.feed(). The hub finds the drone by
its MSN (given by the relay) or by its MAVLink system id, and the drone updates its state, detects events
(failsafes, GPS/EKF problems, thrust loss, crash, pre-arm failures) and records the flight from arming to
disarming: summary figures, a 1 Hz track, all status messages, and a .tlog of the raw stream that can be
opened in Mission Planner afterwards.

The twin is read-only: nothing is ever sent back to the aircraft.
"""
import math
import re
import struct
import time
from collections import deque
from datetime import datetime

from pymavlink import mavutil
from pymavlink.dialects.v20 import ardupilotmega as mavlink  # MAVLink 2 parser (also reads MAVLink 1 packets)

from . import config

NON_VEHICLE_TYPES = {
    mavlink.MAV_TYPE_GCS, mavlink.MAV_TYPE_GIMBAL, mavlink.MAV_TYPE_CAMERA, mavlink.MAV_TYPE_ADSB,
    mavlink.MAV_TYPE_ONBOARD_CONTROLLER, mavlink.MAV_TYPE_ANTENNA_TRACKER,
}

# STATUSTEXT patterns sent by ArduPilot (case-insensitive). "cleared/resolved" messages are ignored.
CLEARED = re.compile(r"clear|resolved|recovered|\boff\b", re.I)
PATTERNS = [
    ("crash", re.compile(r"crash|parachute released", re.I)),
    ("thrust_loss", re.compile(r"thrust loss", re.I)),
    ("battery_fs", re.compile(r"\bbatt(ery)?\b.*\b(low|critical|failsafe)\b|low batt", re.I)),
    ("gcs_fs", re.compile(r"\bgcs\b.*failsafe|failsafe.*\bgcs\b|lost gcs", re.I)),
    ("rc_fs", re.compile(r"\b(radio|rc|throttle)\b.*failsafe|failsafe.*\b(radio|rc)\b", re.I)),
    ("ekf_issue", re.compile(r"ekf.*(variance|failsafe)|\bekf\b.*(bad|unhealthy)", re.I)),
    ("gps_issue", re.compile(r"gps glitch|lost gps|gps.*(lost|bad)|no gps", re.I)),
    ("vibration_issue", re.compile(r"vibration compensation on|high vibration", re.I)),
]
PREARM = re.compile(r"^(pre-?arm|arm):", re.I)

SEV_NAMES = ["EMERGENCY", "ALERT", "CRITICAL", "ERROR", "WARNING", "NOTICE", "INFO", "DEBUG"]


def haversine(a, b):
    if not a or not b or None in a[:2] or None in b[:2]:
        return None
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(min(1, h)))


def _r(v, n=1):
    return None if v is None else round(v, n)


class Episode:
    """Debounced condition: becomes an 'episode' after being true for `hold` seconds; re-arms after `release`."""

    def __init__(self, hold, release=5.0):
        self.hold, self.release = hold, release
        self.since = None
        self.clear_since = None
        self.active = False

    def update(self, cond, t):
        """Returns True exactly when a new episode starts."""
        if cond:
            self.clear_since = None
            if self.since is None:
                self.since = t
            if not self.active and t - self.since >= self.hold:
                self.active = True
                return True
        else:
            self.since = None
            if self.active:
                if self.clear_since is None:
                    self.clear_since = t
                elif t - self.clear_since >= self.release:
                    self.active = False
        return False


class Flight:
    def __init__(self, fid, drone, start_wall, start_boot):
        self.id = fid
        self.start_wall = start_wall
        self.start_boot = start_boot
        self.cold_start_s = _r(start_boot, 1) if start_boot is not None else None
        self.distance = 0.0
        self.max_range = 0.0
        self.max_alt = 0.0
        self.max_speed = 0.0
        self.v_max = None
        self.v_min = None
        self.cur_sum = 0.0
        self.cur_n = 0
        self.mah_start = None
        self.mah = None
        self.min_sats = None
        self.max_hdop = None
        self.max_vibe = 0.0
        self.clip_start = None
        self.clip = 0
        self.events = []
        self.flags = {k: False for k, _ in PATTERNS}
        self.flags["motor_issue"] = False
        self.counts = {k: 0 for k in self.flags}
        self.prearm = list(drone.prearm_seen)
        self.last_pos = None
        self.pending_pts = []
        self.last_pt_t = -1e9
        self.home = drone.home
        self.modes = [drone.mode] if drone.mode else []
        self.end_reason = None
        self.tlog = None
        self.tlog_path = None
        self.gps_ep = Episode(3.0)
        self.ekf_ep = Episode(2.0)
        self.motor_ep = Episode(1.0)
        self.vibe_ep = Episode(2.0)

    def elapsed(self, drone):
        if self.start_boot is not None and drone.boot_s is not None and drone.boot_s >= self.start_boot:
            return drone.boot_s - self.start_boot
        return time.time() - self.start_wall

    def summary(self, drone):
        ev = self.events

        def first(kind, key):
            for e in ev:
                if e["type"] == kind and e.get(key) is not None:
                    return e[key]
            return None

        bat_t = first("battery_fs", "t")
        return {
            "flight_time_min": _r(self.elapsed(drone) / 60, 2),
            "distance_m": _r(self.distance, 0),
            "range_m": _r(self.max_range, 0),
            "max_alt_m": _r(self.max_alt, 1),
            "max_speed_ms": _r(self.max_speed, 1),
            "max_voltage": _r(self.v_max, 2),
            "min_voltage": _r(self.v_min, 2),
            "avg_current": _r(self.cur_sum / self.cur_n, 1) if self.cur_n else None,
            "mah_used": _r(self.mah - self.mah_start, 0) if self.mah is not None and self.mah_start is not None else None,
            "cold_start_s": self.cold_start_s,
            "min_sats": self.min_sats,
            "max_hdop": _r(self.max_hdop, 2),
            "max_vibe": _r(self.max_vibe, 1),
            "clipping": self.clip,
            "crash": self.flags["crash"],
            "battery_fs": self.flags["battery_fs"],
            "battery_fs_t_min": _r(bat_t / 60, 2) if bat_t is not None else None,
            "battery_fs_voltage": first("battery_fs", "voltage"),
            "gcs_fs": self.flags["gcs_fs"],
            "gcs_fs_dist_m": first("gcs_fs", "dist_m"),
            "rc_fs": self.flags["rc_fs"],
            "rc_fs_dist_m": first("rc_fs", "dist_m"),
            "thrust_loss": self.flags["thrust_loss"],
            "motor_issue": self.flags["motor_issue"],
            "gps_issue": self.flags["gps_issue"],
            "ekf_issue": self.flags["ekf_issue"],
            "vibration_issue": self.flags["vibration_issue"],
            "prearm_issue": bool(self.prearm),
            "prearm_count": len(self.prearm),
            "prearm_messages": self.prearm[:20],
            "counts": self.counts,
            "events": ev[-200:],
            "modes": self.modes[-50:],
            "home": self.home,
            "end_reason": self.end_reason,
        }


class Drone:
    def __init__(self, hub, key, msn, model, sysid):
        self.hub = hub
        self.key, self.msn, self.model, self.sysid = key, msn, model, sysid
        self.first_seen = time.time()
        self.last_hb = 0.0
        self.last_rx = 0.0
        self.last_seen_saved = None  # from the database, before this server process heard the drone
        self.vehicle_type = None
        self.armed = False
        self.mode = ""
        self.system_status = None
        self.boot_s = None
        self.t = {}            # latest telemetry values
        self.home = None
        self.msgs = deque(maxlen=200)
        self.prearm_seen = []
        self.flight = None
        self.trail = deque(maxlen=7200)
        self.ods = {}          # sector angle (deg, body frame) -> (distance m, max m, wall time)
        self.rangefinder = None
        self.motors = []
        self.raw_ring = deque()  # (wall, bytes) last 30 s, written to the head of each flight's tlog
        self.rx_count = 0
        self.seq_last = None
        self.seq_lost = 0
        self.seq_recv = 0
        self.last_flight_id = None
        self.statustext_chunks = {}

    # ----- helpers
    def status(self, now=None):
        now = now or time.time()
        silent = now - self.last_hb if self.last_hb else 1e9
        if silent > config.STALE_S and self.armed:
            return "link_lost"
        if silent > config.OFFLINE_S:
            return "offline"
        if silent > config.STALE_S:
            return "stale"
        return "flying" if self.armed else "online"

    def pos(self):
        return (self.t.get("lat"), self.t.get("lon"))

    def dist_home(self):
        return haversine(self.home, self.pos()) if self.home else None

    def add_msg(self, sev, text, now):
        self.msgs.append({"ts": now, "sev": sev, "text": text})
        fid = self.flight.id if self.flight else None
        self.hub.store.add_message(self.key, fid, now, sev, text)

    def event(self, kind, text, now, **extra):
        f = self.flight
        if not f:
            return
        t = f.elapsed(self)
        for prev in reversed(f.events[-10:]):
            if prev["type"] == kind and t - (prev["t"] or 0) < 10:
                return  # same event repeated (e.g. ArduPilot text + error code): keep the first
        d = self.dist_home()
        e = {"type": kind, "t": _r(t, 1), "text": text, "dist_m": _r(d, 0), "alt_m": _r(self.t.get("alt"), 1),
             "voltage": _r(self.t.get("volt"), 2), "mode": self.mode, "lat": self.t.get("lat"), "lon": self.t.get("lon"), "ts": now}
        e.update(extra)
        f.events.append(e)
        if kind in f.flags:
            f.flags[kind] = True
            f.counts[kind] = f.counts.get(kind, 0) + 1

    # ----- packet handling
    def raw(self, msg, now):
        buf = msg.get_msgbuf()
        self.raw_ring.append((now, buf))
        while self.raw_ring and now - self.raw_ring[0][0] > 30:
            self.raw_ring.popleft()
        f = self.flight
        if f and f.tlog:
            try:
                f.tlog.write(struct.pack(">Q", int(now * 1e6)) + buf)
            except Exception:
                f.tlog = None

    def handle(self, msg, now):
        self.last_rx = now
        self.rx_count += 1
        # link quality from the MAVLink sequence numbers of the autopilot component
        if msg.get_srcComponent() == 1:
            seq = msg.get_seq()
            if self.seq_last is not None:
                gap = (seq - self.seq_last - 1) % 256
                if gap < 100:
                    self.seq_lost += gap
            self.seq_last = seq
            self.seq_recv += 1
        self.raw(msg, now)
        name = msg.get_type()
        fn = getattr(self, "on_" + name, None)
        if fn:
            fn(msg, now)

    def _boot(self, ms):
        s = ms / 1000.0
        if self.boot_s is not None and s + 5 < self.boot_s:
            # autopilot rebooted
            self.prearm_seen = []
            if self.flight:
                self.close_flight(time.time(), "reboot")
        self.boot_s = s

    def on_HEARTBEAT(self, m, now):
        if m.autopilot == mavlink.MAV_AUTOPILOT_INVALID or m.type in NON_VEHICLE_TYPES:
            return
        self.last_hb = now
        self.vehicle_type = m.type
        self.system_status = m.system_status
        try:
            mode = mavutil.mode_string_v10(m)
        except Exception:
            mode = str(m.custom_mode)
        if mode != self.mode:
            if self.flight:
                self.flight.modes.append(mode)
            if self.mode:
                self.add_msg(6, f"Mode {self.mode} → {mode}", now)
            self.mode = mode
        armed = bool(m.base_mode & mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
        if armed and not self.armed:
            self.armed = True
            self.open_flight(now)
        elif not armed and self.armed:
            self.armed = False
            self.close_flight(now, "disarmed")

    def on_SYSTEM_TIME(self, m, now):
        if m.time_boot_ms:
            self._boot(m.time_boot_ms)

    def on_ATTITUDE(self, m, now):
        self._boot(m.time_boot_ms)
        self.t.update(roll=math.degrees(m.roll), pitch=math.degrees(m.pitch), yaw=math.degrees(m.yaw) % 360)

    def on_GLOBAL_POSITION_INT(self, m, now):
        if m.time_boot_ms:
            self._boot(m.time_boot_ms)
        if m.lat == 0 and m.lon == 0:
            return
        lat, lon = m.lat / 1e7, m.lon / 1e7
        alt = m.relative_alt / 1000.0
        self.t.update(lat=lat, lon=lon, alt=alt, alt_msl=m.alt / 1000.0,
                      heading=(m.hdg / 100.0) if m.hdg != 65535 else self.t.get("yaw"),
                      vz=-m.vz / 100.0)
        f = self.flight
        if f:
            fix_ok = (self.t.get("fix") or 0) >= 3
            if fix_ok and f.last_pos:
                step = haversine(f.last_pos, (lat, lon)) or 0
                if 0.3 < step < 150:
                    f.distance += step
                    f.last_pos = (lat, lon)
                elif step >= 150:
                    f.last_pos = (lat, lon)  # jump: don't count it
            elif fix_ok:
                f.last_pos = (lat, lon)
            d = self.dist_home()
            if d is not None:
                f.max_range = max(f.max_range, d)
            f.max_alt = max(f.max_alt, alt)
            t = f.elapsed(self)
            if t - f.last_pt_t >= 1.0:
                f.last_pt_t = t
                pt = (_r(t, 1), round(lat, 7), round(lon, 7), _r(alt, 1))
                f.pending_pts.append(pt)
                self.trail.append(pt)
                if len(f.pending_pts) >= 10:
                    self.hub.store.add_points(f.id, f.pending_pts)
                    f.pending_pts = []

    def on_GPS_RAW_INT(self, m, now):
        sats = m.satellites_visible if m.satellites_visible != 255 else None
        hdop = m.eph / 100.0 if m.eph not in (0, 65535) else None
        self.t.update(fix=m.fix_type, sats=sats, hdop=hdop)
        if not self.t.get("lat") and m.lat:
            self.t.update(lat=m.lat / 1e7, lon=m.lon / 1e7)
        f = self.flight
        if f:
            if sats is not None:
                f.min_sats = sats if f.min_sats is None else min(f.min_sats, sats)
            if hdop is not None:
                f.max_hdop = hdop if f.max_hdop is None else max(f.max_hdop, hdop)
            bad = m.fix_type < 3 or (sats is not None and sats < 6) or (hdop is not None and hdop > 2.5)
            if f.gps_ep.update(bad, f.elapsed(self)):
                why = "no 3D fix" if m.fix_type < 3 else (f"{sats} satellites" if sats is not None and sats < 6 else f"HDOP {hdop:.1f}")
                self.event("gps_issue", f"GPS degraded: {why}", now)

    def on_SYS_STATUS(self, m, now):
        v = m.voltage_battery / 1000.0 if m.voltage_battery not in (0, 65535) else None
        c = m.current_battery / 100.0 if m.current_battery >= 0 else None
        pct = m.battery_remaining if m.battery_remaining >= 0 else None
        self.t.update(volt=v, curr=c, batt_pct=pct, sensors_health=m.onboard_control_sensors_health,
                      sensors_enabled=m.onboard_control_sensors_enabled)
        f = self.flight
        if f and v:
            f.v_max = v if f.v_max is None else max(f.v_max, v)
            f.v_min = v if f.v_min is None else min(f.v_min, v)
            if c is not None:
                f.cur_sum += c
                f.cur_n += 1

    def on_BATTERY_STATUS(self, m, now):
        if m.id != 0:
            return
        if m.current_consumed >= 0:
            self.t["mah"] = m.current_consumed
            f = self.flight
            if f:
                if f.mah_start is None:
                    f.mah_start = m.current_consumed
                f.mah = m.current_consumed
        if m.temperature != 32767:
            self.t["batt_temp"] = m.temperature / 100.0

    def on_VFR_HUD(self, m, now):
        self.t.update(gs=m.groundspeed, airspeed=m.airspeed, climb=m.climb, throttle=m.throttle)
        if self.flight:
            self.flight.max_speed = max(self.flight.max_speed, m.groundspeed)

    def on_HOME_POSITION(self, m, now):
        self.home = (m.latitude / 1e7, m.longitude / 1e7)
        if self.flight:
            self.flight.home = self.home

    def on_EKF_STATUS_REPORT(self, m, now):
        vals = {"vel": m.velocity_variance, "pos_h": m.pos_horiz_variance, "pos_v": m.pos_vert_variance,
                "compass": m.compass_variance, "terrain": m.terrain_alt_variance}
        worst = max(vals["vel"], vals["pos_h"], vals["pos_v"], vals["compass"])
        self.t["ekf"] = {k: round(v, 2) for k, v in vals.items()}
        self.t["ekf"]["flags"] = m.flags
        self.t["ekf"]["max"] = round(worst, 2)
        f = self.flight
        if f and f.ekf_ep.update(worst >= 0.8, f.elapsed(self)):
            key = max(("vel", "pos_h", "pos_v", "compass"), key=lambda k: vals[k])
            self.event("ekf_issue", f"EKF variance {worst:.2f} ({key})", now)

    def on_VIBRATION(self, m, now):
        clip = m.clipping_0 + m.clipping_1 + m.clipping_2
        vmax = max(m.vibration_x, m.vibration_y, m.vibration_z)
        self.t["vibe"] = [round(m.vibration_x, 1), round(m.vibration_y, 1), round(m.vibration_z, 1), clip]
        f = self.flight
        if f:
            f.max_vibe = max(f.max_vibe, vmax)
            if f.clip_start is None:
                f.clip_start = clip
            f.clip = max(0, clip - f.clip_start)
            if f.vibe_ep.update(vmax > 60, f.elapsed(self)) or (f.clip > 50 and not f.flags["vibration_issue"]):
                self.event("vibration_issue", f"High vibration {vmax:.0f} m/s², {f.clip} clipping events", now)

    def on_SERVO_OUTPUT_RAW(self, m, now):
        if m.port != 0:
            return
        outs = [getattr(m, f"servo{i}_raw") for i in range(1, 9)]
        n = 4
        if self.vehicle_type == mavlink.MAV_TYPE_HEXAROTOR:
            n = 6
        elif self.vehicle_type == mavlink.MAV_TYPE_OCTOROTOR:
            n = 8
        motors = [o for o in outs[:n] if o]
        self.motors = motors
        f = self.flight
        if f and len(motors) >= 4 and (self.t.get("alt") or 0) > 1:
            hi = max(motors)
            others = sorted(motors)[:-1]
            avg_o = sum(others) / len(others)
            bad = hi >= 1900 and hi - avg_o > 300
            if f.motor_ep.update(bad, f.elapsed(self)):
                idx = motors.index(hi) + 1
                self.event("motor_issue", f"Motor {idx} saturated ({hi} µs) while the others average {avg_o:.0f} µs", now, motor=idx)

    def on_RC_CHANNELS(self, m, now):
        if m.rssi != 255:
            self.t["rc_rssi"] = round(m.rssi / 254 * 100)

    def on_RADIO_STATUS(self, m, now):
        self.t["radio"] = {"rssi": m.rssi, "remrssi": m.remrssi, "noise": m.noise, "remnoise": m.remnoise, "rxerrors": m.rxerrors}

    def on_DISTANCE_SENSOR(self, m, now):
        d = m.current_distance / 100.0
        mx = m.max_distance / 100.0
        o = m.orientation
        if o == mavlink.MAV_SENSOR_ROTATION_PITCH_270:  # downward rangefinder
            self.rangefinder = {"d": round(d, 2), "max": mx, "ts": now}
        elif o <= 7:  # proximity sectors: yaw 0, 45, ... 315 deg
            self.ods[o * 45] = (round(d, 2), mx, now)
        elif o == mavlink.MAV_SENSOR_ROTATION_PITCH_90:
            self.ods["up"] = (round(d, 2), mx, now)

    def on_OBSTACLE_DISTANCE(self, m, now):
        inc = m.increment_f or m.increment or 5
        off = m.angle_offset or 0
        mx = m.max_distance / 100.0
        for i, cm in enumerate(m.distances):
            if cm == 65535:
                continue
            ang = round((off + i * inc) % 360)
            self.ods[ang] = (round(cm / 100.0, 2), mx, now)

    def on_STATUSTEXT(self, m, now):
        text = m.text
        if isinstance(text, bytes):
            text = text.decode("utf-8", "replace")
        text = text.rstrip("\x00").strip()
        # MAVLink 2 long messages arrive in chunks sharing an id
        mid = getattr(m, "id", 0)
        if mid:
            buf = self.statustext_chunks.setdefault(mid, [])
            buf.append(text)
            if len(text) >= 50:
                return
            text = "".join(self.statustext_chunks.pop(mid))
        if not text:
            return
        self.add_msg(m.severity, text, now)
        if PREARM.match(text):
            if text not in self.prearm_seen:
                self.prearm_seen.append(text)
                if len(self.prearm_seen) > 50:
                    self.prearm_seen.pop(0)
            return
        if CLEARED.search(text):
            return
        for kind, rx in PATTERNS:
            if rx.search(text):
                self.event(kind, text, now)
                break

    # ----- flights
    def open_flight(self, now):
        if self.flight:
            return
        if not self.home and self.t.get("lat"):
            self.home = (self.t["lat"], self.t["lon"])
        fid = self.hub.store.start_flight(self.key, self.msn, self.model, now)
        f = Flight(fid, self, now, self.boot_s)
        self.flight = f
        self.last_flight_id = fid
        self.trail.clear()
        self.prearm_seen = []
        try:
            folder = config.TLOG_DIR / safe_name(self.msn)
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / f"{datetime.fromtimestamp(now).strftime('%Y-%m-%d_%H-%M-%S')}_{safe_name(self.msn)}_flight{fid}.tlog"
            f.tlog = open(path, "ab")
            f.tlog_path = str(path)
            for ts, buf in self.raw_ring:
                f.tlog.write(struct.pack(">Q", int(ts * 1e6)) + buf)
        except OSError:
            f.tlog = None
        self.add_msg(5, "Armed: flight recording started", now)
        self.hub.store.update_flight(fid, f.summary(self), tlog_path=f.tlog_path)

    def close_flight(self, now, reason):
        f = self.flight
        if not f:
            return
        f.end_reason = reason
        if f.pending_pts:
            self.hub.store.add_points(f.id, f.pending_pts)
            f.pending_pts = []
        if f.tlog:
            try:
                f.tlog.close()
            except Exception:
                pass
            f.tlog = None
        status = {"disarmed": "completed"}.get(reason, reason)
        self.hub.store.update_flight(f.id, f.summary(self), status=status, end_ts=now)
        self.flight = None
        if reason == "disarmed":
            self.add_msg(5, "Disarmed: flight saved", now)

    def checkpoint(self):
        f = self.flight
        if f:
            if f.pending_pts:
                self.hub.store.add_points(f.id, f.pending_pts)
                f.pending_pts = []
            self.hub.store.update_flight(f.id, f.summary(self))
            if f.tlog:
                f.tlog.flush()

    # ----- snapshot for the browser
    def snapshot(self, now):
        t = self.t
        f = self.flight
        ods = []
        for ang, (d, mx, ts) in list(self.ods.items()):
            if now - ts < 5:
                ods.append({"a": ang, "d": d, "max": mx})
        link = None
        tot = self.seq_recv + self.seq_lost
        if tot > 20:
            link = round(100 * self.seq_recv / tot)
        sev_msgs = [m for m in self.msgs][-30:]
        return {
            "key": self.key, "msn": self.msn, "model": self.model, "sysid": self.sysid,
            "status": self.status(now), "armed": self.armed, "mode": self.mode,
            "last_seen_s": round(now - self.last_hb, 1) if self.last_hb else (round(now - self.last_seen_saved) if self.last_seen_saved else None),
            "lat": t.get("lat"), "lon": t.get("lon"), "alt": _r(t.get("alt"), 1), "alt_msl": _r(t.get("alt_msl"), 1),
            "heading": _r(t.get("heading"), 0), "roll": _r(t.get("roll"), 1), "pitch": _r(t.get("pitch"), 1), "yaw": _r(t.get("yaw"), 1),
            "gs": _r(t.get("gs"), 1), "climb": _r(t.get("climb"), 1), "throttle": t.get("throttle"),
            "volt": _r(t.get("volt"), 2), "curr": _r(t.get("curr"), 1), "batt_pct": t.get("batt_pct"), "mah": t.get("mah"),
            "fix": t.get("fix"), "sats": t.get("sats"), "hdop": _r(t.get("hdop"), 2),
            "ekf": t.get("ekf"), "vibe": t.get("vibe"), "rc_rssi": t.get("rc_rssi"), "radio": t.get("radio"),
            "link_pct": link, "motors": self.motors, "ods": ods, "rangefinder": self.rangefinder,
            "home": self.home, "range": _r(self.dist_home(), 0),
            "boot_s": _r(self.boot_s, 0),
            "flight": ({"id": f.id, "time_s": _r(f.elapsed(self), 0), "distance_m": _r(f.distance, 0),
                        "max_range": _r(f.max_range, 0), "max_alt": _r(f.max_alt, 1), "cold_start_s": f.cold_start_s,
                        "events": f.events[-30:], "flags": f.flags, "prearm": f.prearm} if f else None),
            "last_flight_id": self.last_flight_id,
            "prearm": self.prearm_seen[-10:],
            "msgs": sev_msgs,
            "video": safe_name(self.msn),
        }


def safe_name(s):
    return re.sub(r"[^A-Za-z0-9_-]", "_", str(s or "drone"))[:40]


class Hub:
    """All drones the server knows about, keyed by MSN (or SYSID-n)."""

    def __init__(self, store):
        self.store = store
        self.drones = {}
        self.sources = {}  # source id -> parser
        for d in store.drones():
            dr = Drone(self, d["key"], d["msn"], d["model"], d["sysid"])
            dr.last_seen_saved = d.get("last_seen")
            if d.get("last_lat") is not None:
                dr.t.update(lat=d["last_lat"], lon=d["last_lon"])
            self.drones[d["key"]] = dr

    def parser(self, source):
        p = self.sources.get(source)
        if p is None:
            p = mavlink.MAVLink(None)
            p.robust_parsing = True
            self.sources[source] = p
        return p

    def drop_source(self, source):
        self.sources.pop(source, None)

    def resolve(self, msn, model, sysid, msg):
        """Find (or create on its first autopilot heartbeat) the drone this packet belongs to."""
        if msn:
            key = msn
            # a relay carrying several vehicles: the first sysid owns the MSN, others get MSN-sysid
            d = self.drones.get(key)
            if d and d.sysid not in (None, sysid) and d.last_rx and time.time() - d.last_rx < 30:
                key = f"{msn}-{sysid}"
        else:
            key = config.SYSID_MAP.get(sysid) or f"SYSID-{sysid}"
        d = self.drones.get(key)
        if d is None:
            if msg.get_type() != "HEARTBEAT" or msg.autopilot == mavlink.MAV_AUTOPILOT_INVALID or msg.type in NON_VEHICLE_TYPES:
                return None
            name = key
            d = Drone(self, key, name, model or config.MODEL_MAP.get(name), sysid)
            self.drones[key] = d
            self.store.upsert_drone(key, name, d.model, sysid)
        else:
            if d.sysid != sysid or (model and d.model != model):
                d.sysid = sysid
                d.model = model or d.model
                self.store.upsert_drone(key, d.msn, d.model, sysid)
        return d

    def feed(self, source, data, msn=None, model=None):
        now = time.time()
        try:
            msgs = self.parser(source).parse_buffer(data) or []
        except Exception:
            return 0
        n = 0
        for msg in msgs:
            if msg.get_type() == "BAD_DATA":
                continue
            sysid = msg.get_srcSystem()
            if sysid in (0, 255):
                continue
            d = self.resolve(msn, model, sysid, msg)
            if d is None:
                continue
            d.handle(msg, now)
            n += 1
        return n

    def tick(self):
        """Periodic housekeeping: checkpoint open flights, close flights whose link has been gone too long."""
        now = time.time()
        for d in list(self.drones.values()):
            if d.flight:
                if d.last_hb and now - d.last_hb > config.LOST_CLOSE_S:
                    d.armed = False
                    d.close_flight(now, "link_lost")
                else:
                    d.checkpoint()
            if d.t.get("lat") is not None and d.last_rx and now - d.last_rx < 30:
                self.store.upsert_drone(d.key, d.msn, d.model, d.sysid, d.t.get("lat"), d.t.get("lon"))

    def snapshot(self):
        now = time.time()
        return [d.snapshot(now) for d in sorted(self.drones.values(), key=lambda x: x.msn or "")]

    def shutdown(self):
        now = time.time()
        for d in self.drones.values():
            if d.flight:
                d.close_flight(now, "server_stopped")
