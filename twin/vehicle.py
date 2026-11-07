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
        self.batt_start = drone.t.get("batt_pct")
        self.batt_end = None
        self.takeoff_ts = None
        self.landing_ts = None
        self.drone_id = drone.drone_id
        self.gcs_id = drone.gcs_id
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
            "drone_id": self.drone_id, "gcs_id": self.gcs_id,
            "takeoff_ts": self.takeoff_ts, "landing_ts": self.landing_ts,
            "batt_start_pct": self.batt_start, "batt_end_pct": drone.t.get("batt_pct") if self.batt_end is None else self.batt_end,
            "mission": {"total": drone.mission.get("total"), "reached": drone.mission.get("reached"),
                        "completed": bool(drone.mission.get("total") and drone.mission.get("reached") is not None
                                          and drone.mission["reached"] >= drone.mission["total"] - 1),
                        "flown_auto": "AUTO" in self.modes},
        }


class Drone:
    def __init__(self, hub, key, msn, model, sysid, slot=None):
        self.hub = hub
        self.key, self.msn, self.model, self.sysid = key, msn, model, sysid
        self.slot = slot
        self.drone_id = slot["drone_id"] if slot else (msn or key)
        self.gcs_id = slot["gcs_id"] if slot else None
        self.airborne = False
        self.takeoff_pos = None
        self.mission = {"seq": None, "total": None}
        self.fence = None
        self.esc = {}           # motor index -> {rpm, temp, current, voltage, ts}
        self.temps = {}         # name -> (deg C, ts)
        self.sensors = None     # (present, enabled, health) bitmasks from SYS_STATUS
        self.alert_ctx = {}     # scratch space for the alert engine
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
        self.seen = {}           # data group -> wall time it was last received (for stale / N/A display)
        self.simulated = False   # True when the GCS link is the simulator (shown as SIMULATION everywhere)
        self.mission_items = []  # planned route heard on the GCS link (MISSION_ITEM_INT), never invented
        self.mission_pending = {}
        self.mission_ver = 0

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

    def add_msg(self, sev, text, now, from_fc=False):
        self.msgs.append({"ts": now, "sev": sev, "text": text, "fc": from_fc})
        fid = self.flight.id if self.flight else None
        self.hub.store.add_message(self.key, fid, now, sev, text)

    def notify(self, name, *args):
        al = self.hub.alerts
        if al is not None:
            try:
                getattr(al, name)(self, *args)
            except Exception:  # an alert bug must never stop telemetry
                import logging
                logging.getLogger("twin.alerts").exception("alert hook %s failed", name)

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
        self.notify("flight_event", e)

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
        grp = DATA_GROUPS.get(name)
        if grp:
            self.seen[grp] = now
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
            old = self.mode
            if self.mode:
                self.add_msg(6, f"Mode {self.mode} → {mode}", now)
            self.mode = mode
            if old:
                self.notify("mode_change", old, mode)
        armed = bool(m.base_mode & mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
        if armed and not self.armed:
            self.armed = True
            self.open_flight(now)
            self.notify("armed")
        elif not armed and self.armed:
            self.armed = False
            if self.airborne:
                self.airborne = False
                if self.flight:
                    self.flight.landing_ts = now
                self.notify("landed")
            if self.flight and not self.flight.landing_ts:
                self.flight.landing_ts = now
            self.close_flight(now, "disarmed")
            self.notify("disarmed")

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
                      heading_src="gps" if m.hdg != 65535 else ("yaw" if self.t.get("yaw") is not None else None),
                      vz=-m.vz / 100.0,
                      # direction of movement (course over ground) from the velocity the autopilot reports
                      track=(math.degrees(math.atan2(m.vy, m.vx)) % 360) if math.hypot(m.vx, m.vy) >= 50 else None)
        if self.armed and not self.airborne and alt > 2.0:
            self.airborne = True
            self.takeoff_pos = (lat, lon)
            if self.flight and not self.flight.takeoff_ts:
                self.flight.takeoff_ts = now
            self.notify("took_off")
        elif self.airborne and self.armed and alt < 0.5 and abs(m.vz) < 30:
            ctx = self.alert_ctx.setdefault("land_since", now)
            if now - ctx > 3:
                self.airborne = False
                self.alert_ctx.pop("land_since", None)
                if self.flight:
                    self.flight.landing_ts = now
                self.notify("landed")
        else:
            self.alert_ctx.pop("land_since", None)
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
        self.t.update(fix=m.fix_type, sats=sats, hdop=hdop,
                      h_acc=(m.h_acc / 1000.0) if getattr(m, "h_acc", 0) else None)   # metres, MAVLink 2 extension
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
        self.t.update(volt=v, curr=c, batt_pct=pct, load=m.load / 10.0)
        self.sensors = (m.onboard_control_sensors_present, m.onboard_control_sensors_enabled, m.onboard_control_sensors_health, now)
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
            self.temps["battery"] = (m.temperature / 100.0, now)

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

    def _esc(self, base, m, now):
        for i in range(4):
            self.esc[base + i] = {"rpm": m.rpm[i], "temp": m.temperature[i], "current": round(m.current[i] / 100.0, 2),
                                  "voltage": round(m.voltage[i] / 100.0, 2), "ts": now}
            if m.temperature[i]:
                self.temps[f"esc{base + i + 1}"] = (m.temperature[i], now)

    def on_ESC_TELEMETRY_1_TO_4(self, m, now):
        self._esc(0, m, now)

    def on_ESC_TELEMETRY_5_TO_8(self, m, now):
        self._esc(4, m, now)

    def on_SCALED_PRESSURE(self, m, now):
        self.temps["flight controller"] = (m.temperature / 100.0, now)

    def on_MISSION_CURRENT(self, m, now):
        total = getattr(m, "total", None)
        prev = self.mission.get("seq")
        self.mission.update(seq=m.seq, total=total if total not in (None, 0, 65535) else self.mission.get("total"), ts=now)
        if prev is not None and m.seq != prev:
            self.notify("mission_progress", prev, m.seq)

    # The planned route is captured passively when the GCS downloads or uploads the mission over this link.
    NAV_CMDS = {16: "waypoint", 17: "loiter", 18: "loiter", 19: "loiter", 21: "land", 22: "take-off", 82: "spline waypoint", 20: "return"}

    def on_MISSION_COUNT(self, m, now):
        if getattr(m, "mission_type", 0) != 0:
            return
        self.mission_pending = {"count": m.count, "items": {}, "ts": now}

    def on_MISSION_ITEM_INT(self, m, now):
        if getattr(m, "mission_type", 0) != 0:
            return
        p = self.mission_pending
        if not p or now - p["ts"] > 60:
            return
        p["items"][m.seq] = {"seq": m.seq, "cmd": m.command, "frame": m.frame, "lat": m.x / 1e7, "lon": m.y / 1e7, "alt": m.z}
        if len(p["items"]) >= p["count"]:
            self._mission_done(now)

    def on_MISSION_ACK(self, m, now):
        p = self.mission_pending
        if p and len(p["items"]) >= p["count"]:
            self._mission_done(now)

    def _mission_done(self, now):
        p, self.mission_pending = self.mission_pending, {}
        items = []
        for seq in sorted(p["items"]):
            it = p["items"][seq]
            if seq == 0:
                continue  # ArduPilot keeps the home position in item 0
            name = self.NAV_CMDS.get(it["cmd"])
            if not name:
                continue
            if it["cmd"] == 20 and self.home:
                it.update(lat=self.home[0], lon=self.home[1])
            elif it["lat"] == 0 and it["lon"] == 0:
                continue  # e.g. a take-off item without a position
            # MAV_FRAME_GLOBAL (0) is AMSL; the relative frames (3, 6) are above home
            it.update(kind=name, alt_ref="amsl" if it["frame"] in (0, 5) else "home")
            items.append(it)
        self.mission_items = items
        self.mission_ver += 1
        self.mission["total"] = p["count"]
        self.add_msg(6, f"Mission received from the GCS link: {len(items)} navigation points", now)

    def on_MISSION_ITEM_REACHED(self, m, now):
        self.mission["reached"] = m.seq
        self.notify("mission_reached", m.seq)

    def on_FENCE_STATUS(self, m, now):
        self.fence = {"breach": bool(m.breach_status), "count": m.breach_count, "type": m.breach_type, "ts": now}

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
        self.add_msg(m.severity, text, now, from_fc=True)
        self.notify("fc_text", m.severity, text)
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
                self.event(kind, text, now, src="fc")
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

    # ----- snapshots for the browser
    def link_pct(self):
        tot = self.seq_recv + self.seq_lost
        return round(100 * self.seq_recv / tot) if tot > 20 else None

    def rssi_pct(self):
        r = self.t.get("radio")
        if r and r.get("rssi") not in (None, 255):
            return round(r["rssi"] / 254 * 100)
        return self.t.get("rc_rssi")

    def flight_time(self):
        return round(self.flight.elapsed(self)) if self.flight else None

    def compact(self, now):
        """What every tile, the wall and the map need (sent for all drones, 4 times a second)."""
        t = self.t
        return {
            "key": self.key, "drone_id": self.drone_id, "gcs_id": self.gcs_id, "msn": self.msn, "model": self.model,
            "slot": self.slot["slot"] if self.slot else None, "enabled": self.slot.get("enabled", True) if self.slot else True,
            "conn": self.status(now), "armed": self.armed, "airborne": self.airborne, "mode": self.mode,
            "last_seen_s": round(now - self.last_hb, 1) if self.last_hb else (round(now - self.last_seen_saved) if self.last_seen_saved else None),
            "lat": t.get("lat"), "lon": t.get("lon"), "alt": _r(t.get("alt"), 1), "alt_msl": _r(t.get("alt_msl"), 1),
            "heading": _r(t.get("heading"), 0), "gs": _r(t.get("gs"), 1), "climb": _r(t.get("climb"), 1),
            "batt_pct": t.get("batt_pct"), "volt": _r(t.get("volt"), 2), "curr": _r(t.get("curr"), 1),
            "fix": t.get("fix"), "sats": t.get("sats"), "hdop": _r(t.get("hdop"), 2),
            "link_pct": self.link_pct(), "rssi": self.rssi_pct(),
            "home": self.home, "takeoff": self.takeoff_pos, "range": _r(self.dist_home(), 0),
            "flight_s": self.flight_time(), "flight_id": self.flight.id if self.flight else self.last_flight_id,
            "dist_m": _r(self.flight.distance, 0) if self.flight else None,
            "roll": _r(t.get("roll"), 1), "pitch": _r(t.get("pitch"), 1), "yaw": _r(t.get("yaw"), 1),
            "heading_src": t.get("heading_src"), "vz": _r(t.get("vz"), 1), "track": _r(t.get("track"), 0),
            "ages": {k: round(now - v, 1) for k, v in self.seen.items()},
            "last_rx": round(self.last_rx, 1) if self.last_rx else None,
            "simulated": self.simulated, "mission_ver": self.mission_ver,
            "mission_seq": self.mission.get("seq"),
        }

    def detail(self, now):
        """Everything for the drone's digital-twin screen (sent only for the drone being viewed)."""
        t = self.t
        f = self.flight
        ods = [{"a": ang, "d": d, "max": mx} for ang, (d, mx, ts) in list(self.ods.items()) if now - ts < 5]
        temps = {k: round(v, 1) for k, (v, ts) in self.temps.items() if now - ts < 30}
        esc = [dict(v, i=i) for i, v in sorted(self.esc.items()) if now - v["ts"] < 10]
        out = self.compact(now)
        out.update({
            "roll": _r(t.get("roll"), 1), "pitch": _r(t.get("pitch"), 1), "yaw": _r(t.get("yaw"), 1),
            "airspeed": _r(t.get("airspeed"), 1), "throttle": t.get("throttle"), "mah": t.get("mah"), "load": t.get("load"),
            "ekf": t.get("ekf"), "vibe": t.get("vibe"), "h_acc": _r(t.get("h_acc"), 2), "radio": t.get("radio"), "rc_rssi": t.get("rc_rssi"),
            "motors": self.motors, "esc": esc, "temps": temps, "ods": ods, "rangefinder": self.rangefinder,
            "system_status": self.system_status, "vehicle_type": self.vehicle_type, "sysid": self.sysid,
            "sensors": self.sensor_report(), "mission": self.mission, "fence": self.fence, "boot_s": _r(self.boot_s, 0),
            "flight": ({"id": f.id, "time_s": _r(f.elapsed(self), 0), "distance_m": _r(f.distance, 0),
                        "max_range": _r(f.max_range, 0), "max_alt": _r(f.max_alt, 1), "max_speed": _r(f.max_speed, 1),
                        "cold_start_s": f.cold_start_s, "events": f.events[-30:], "prearm": f.prearm} if f else None),
            "prearm": self.prearm_seen[-10:],
            "msgs": list(self.msgs)[-40:],
            "geofence": (self.slot or {}).get("geofence"), "battery_cells": (self.slot or {}).get("battery_cells"),
            "mission_items": self.mission_items,
        })
        return out

    SENSOR_BITS = [
        (0x01, "3D gyro"), (0x02, "3D accelerometer"), (0x04, "3D magnetometer"), (0x08, "absolute pressure"),
        (0x20, "GPS"), (0x8000, "motor outputs"), (0x10000, "RC receiver"), (0x200000, "AHRS"),
        (0x2000000, "battery"), (0x8000000, "logging"), (0x10000000, "proximity"),
    ]

    def sensor_report(self):
        if not self.sensors:
            return None
        present, enabled, health, ts = self.sensors
        out = []
        for bit, name in self.SENSOR_BITS:
            if present & bit and enabled & bit:
                out.append({"name": name, "ok": bool(health & bit)})
        return out


DATA_GROUPS = {
    "GLOBAL_POSITION_INT": "pos", "ATTITUDE": "att", "GPS_RAW_INT": "gps", "SYS_STATUS": "batt", "BATTERY_STATUS": "batt",
    "VFR_HUD": "hud", "RADIO_STATUS": "radio", "RC_CHANNELS": "rc", "HEARTBEAT": "hb",
}


def safe_name(s):
    return re.sub(r"[^A-Za-z0-9_-]", "_", str(s or "drone"))[:40]


class Hub:
    """All drones the server knows about, keyed by MSN (or SYSID-n)."""

    def __init__(self, store):
        self.store = store
        self.drones = {}
        self.sources = {}  # source id -> parser
        self.alerts = None  # AlertEngine, attached by the app
        self.fleet = None   # FleetManager, attached by the app
        self._saved = {d["key"]: d for d in store.drones()}
        for d in self._saved.values():
            if d["key"].startswith("TAVAS-"):
                continue  # fleet slots are created by register_slot
            dr = Drone(self, d["key"], d["msn"], d["model"], d["sysid"])
            dr.last_seen_saved = d.get("last_seen")
            if d.get("last_lat") is not None:
                dr.t.update(lat=d["last_lat"], lon=d["last_lon"])
            self.drones[d["key"]] = dr

    def register_slot(self, slot):
        d = self.drones.get(slot["key"])
        if d is None:
            d = Drone(self, slot["key"], slot.get("msn") or slot["drone_id"], slot.get("model"), None, slot=slot)
            saved = self._saved.get(slot["key"])
            if saved:
                d.last_seen_saved = saved.get("last_seen")
                d.sysid = saved.get("sysid")
                if saved.get("last_lat") is not None:
                    d.t.update(lat=saved["last_lat"], lon=saved["last_lon"])
            self.drones[slot["key"]] = d
        d.slot = slot
        d.drone_id, d.gcs_id = slot["drone_id"], slot["gcs_id"]
        d.msn = slot.get("msn") or slot["drone_id"]
        d.model = slot.get("model") or d.model

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

    def feed(self, source, data, msn=None, model=None, slot=None, simulated=False):
        """Parse a chunk of MAVLink from one source. With `slot`, the source is that drone's own GCS: every
        autopilot message on it belongs to that drone (other vehicles heard on the same link are ignored)."""
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
            if slot is not None:
                d = self.drones.get(slot["key"])
                if d is None:
                    continue
                if d.sysid is None or not d.last_hb or now - d.last_hb > 30:
                    if msg.get_type() != "HEARTBEAT" or msg.autopilot == mavlink.MAV_AUTOPILOT_INVALID or msg.type in NON_VEHICLE_TYPES:
                        if d.sysid != sysid:
                            continue
                    elif d.sysid != sysid:
                        d.sysid = sysid
                        self.store.upsert_drone(d.key, d.msn, d.model, sysid)
                elif sysid != d.sysid:
                    continue
            else:
                d = self.resolve(msn, model, sysid, msg)
            if d is None:
                continue
            d.simulated = simulated
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

    def ordered(self):
        return sorted(self.drones.values(), key=lambda x: (x.slot["slot"] if x.slot else 999, x.msn or ""))

    def compact(self):
        now = time.time()
        return [d.compact(now) for d in self.ordered()]

    def sample(self):
        """One telemetry row per connected drone (stored at 1 Hz)."""
        now = time.time()
        rows = []
        for d in self.drones.values():
            if not d.last_rx or now - d.last_rx > 5 or d.t.get("lat") is None:
                continue
            t = d.t
            rows.append((d.key, round(now, 1), d.flight.id if d.flight else None, t.get("lat"), t.get("lon"), _r(t.get("alt"), 1),
                         _r(t.get("alt_msl"), 1), _r(t.get("gs"), 1), _r(t.get("heading"), 0), t.get("batt_pct"), _r(t.get("volt"), 2),
                         _r(t.get("curr"), 1), t.get("sats"), _r(t.get("hdop"), 2), d.link_pct(), d.mode))
        return rows

    def shutdown(self):
        now = time.time()
        for d in self.drones.values():
            if d.flight:
                d.close_flight(now, "server_stopped")
