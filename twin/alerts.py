"""Real-time alert engine: watches every drone independently and raises red / yellow / blue alerts.

Two sources only, and every alert says which one it came from:
- "flight controller": the autopilot's own status messages (STATUSTEXT), quoted word for word, and the failsafe /
  crash / thrust-loss events they report.
- "threshold rule": a measured value crossing a limit set in Settings (battery %, cell voltage, satellites, HDOP,
  link quality, temperature, ...). The message states the value and the limit; nothing is diagnosed or guessed.

Condition alerts (e.g. low battery) stay open while the condition lasts and close when it clears (with hysteresis).
Event alerts (e.g. a failsafe message) are one-off. Critical alerts stay on screen until someone acknowledges them.
"""
import re
import time
from collections import deque

from .vehicle import PATTERNS

DEFAULT_THRESHOLDS = {
    "batt_critical_pct": 15,
    "batt_low_pct": 30,
    "cell_v_critical": 3.30,
    "cell_v_low": 3.50,
    "sats_low": 8,
    "hdop_weak": 2.0,
    "gps_fail_s": 3,
    "link_weak_pct": 80,
    "rssi_weak_pct": 30,
    "telemetry_lost_s": 5,
    "video_interrupt_s": 5,
    "discharge_pct_per_min": 6.0,
    "temp_high_c": 60,
    "compass_var": 0.5,
    "attitude_abnormal_deg": 45,
    "descent_abnormal_ms": 6.0,
}
THRESHOLD_HELP = {
    "batt_critical_pct": ("Critical battery level", "%", "critical"),
    "batt_low_pct": ("Low battery", "%", "warning"),
    "cell_v_critical": ("Battery voltage abnormality (per cell)", "V", "critical"),
    "cell_v_low": ("Low cell voltage", "V", "warning"),
    "sats_low": ("Low satellite count", "satellites", "warning"),
    "hdop_weak": ("Weak GPS signal (HDOP above)", "", "warning"),
    "gps_fail_s": ("GPS failure: no 3D fix while armed for", "s", "critical"),
    "link_weak_pct": ("Weak communication: MAVLink packets received below", "%", "warning"),
    "rssi_weak_pct": ("Weak communication: radio RSSI below", "%", "warning"),
    "telemetry_lost_s": ("Telemetry connection lost after", "s", "critical"),
    "video_interrupt_s": ("Camera/video interruption after", "s", "warning"),
    "discharge_pct_per_min": ("Abnormal battery discharge: faster than", "%/min", "warning"),
    "temp_high_c": ("High temperature (battery, ESC, flight controller)", "°C", "warning"),
    "compass_var": ("Compass inconsistency: EKF compass variance above", "", "warning"),
    "attitude_abnormal_deg": ("Abnormal flight: roll or pitch beyond", "°", "critical"),
    "descent_abnormal_ms": ("Abnormal flight: descending faster than (outside LAND/RTL)", "m/s", "critical"),
}
RULE_LABELS = {
    "battery_critical": "Critical battery level", "battery_low": "Low battery", "voltage_abnormal": "Battery voltage abnormality",
    "cell_low": "Low cell voltage", "motor_failure": "Motor failure", "fc_critical": "Flight controller critical message",
    "fc_error": "Flight controller error message", "gps_failure": "GPS failure", "telemetry_lost": "Telemetry connection lost",
    "gcs_disconnected": "GCS disconnected", "emergency_landing": "Emergency landing", "failsafe": "Failsafe activated",
    "abnormal_flight": "Abnormal flight behaviour", "gps_weak": "Weak GPS signal", "sats_low": "Low satellite count",
    "comms_weak": "Weak communication signal", "video_interrupted": "Camera/video interruption",
    "discharge_abnormal": "Abnormal battery discharge", "temp_high": "High temperature", "compass": "Compass inconsistency",
    "vibration": "High vibration", "ekf": "EKF variance", "fence": "Geofence breach",
    "armed": "Drone armed", "takeoff": "Take-off", "landing": "Landing", "mission_started": "Mission started",
    "mission_completed": "Mission completed", "rtl": "Return-to-home activated",
}
FAILSAFE_KINDS = {"battery_fs", "gcs_fs", "rc_fs"}
FS_TEXT = re.compile(r"failsafe", re.I)
COMPASS_TEXT = re.compile(r"compass.*(inconsistent|variance|not healthy|error)|mag.*inconsistent", re.I)


class AlertEngine:
    def __init__(self, store, hub, fleet=None, video=None):
        self.store = store
        self.hub = hub
        self.fleet = fleet
        self.video = video
        self.listeners = []
        self.active = {}            # (drone_key, rule) -> alert id
        self.clear_since = {}       # (drone_key, rule) -> ts condition first seen cleared
        self.oneshot_expiry = {}    # alert id -> ts to auto-resolve
        self.oneshot_last = {}      # ((drone, rule), message) -> (alert id, ts), to fold repeats
        self.recent_text = {}       # (drone_key, text) -> ts
        self.batt_hist = {}         # drone_key -> deque[(ts, pct)]
        self.thresholds = dict(DEFAULT_THRESHOLDS)
        self.thresholds.update(store.setting("alert_thresholds", {}) or {})
        self.cache = {}             # id -> alert dict for open alerts
        for a in store.open_alerts():
            self.cache[a["id"]] = a
            if a["resolved_ts"] is None:
                self.active[(a["drone_key"], a["rule"])] = a["id"]

    def set_thresholds(self, values):
        clean = {}
        for k, v in values.items():
            if k in DEFAULT_THRESHOLDS:
                clean[k] = float(v)
        self.thresholds.update(clean)
        self.store.set_setting("alert_thresholds", {k: self.thresholds[k] for k in DEFAULT_THRESHOLDS})

    # ---------------------------------------------------------------- creating / closing
    def _emit(self, a, kind):
        for cb in self.listeners:
            try:
                cb(kind, a)
            except Exception:
                pass

    def raise_alert(self, d, severity, rule, message, source, param=None, value=None, threshold=None, oneshot=False, ttl=60):
        key = (d.key, rule)
        if not oneshot and key in self.active:
            self.clear_since.pop(key, None)
            return self.active[key]
        now = time.time()
        if oneshot:
            # The same flight-controller message repeated within the alert's lifetime is one event, not several.
            prev = self.oneshot_last.get((key, message))
            if prev and prev[0] in self.oneshot_expiry:
                return prev[0]
        a = {"drone_key": d.key, "drone_id": d.drone_id, "gcs_id": d.gcs_id, "severity": severity, "rule": rule,
             "label": RULE_LABELS.get(rule, rule), "message": message, "source": source, "param": param,
             "value": value, "threshold": threshold, "lat": d.t.get("lat"), "lon": d.t.get("lon"),
             "flight_id": d.flight.id if d.flight else None, "ts": now, "resolved_ts": None, "ack_by": None, "ack_ts": None}
        a["id"] = self.store.add_alert(a)
        if severity == "info":
            a["resolved_ts"] = now
            self.store.resolve_alert(a["id"], now)
        elif oneshot:
            self.oneshot_expiry[a["id"]] = now + ttl
            self.oneshot_last[(key, message)] = (a["id"], now)
            self.cache[a["id"]] = a
        else:
            self.active[key] = a["id"]
            self.cache[a["id"]] = a
        self._emit("new", a)
        return a["id"]

    def clear(self, d, rule, hold=5):
        key = (d.key, rule)
        aid = self.active.get(key)
        if not aid:
            return
        now = time.time()
        first = self.clear_since.setdefault(key, now)
        if now - first < hold:
            return
        self.clear_since.pop(key, None)
        self.active.pop(key, None)
        self._resolve(aid, now)

    def _resolve(self, aid, now):
        self.store.resolve_alert(aid, now)
        a = self.cache.get(aid)
        if a:
            a["resolved_ts"] = now
            if a["severity"] != "critical" or a["ack_ts"]:
                self.cache.pop(aid, None)
            self._emit("update", a)

    def acknowledge(self, aid, user):
        now = time.time()
        self.store.ack_alert(aid, user, now)
        a = self.cache.get(aid) or self.store.alert(aid)
        if not a:
            return None
        a["ack_by"], a["ack_ts"] = a.get("ack_by") or user, a.get("ack_ts") or now
        if a.get("resolved_ts"):
            self.cache.pop(aid, None)
        self._emit("update", a)
        return a

    def open(self):
        return sorted(self.cache.values(), key=lambda a: -a["ts"])

    def level(self, key):
        """Worst open alert level for a drone (drives the tile colour)."""
        lv = None
        for a in self.cache.values():
            if a["drone_key"] != key:
                continue
            if a["severity"] == "critical" and (a["resolved_ts"] is None or a["ack_ts"] is None):
                return "critical"
            if a["severity"] == "warning" and a["resolved_ts"] is None:
                lv = "warning"
        return lv

    def counts(self, key):
        c = {"critical": 0, "warning": 0}
        for a in self.cache.values():
            if a["drone_key"] == key and a["severity"] in c:
                c[a["severity"]] += 1
        return c

    # ---------------------------------------------------------------- hooks from the drones
    def fc_text(self, d, sev, text):
        now = time.time()
        k = (d.key, text)
        if now - self.recent_text.get(k, 0) < 30:
            return
        self.recent_text[k] = now
        if re.match(r"^(pre-?arm|arm):", text, re.I):
            return  # pre-arm checks are shown on the drone screen, not raised as alerts
        kind = next((kd for kd, rx in PATTERNS if rx.search(text)), None)
        if kind in FAILSAFE_KINDS or FS_TEXT.search(text):
            self.raise_alert(d, "critical", "failsafe", text, "flight controller", oneshot=True)
        elif kind in ("crash", "thrust_loss"):
            self.raise_alert(d, "critical", "abnormal_flight", text, "flight controller", oneshot=True)
        elif COMPASS_TEXT.search(text):
            self.raise_alert(d, "warning", "compass", text, "flight controller", oneshot=True)
        elif kind == "gps_issue":
            self.raise_alert(d, "warning", "gps_weak", text, "flight controller", oneshot=True)
        elif kind == "ekf_issue":
            self.raise_alert(d, "warning", "ekf", text, "flight controller", oneshot=True)
        elif sev <= 2:
            self.raise_alert(d, "critical", "fc_critical", text, "flight controller", oneshot=True)
        elif sev == 3:
            self.raise_alert(d, "warning", "fc_error", text, "flight controller", oneshot=True)

    def flight_event(self, d, e):
        if e.get("src") == "fc":
            return  # already raised from the message itself
        if e["type"] == "motor_issue":
            self.raise_alert(d, "critical", "motor_failure", e["text"], "threshold rule", param="motor outputs", oneshot=True, ttl=120)
        elif e["type"] == "vibration_issue":
            self.raise_alert(d, "warning", "vibration", e["text"], "threshold rule", param="vibration", oneshot=True)

    def mode_change(self, d, old, new):
        if new in ("RTL", "SMART_RTL"):
            self.raise_alert(d, "info", "rtl", f"Flight mode {old} → {new}", "flight controller", param="mode", value=new)
        if new == "AUTO":
            self.raise_alert(d, "info", "mission_started", f"Flight mode {old} → AUTO", "flight controller", param="mode", value=new)
        if old == "AUTO" and d.mission.get("total") and d.mission.get("reached") is not None and d.mission["reached"] >= d.mission["total"] - 1:
            self.raise_alert(d, "info", "mission_completed", f"Last waypoint ({d.mission['reached']}) reached, mode {old} → {new}",
                             "flight controller", param="mission")
        if new == "LAND" and d.airborne:
            recent_fs = any(a["drone_key"] == d.key and a["rule"] == "failsafe" and time.time() - a["ts"] < 20 for a in self.cache.values())
            if recent_fs:
                self.raise_alert(d, "critical", "emergency_landing", f"Flight mode {old} → LAND right after a failsafe",
                                 "flight controller", param="mode", value=new, oneshot=True, ttl=300)

    def mission_progress(self, d, prev, seq):
        pass

    def mission_reached(self, d, seq):
        total = d.mission.get("total")
        if total and seq >= total - 1 and d.mode == "AUTO":
            self.raise_alert(d, "info", "mission_completed", f"Last waypoint ({seq}) of {total} reached", "flight controller", param="mission")

    def armed(self, d):
        self.raise_alert(d, "info", "armed", "Motors armed", "flight controller", param="armed", value=True)

    def disarmed(self, d):
        pass

    def took_off(self, d):
        self.raise_alert(d, "info", "takeoff", f"Airborne: {d.t.get('alt', 0):.1f} m above home", "threshold rule", param="altitude")

    def landed(self, d):
        self.raise_alert(d, "info", "landing", "Landed", "threshold rule", param="altitude")

    # ---------------------------------------------------------------- periodic threshold rules (1 Hz)
    def tick(self, video_status=None):
        now = time.time()
        th = self.thresholds
        for aid, exp in list(self.oneshot_expiry.items()):
            if now >= exp:
                self.oneshot_expiry.pop(aid, None)
                self._resolve(aid, now)
        for d in list(self.hub.drones.values()):
            if d.slot is not None and not d.slot.get("enabled", True):
                continue
            t = d.t
            silent = now - d.last_hb if d.last_hb else None
            # connection
            if silent is not None and silent > th["telemetry_lost_s"]:
                if d.armed:
                    self.raise_alert(d, "critical", "telemetry_lost", f"No telemetry for {silent:.0f} s while armed",
                                     "threshold rule", param="last heartbeat", value=round(silent), threshold=f"{th['telemetry_lost_s']:g} s")
                else:
                    self.raise_alert(d, "warning", "gcs_disconnected", f"No telemetry for {silent:.0f} s",
                                     "threshold rule", param="last heartbeat", value=round(silent), threshold=f"{th['telemetry_lost_s']:g} s")
                continue  # stale values: don't evaluate the other rules
            self.clear(d, "telemetry_lost", hold=3)
            self.clear(d, "gcs_disconnected", hold=3)
            if silent is None:
                continue
            pct = t.get("batt_pct")
            if pct is not None:
                if pct <= th["batt_critical_pct"]:
                    self.raise_alert(d, "critical", "battery_critical", f"Battery {pct}% (critical at {th['batt_critical_pct']:g}%)",
                                     "threshold rule", "battery %", pct, f"≤ {th['batt_critical_pct']:g} %")
                    self.clear(d, "battery_low", hold=0)
                elif pct <= th["batt_low_pct"]:
                    self.raise_alert(d, "warning", "battery_low", f"Battery {pct}% (low at {th['batt_low_pct']:g}%)",
                                     "threshold rule", "battery %", pct, f"≤ {th['batt_low_pct']:g} %")
                    self.clear(d, "battery_critical", hold=10)
                else:
                    self.clear(d, "battery_low", hold=10)
                    self.clear(d, "battery_critical", hold=10)
                hist = self.batt_hist.setdefault(d.key, deque(maxlen=120))
                hist.append((now, pct))
                while hist and now - hist[0][0] > 90:
                    hist.popleft()
                if d.armed and len(hist) > 20 and now - hist[0][0] >= 60:
                    rate = (hist[0][1] - pct) / ((now - hist[0][0]) / 60)
                    if rate > th["discharge_pct_per_min"]:
                        self.raise_alert(d, "warning", "discharge_abnormal", f"Battery falling {rate:.1f} %/min (limit {th['discharge_pct_per_min']:g} %/min)",
                                         "threshold rule", "battery discharge", round(rate, 1), f"> {th['discharge_pct_per_min']:g} %/min")
                    else:
                        self.clear(d, "discharge_abnormal", hold=20)
            cells = (d.slot or {}).get("battery_cells") or 0
            v = t.get("volt")
            if cells and v:
                cv = v / cells
                if cv < th["cell_v_critical"] and d.armed:
                    self.raise_alert(d, "critical", "voltage_abnormal", f"{v:.2f} V = {cv:.2f} V per cell ({cells}S; critical below {th['cell_v_critical']:.2f} V)",
                                     "threshold rule", "battery voltage", round(cv, 2), f"< {th['cell_v_critical']:.2f} V/cell")
                elif cv < th["cell_v_low"] and d.armed:
                    self.raise_alert(d, "warning", "cell_low", f"{v:.2f} V = {cv:.2f} V per cell ({cells}S; low below {th['cell_v_low']:.2f} V)",
                                     "threshold rule", "battery voltage", round(cv, 2), f"< {th['cell_v_low']:.2f} V/cell")
                else:
                    self.clear(d, "voltage_abnormal", hold=10)
                    self.clear(d, "cell_low", hold=10)
            # GPS
            fix = t.get("fix")
            if d.armed and fix is not None and fix < 3:
                since = d.alert_ctx.setdefault("nofix", now)
                if now - since >= th["gps_fail_s"]:
                    self.raise_alert(d, "critical", "gps_failure", f"No 3D GPS fix for {now - since:.0f} s while armed (fix type {fix})",
                                     "threshold rule", "GPS fix", fix, "3D fix")
            else:
                d.alert_ctx.pop("nofix", None)
                self.clear(d, "gps_failure", hold=5)
            sats, hdop = t.get("sats"), t.get("hdop")
            if sats is not None and fix and fix >= 2 and sats < th["sats_low"]:
                self.raise_alert(d, "warning", "sats_low", f"{sats} satellites (minimum {th['sats_low']:g})", "threshold rule", "satellites", sats, f"< {th['sats_low']:g}")
            else:
                self.clear(d, "sats_low", hold=10)
            if hdop is not None and hdop > th["hdop_weak"]:
                self.raise_alert(d, "warning", "gps_weak", f"HDOP {hdop:.1f} (limit {th['hdop_weak']:g})", "threshold rule", "HDOP", hdop, f"> {th['hdop_weak']:g}")
            elif (d.key, "gps_weak") in self.active and self.cache.get(self.active[(d.key, "gps_weak")], {}).get("source") == "threshold rule":
                self.clear(d, "gps_weak", hold=10)
            # communication
            link, rssi = d.link_pct(), d.rssi_pct()
            weak = []
            if link is not None and link < th["link_weak_pct"]:
                weak.append(f"{link}% of MAVLink packets received (limit {th['link_weak_pct']:g}%)")
            if rssi is not None and rssi < th["rssi_weak_pct"]:
                weak.append(f"radio RSSI {rssi}% (limit {th['rssi_weak_pct']:g}%)")
            if weak:
                self.raise_alert(d, "warning", "comms_weak", "; ".join(weak), "threshold rule", "link quality", link if link is not None else rssi)
            else:
                self.clear(d, "comms_weak", hold=10)
            # temperature
            hot = [(n, v) for n, (v, ts) in d.temps.items() if now - ts < 30 and v >= th["temp_high_c"]]
            if hot:
                n, v = max(hot, key=lambda x: x[1])
                self.raise_alert(d, "warning", "temp_high", f"{n} at {v:.0f} °C (limit {th['temp_high_c']:g} °C)", "threshold rule", f"{n} temperature", round(v), f"≥ {th['temp_high_c']:g} °C")
            else:
                self.clear(d, "temp_high", hold=10)
            # compass (EKF)
            ekf = t.get("ekf") or {}
            if ekf.get("compass") is not None and ekf["compass"] > th["compass_var"]:
                self.raise_alert(d, "warning", "compass", f"EKF compass variance {ekf['compass']:.2f} (limit {th['compass_var']:g})",
                                 "threshold rule", "EKF compass variance", ekf["compass"], f"> {th['compass_var']:g}")
            elif (d.key, "compass") in self.active and self.cache.get(self.active[(d.key, "compass")], {}).get("source") == "threshold rule":
                self.clear(d, "compass", hold=10)
            # abnormal flight behaviour
            if d.airborne:
                roll, pitch = abs(t.get("roll") or 0), abs(t.get("pitch") or 0)
                vz = t.get("vz")
                if max(roll, pitch) > th["attitude_abnormal_deg"]:
                    self.raise_alert(d, "critical", "abnormal_flight", f"Attitude roll {t.get('roll', 0):.0f}°, pitch {t.get('pitch', 0):.0f}° (limit {th['attitude_abnormal_deg']:g}°)",
                                     "threshold rule", "attitude", round(max(roll, pitch)), f"> {th['attitude_abnormal_deg']:g}°", oneshot=True, ttl=120)
                elif vz is not None and vz < -th["descent_abnormal_ms"] and d.mode not in ("LAND", "RTL", "SMART_RTL"):
                    self.raise_alert(d, "critical", "abnormal_flight", f"Descending at {-vz:.1f} m/s in {d.mode} (limit {th['descent_abnormal_ms']:g} m/s)",
                                     "threshold rule", "vertical speed", round(vz, 1), f"< -{th['descent_abnormal_ms']:g} m/s", oneshot=True, ttl=120)
            # geofence
            gf = (d.slot or {}).get("geofence") or {}
            if d.airborne and gf.get("type") == "circle" and d.home and gf.get("radius_m"):
                r = d.dist_home() or 0
                too_high = gf.get("max_alt_m") and (t.get("alt") or 0) > gf["max_alt_m"]
                if r > gf["radius_m"] or too_high:
                    self.raise_alert(d, "warning", "fence", f"{r:.0f} m from home, {t.get('alt', 0):.0f} m up (fence {gf['radius_m']:g} m radius, {gf.get('max_alt_m', '-')} m ceiling)",
                                     "threshold rule", "geofence", round(r))
                else:
                    self.clear(d, "fence", hold=5)
            if d.fence and d.fence.get("breach"):
                self.raise_alert(d, "warning", "fence", f"Flight controller reports a fence breach (type {d.fence.get('type')})", "flight controller", "FENCE_STATUS", 1)
            # video
            if video_status is not None and d.slot and (d.slot.get("video") or {}).get("type", "none") != "none":
                vs = video_status.get(d.key) or {}
                if vs.get("ready"):
                    d.alert_ctx.pop("novideo", None)
                    self.clear(d, "video_interrupted", hold=3)
                elif vs.get("was_ready") or d.armed:
                    since = d.alert_ctx.setdefault("novideo", now)
                    if now - since >= th["video_interrupt_s"]:
                        self.raise_alert(d, "warning", "video_interrupted", f"No video from {vs.get('path', 'the camera')} for {now - since:.0f} s",
                                         "threshold rule", "video stream", 0, f"{th['video_interrupt_s']:g} s")
