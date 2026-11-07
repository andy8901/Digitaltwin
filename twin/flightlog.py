"""Flight logs: turn a recorded MAVLink telemetry log (.tlog, recorded by this app or uploaded) or an ArduPilot
on-board DataFlash log (.bin) into

  * a timeline: every recorded value resampled onto one clock (up to 10 Hz) for replay, charts and exports, and
  * an incident report: facts measured from that timeline and the flight controller's own messages.

Nothing is filled in: a value the log doesn't contain stays None (shown as N/A), and between two recorded samples
the replay holds the last recorded value instead of interpolating.
"""
import gzip
import json
import math
import re
import time

from pymavlink import mavutil

from . import config

TL_DIR = config.DATA_DIR / "timelines"

COLS = ("ts", "lat", "lon", "alt", "alt_msl", "gs", "vz", "heading", "roll", "pitch", "yaw", "volt", "curr", "batt_pct",
        "sats", "hdop", "fix", "h_acc", "vibe_x", "vibe_y", "vibe_z", "clip", "armed", "mode")
MOTORS = 8

# ArduPilot ERR subsystems (https://ardupilot.org/copter/docs/common-diagnosing-problems-using-logs.html)
ERR_SUBSYS = {
    1: "Main", 2: "Radio", 3: "Compass", 5: "Radio failsafe", 6: "Battery failsafe", 7: "GPS failsafe", 8: "GCS failsafe",
    9: "Fence", 10: "Flight mode change", 11: "GPS", 12: "Crash check", 13: "Flip", 14: "Autotune", 15: "Parachute",
    16: "EKF check", 17: "EKF failsafe", 18: "Barometer", 19: "CPU load", 20: "ADSB failsafe", 21: "Terrain data",
    22: "Navigation", 23: "Terrain failsafe", 24: "EKF primary", 25: "Thrust loss check", 26: "Sensor failsafe",
    27: "Leak failsafe", 28: "Pilot input", 29: "Vibration failsafe", 30: "Internal error", 31: "Dead-reckoning failsafe",
}
# Copter event ids (LogEvent)
EV_NAMES = {10: "armed", 11: "disarmed", 15: "auto armed", 17: "land complete (maybe)", 18: "land complete", 19: "GPS lost",
            25: "home set", 28: "not landed"}


def _acm_name(num):
    mp = getattr(mavutil, "mode_mapping_acm", {}) or {}
    if num in mp and isinstance(mp[num], str):
        return mp[num]
    inv = {v: k for k, v in mp.items() if isinstance(v, int)}
    return inv.get(num, f"mode {num}")


def _num(x):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) or math.isinf(x) else x


class _Rec:
    """Latest value of every field, sampled onto the timeline clock."""

    def __init__(self):
        self.v = dict.fromkeys(COLS)
        self.motors = [None] * MOTORS
        self.src = {}            # field -> message it came from (shown as the data source)
        self.rate = {}           # message -> count (for the native rate)

    def set(self, src, **kw):
        for k, x in kw.items():
            if x is not None:
                self.v[k] = x
                self.src.setdefault(k, src)


def parse(path, kind=None, progress=None):
    """Read a .tlog or .bin and return the timeline dict. Raises ValueError for an unreadable file."""
    path = str(path)
    kind = kind or ("bin" if path.lower().endswith((".bin", ".log")) else "tlog")
    try:
        mlog = mavutil.mavlink_connection(path, dialect="ardupilotmega", robust_parsing=True, notimestamps=False)
    except Exception as e:
        raise ValueError(f"not a readable {kind} log: {e}")
    r = _Rec()
    msgs, events, modes = [], [], []
    home = origin = None
    samples = []
    t0 = None
    step = 0.1
    next_t = None
    ap_sys = None
    last_armed = None
    n = 0
    want_tlog = ["HEARTBEAT", "GLOBAL_POSITION_INT", "GPS_RAW_INT", "VFR_HUD", "ATTITUDE", "SYS_STATUS", "BATTERY_STATUS",
                 "VIBRATION", "SERVO_OUTPUT_RAW", "STATUSTEXT", "HOME_POSITION", "SYSTEM_TIME"]
    want_bin = ["GPS", "POS", "ATT", "BAT", "MODE", "ARM", "EV", "VIBE", "RCOU", "MSG", "CTUN", "ERR", "ORGN"]
    while True:
        try:
            m = mlog.recv_match(type=want_bin if kind == "bin" else want_tlog)
        except Exception:
            continue
        if m is None:
            break
        n += 1
        if progress and n % 20000 == 0:
            progress(n)
        typ = m.get_type()
        if typ == "BAD_DATA":
            continue
        ts = getattr(m, "_timestamp", None)
        if not ts:
            continue
        if kind == "tlog":
            sysid = m.get_srcSystem()
            if typ == "HEARTBEAT":
                if m.type == 6 or m.autopilot == 8:     # a GCS or a non-autopilot component
                    continue
                if ap_sys is None:
                    ap_sys = sysid
            if ap_sys is None or sysid != ap_sys:
                continue
        r.rate[typ] = r.rate.get(typ, 0) + 1
        if t0 is None:
            t0 = ts
            next_t = ts
        # sample before applying this message: the timeline holds what was known at each tick
        while next_t is not None and ts >= next_t:
            samples.append((next_t, dict(r.v), list(r.motors)))
            next_t += step
        if kind == "tlog":
            _tlog(m, typ, ts, r, msgs, modes)
            if typ == "HOME_POSITION":
                home = (m.latitude / 1e7, m.longitude / 1e7, m.altitude / 1000.0)
        else:
            h = _bin(m, typ, ts, r, msgs, events, modes)
            if h and h[0] == "origin" and origin is None:
                origin = h[1]
            elif h and h[0] == "home":
                home = h[1]
        if r.v["armed"] is not None and r.v["armed"] != last_armed:
            if last_armed is not None or r.v["armed"]:
                events.append({"ts": ts, "type": "armed" if r.v["armed"] else "disarmed", "text": "Armed" if r.v["armed"] else "Disarmed"})
            last_armed = r.v["armed"]
    if t0 is None or not samples:
        raise ValueError("the log contains no flight-controller data this app can read")
    # downsample very long logs to keep the replay light (still >= 2 Hz for a 2 h log)
    if len(samples) > 36000:
        k = math.ceil(len(samples) / 36000)
        samples = samples[::k]
        step *= k
    out = {c: [] for c in COLS}
    mot = [[] for _ in range(MOTORS)]
    for t, v, mo in samples:
        for c in COLS:
            x = v[c]
            if isinstance(x, float):
                x = round(x, 7 if c in ("lat", "lon") else 3 if c in ("volt",) else 2)
            out[c].append(x)
        for i in range(MOTORS):
            mot[i].append(mo[i])
    out["ts"] = [round(t, 2) for t, _, _ in samples]
    used = [i for i in range(MOTORS) if any(x for x in mot[i] if x and x > 900)]
    dur = samples[-1][0] - t0
    pos_src = r.src.get("lat", "")
    return {
        "version": 1, "kind": kind, "t0": t0, "dt": step, "n": len(samples), "duration_s": round(dur, 1),
        "cols": out, "motors": [mot[i] for i in used], "motor_channels": [i + 1 for i in used],
        "msgs": msgs, "events": sorted(events, key=lambda e: e["ts"]), "modes": modes,
        "home": home, "origin": origin, "sources": r.src,
        "rates": {k: round(c / dur, 1) if dur > 0 else None for k, c in r.rate.items()},
        "position_source": {"POS": "EKF position (POS)", "GLOBAL_POSITION_INT": "EKF position (GLOBAL_POSITION_INT)",
                            "GPS": "GPS fixes (GPS)", "GPS_RAW_INT": "GPS fixes (GPS_RAW_INT)"}.get(pos_src, pos_src or "none"),
        "position_rate_hz": (round(r.rate.get(pos_src, 0) / dur, 1) if dur > 0 and pos_src else None),
    }


def _tlog(m, typ, ts, r, msgs, modes):
    if typ == "GLOBAL_POSITION_INT":
        if m.lat or m.lon:
            r.set(typ, lat=m.lat / 1e7, lon=m.lon / 1e7, alt_msl=m.alt / 1000.0, alt=m.relative_alt / 1000.0, vz=-m.vz / 100.0)
            if m.hdg != 65535:
                r.set(typ, heading=m.hdg / 100.0)
    elif typ == "GPS_RAW_INT":
        r.set(typ, fix=m.fix_type, sats=m.satellites_visible if m.satellites_visible != 255 else None,
              hdop=m.eph / 100.0 if m.eph != 65535 else None,
              h_acc=(m.h_acc / 1000.0) if getattr(m, "h_acc", 0) else None)
        if r.v["lat"] is None and m.fix_type >= 3:
            r.set(typ, lat=m.lat / 1e7, lon=m.lon / 1e7, alt_msl=m.alt / 1000.0)
    elif typ == "VFR_HUD":
        r.set(typ, gs=m.groundspeed)
        if r.v["heading"] is None:
            r.set(typ, heading=float(m.heading))
    elif typ == "ATTITUDE":
        r.set(typ, roll=math.degrees(m.roll), pitch=math.degrees(m.pitch), yaw=math.degrees(m.yaw) % 360)
    elif typ == "SYS_STATUS":
        r.set(typ, volt=m.voltage_battery / 1000.0 if m.voltage_battery not in (0, 65535) else None,
              curr=m.current_battery / 100.0 if m.current_battery >= 0 else None,
              batt_pct=m.battery_remaining if m.battery_remaining >= 0 else None)
    elif typ == "BATTERY_STATUS":
        if m.current_battery >= 0:
            r.set(typ, curr=m.current_battery / 100.0)
        if m.battery_remaining >= 0:
            r.set(typ, batt_pct=m.battery_remaining)
    elif typ == "VIBRATION":
        r.set(typ, vibe_x=m.vibration_x, vibe_y=m.vibration_y, vibe_z=m.vibration_z,
              clip=m.clipping_0 + m.clipping_1 + m.clipping_2)
    elif typ == "SERVO_OUTPUT_RAW":
        for i in range(MOTORS):
            r.motors[i] = getattr(m, f"servo{i + 1}_raw", None) or None
    elif typ == "HEARTBEAT":
        armed = bool(m.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
        mode = mavutil.mode_string_v10(m)
        if mode != r.v["mode"]:
            modes.append({"ts": ts, "mode": mode})
        r.set(typ, armed=armed, mode=mode)
    elif typ == "STATUSTEXT":
        msgs.append({"ts": ts, "sev": m.severity, "text": m.text.strip()})


def _bin(m, typ, ts, r, msgs, events, modes):
    if typ == "POS":
        r.set(typ, lat=_num(m.Lat), lon=_num(m.Lng), alt_msl=_num(m.Alt))
        rel = _num(getattr(m, "RelHomeAlt", None))
        if rel is not None:
            r.set(typ, alt=rel)
    elif typ == "GPS":
        if getattr(m, "I", 0) not in (0, None):
            return None
        r.set(typ, fix=int(m.Status), sats=int(m.NSats), hdop=_num(m.HDop), gs=_num(m.Spd))
        if getattr(m, "VZ", None) is not None:
            r.set(typ, vz=-_num(m.VZ) if _num(m.VZ) is not None else None)
        if r.src.get("lat") in (None, "GPS") and m.Status >= 3:
            r.set(typ, lat=_num(m.Lat), lon=_num(m.Lng), alt_msl=_num(m.Alt))
        if _num(m.Spd) and _num(m.Spd) > 0.5:
            r.set(typ, heading=_num(m.GCrs))
    elif typ == "ATT":
        r.set(typ, roll=_num(m.Roll), pitch=_num(m.Pitch), yaw=(_num(m.Yaw) or 0) % 360)
        if r.v["gs"] is None or (r.v["gs"] or 0) <= 0.5:
            r.set(typ, heading=(_num(m.Yaw) or 0) % 360)
    elif typ == "CTUN":
        if r.src.get("alt") in (None, "CTUN"):
            r.set(typ, alt=_num(m.Alt))
    elif typ == "BAT":
        if getattr(m, "Inst", 0) not in (0, None):
            return None
        r.set(typ, volt=_num(m.Volt), curr=_num(m.Curr))
        if getattr(m, "RemPct", None) is not None:
            r.set(typ, batt_pct=int(m.RemPct))
    elif typ == "VIBE":
        if getattr(m, "IMU", 0) != 0:
            return None
        r.set(typ, vibe_x=_num(m.VibeX), vibe_y=_num(m.VibeY), vibe_z=_num(m.VibeZ), clip=getattr(m, "Clip", None))
    elif typ == "RCOU":
        for i in range(MOTORS):
            x = getattr(m, f"C{i + 1}", None)
            r.motors[i] = x or None
    elif typ == "MODE":
        name = _acm_name(int(m.ModeNum if getattr(m, "ModeNum", None) is not None else m.Mode))
        modes.append({"ts": ts, "mode": name})
        r.set(typ, mode=name)
    elif typ == "ARM":
        r.set(typ, armed=bool(m.ArmState))
    elif typ == "EV":
        if m.Id in (10, 15):
            r.set(typ, armed=True)
        elif m.Id == 11:
            r.set(typ, armed=False)
        name = EV_NAMES.get(m.Id)
        if name and m.Id not in (10, 11, 15):
            events.append({"ts": ts, "type": "ev", "text": name.capitalize()})
    elif typ == "MSG":
        txt = str(m.Message).strip()
        sev = 6 if re.search(r"clear|resolved|recovered", txt, re.I) else \
            2 if re.search(r"crash|thrust loss|failsafe|emergency|critical", txt, re.I) else \
            3 if re.search(r"error|fail|glitch|bad|unhealthy|lost", txt, re.I) else 6
        msgs.append({"ts": ts, "sev": sev, "text": txt})
    elif typ == "ERR":
        sub = ERR_SUBSYS.get(int(m.Subsys), f"subsystem {m.Subsys}")
        code = int(m.ECode)
        if code == 0:
            text = f"{sub}: cleared"
        elif m.Subsys == 12:
            text = {1: "Crash detected", 2: "Loss of control"}.get(code, f"Crash check code {code}")
        elif m.Subsys == 25:
            text = "Thrust loss: a motor at full output while the drone kept descending"
        else:
            text = f"{sub} (error code {code})"
        events.append({"ts": ts, "type": "err", "subsys": int(m.Subsys), "code": code, "text": text, "cleared": code == 0})
    elif typ == "ORGN":
        p = (_num(m.Lat), _num(m.Lng), _num(m.Alt))
        return ("home", p) if getattr(m, "Type", 0) == 1 else ("origin", p)
    return None


# ------------------------------------------------------------------ analysis

def _hav(a, b, c, d):
    p = math.pi / 180
    x = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 12742000 * math.asin(math.sqrt(x))


def _bearing_word(a, b, c, d):
    y = math.sin((d - b) * math.pi / 180) * math.cos(c * math.pi / 180)
    x = math.cos(a * math.pi / 180) * math.sin(c * math.pi / 180) - math.sin(a * math.pi / 180) * math.cos(c * math.pi / 180) * math.cos((d - b) * math.pi / 180)
    deg = (math.degrees(math.atan2(y, x)) + 360) % 360
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][int((deg + 22.5) // 45) % 8]


def analyse(tl, thresholds, cells=None):
    """Incident report from a timeline. Every finding cites the values it was measured from."""
    c = tl["cols"]
    ts = c["ts"]
    N = len(ts)
    t0 = tl["t0"]
    armed = c["armed"]
    has_arm = any(a is not None for a in armed)
    alt = c["alt"]
    gs = c["gs"]
    findings = []

    def add(level, kind, title, detail, t=None, value=None):
        i = None
        if t is not None:
            i = min(range(N), key=lambda k: abs(ts[k] - t)) if N < 4000 else _idx(ts, t)
        findings.append({"level": level, "kind": kind, "title": title, "detail": detail,
                         "t": round(t - t0, 1) if t else None, "ts": t, "value": value,
                         "lat": c["lat"][i] if i is not None else None, "lon": c["lon"][i] if i is not None else None,
                         "alt": alt[i] if i is not None else None})

    # flight segments: armed periods; when the log has no arming info, use "above 1 m"
    def flying(i):
        return armed[i] if has_arm and armed[i] is not None else (alt[i] or 0) > 1
    segs = []
    start = None
    for i in range(N):
        f = flying(i)
        if f and start is None:
            start = i
        elif not f and start is not None:
            segs.append((start, i - 1))
            start = None
    if start is not None:
        segs.append((start, N - 1))
    airborne_idx = [i for i in range(N) if (alt[i] or 0) > 1 and flying(i)]
    to_i = airborne_idx[0] if airborne_idx else (segs[0][0] if segs else None)
    # take-off / landing
    a0 = segs[0][0] if segs else 0
    a1 = segs[-1][1] if segs else N - 1
    takeoff = (c["lat"][to_i], c["lon"][to_i]) if to_i is not None and c["lat"][to_i] is not None else None
    land_i = a1 if segs else None
    landing = (c["lat"][land_i], c["lon"][land_i]) if land_i is not None and c["lat"][land_i] is not None else None
    # distance, maxima (while armed)
    dist = 0.0
    prev = None
    for i in range(a0, a1 + 1):
        la, lo = c["lat"][i], c["lon"][i]
        if la is None or (c["fix"][i] is not None and c["fix"][i] < 3 and tl["sources"].get("lat") in ("GPS", "GPS_RAW_INT")):
            continue
        if prev and (la, lo) != prev:
            d = _hav(prev[0], prev[1], la, lo)
            if d < 200:   # ignore position jumps (bad fixes) rather than adding them
                dist += d
        prev = (la, lo)
    vals = lambda col, rng=range(a0, a1 + 1): [c[col][i] for i in rng if c[col][i] is not None]
    mx = lambda col: max(vals(col), default=None)
    air_time = sum((ts[j] - ts[i]) for i, j in segs)
    flight_time = (ts[airborne_idx[-1]] - ts[airborne_idx[0]]) if airborne_idx else 0
    # take-off / landing voltage: last value before lift-off, last value before disarm / end
    v_to = next((c["volt"][i] for i in range((to_i or a0), -1, -1) if c["volt"][i] is not None), None) if N else None
    v_land = next((c["volt"][i] for i in range(a1, -1, -1) if c["volt"][i] is not None), None)
    v_min = min(vals("volt"), default=None)

    # ---- termination
    last = N - 1
    end_armed = bool(armed[last]) if has_arm else None
    end_alt, end_gs = alt[last], gs[last]
    term = "unknown"
    term_text = "The log doesn't show how the flight ended."
    if not segs:
        term, term_text = "no_flight", "The drone was never armed in this log."
    elif has_arm and end_armed and (end_alt or 0) > 2:
        dn = _hav(takeoff[0], takeoff[1], c["lat"][last], c["lon"][last]) if takeoff and c["lat"][last] is not None else None
        word = _bearing_word(takeoff[0], takeoff[1], c["lat"][last], c["lon"][last]) if dn is not None else ""
        term = "log_ends_airborne"
        term_text = (f"The log stops while the drone is still flying: {end_alt:.0f} m up, {end_gs or 0:.1f} m/s"
                     + (f", {dn:.0f} m {word} of take-off" if dn is not None else ""))
        add("critical", "log_ends_airborne", "Log ends in mid-air",
            f"Last record: armed, {end_alt:.1f} m above home, {end_gs or 0:.1f} m/s. The recording stopped before landing "
            f"(power loss, a crash, or the log/link being cut).", ts[last], end_alt)
    elif has_arm and end_armed:
        term, term_text = "ends_armed", "The log ends with the drone armed on the ground."
    else:
        # disarmed: where, and was it moving? A drone resting on higher ground (or on an object) also shows altitude.
        crash_t = next((e["ts"] for e in tl["events"] if e["type"] == "err" and e.get("subsys") == 12 and e.get("code")), None) or \
            next((m["ts"] for m in tl["msgs"] if re.search(r"crash", m["text"], re.I) and m["sev"] <= 3), None)
        land_ts = [e["ts"] for e in tl["events"] if e["text"].lower().startswith("land complete")]
        win = max(1, int(3 / tl["dt"]))
        dis_i = None
        for i in range(1, N):
            if armed[i - 1] and armed[i] is False:
                dis_i = i
                h = alt[i - 1] or 0
                moving = any(abs(c["vz"][j] or 0) > 1.0 or (gs[j] or 0) > 1.5 for j in range(max(0, i - win), i))
                landed = any(ts[i] - 4 <= t <= ts[i] + 1 for t in land_ts)
                if h > 3 and moving and not landed and crash_t is None:
                    add("critical", "disarm_in_air", "Motors disarmed in flight",
                        f"Disarmed at {h:.1f} m above home while moving ({gs[i - 1] or 0:.1f} m/s, vertical {c['vz'][i - 1] or 0:.1f} m/s).", ts[i], h)
                elif h > 3:
                    add("warning", "disarm_high", "Disarmed above home level",
                        f"Disarmed {h:.1f} m above home while stationary: the drone was resting on higher ground or on an object.", ts[i], h)
        if crash_t is not None:
            i = _idx(ts, crash_t)
            m_txt = next((m["text"] for m in tl["msgs"] if abs(m["ts"] - crash_t) < 2 and re.search(r"crash", m["text"], re.I)), "")
            term = "crash"
            term_text = (f"The flight controller detected a crash and disarmed the motors{f' ({m_txt})' if m_txt else ''}. "
                         f"At that moment the drone was {alt[i] or 0:.1f} m above home, moving {gs[i] or 0:.1f} m/s, in {c['mode'][i] or 'unknown mode'}.")
        elif any(f["kind"] == "disarm_in_air" for f in findings):
            term, term_text = "disarmed_in_air", "The motors were disarmed while the drone was flying."
        elif dis_i is not None:
            term, term_text = "landed", "Landed and disarmed."
        elif not has_arm:
            term = "landed" if (end_alt or 0) < 1 else "unknown"
            term_text = "No arming records; the log ends on the ground." if term == "landed" else term_text

    # ---- flight-controller findings (as logged) while armed; messages on the ground stay in the message list
    w0, w1 = (ts[a0] - 1, ts[a1] + 5) if segs else (0, 0)
    for e in tl["events"]:
        if e["type"] == "err" and not e.get("cleared") and w0 <= e["ts"] <= w1:
            lvl = "critical" if e["subsys"] in (5, 6, 7, 8, 12, 17, 25, 26, 29, 31) else "warning"
            add(lvl, "fc_error", f"Flight controller: {ERR_SUBSYS.get(e['subsys'], 'error')}", e["text"], e["ts"])
    for mm in tl["msgs"]:
        if not (w0 <= mm["ts"] <= w1) or re.match(r"^(pre-?arm|arm):", mm["text"], re.I):
            continue  # pre-arm checks after landing are not flight events
        if mm["sev"] <= 2:
            add("critical", "fc_message", "Flight-controller message", mm["text"], mm["ts"])
        elif mm["sev"] == 3:
            add("warning", "fc_message", "Flight-controller error message", mm["text"], mm["ts"])
    _dedupe(findings)

    # ---- battery
    cv_low, cv_crit = thresholds.get("cell_v_low", 3.5), thresholds.get("cell_v_critical", 3.3)
    if cells and v_to and not (3.0 <= v_to / cells <= 4.45):
        add("warning", "cells_mismatch", "Battery cell count doesn't match this log",
            f"{v_to:.2f} V at take-off is {v_to / cells:.2f} V/cell for the {cells} cells set for this drone; per-cell checks were skipped. "
            f"Check the battery cells in System settings.")
        cells = None
    if cells and v_min is not None:
        pc = v_min / cells
        if pc < cv_crit:
            add("critical", "cell_low", "Battery cell voltage below the critical limit",
                f"Lowest {v_min:.2f} V = {pc:.2f} V/cell (critical limit {cv_crit} V/cell, {cells} cells).",
                ts[_argmin(c["volt"], a0, a1)], v_min)
        elif pc < cv_low:
            add("warning", "cell_low", "Battery cell voltage below the low limit",
                f"Lowest {v_min:.2f} V = {pc:.2f} V/cell (low limit {cv_low} V/cell, {cells} cells).", ts[_argmin(c["volt"], a0, a1)], v_min)
    # sudden voltage drop: >= 8 % of the pack within 2 s while armed (not explained by a current step alone)
    win = max(1, int(2 / tl["dt"]))
    i = a0 + win
    while i <= a1:
        v1, v0 = c["volt"][i], c["volt"][i - win]
        if v1 is not None and v0 and (v0 - v1) / v0 >= 0.08:
            add("warning", "voltage_drop", "Sudden battery voltage drop",
                f"{v0:.2f} V → {v1:.2f} V within 2 s ({(v0 - v1) / v0 * 100:.0f} %)"
                + (f", current {c['curr'][i]:.1f} A" if c["curr"][i] is not None else "") + ".", ts[i], v1)
            i += int(10 / tl["dt"])
            continue
        i += 1
    # ---- GPS
    bad = [i for i in range(a0, a1 + 1) if c["fix"][i] is not None and c["fix"][i] < 3]
    if bad:
        add("critical" if any((alt[i] or 0) > 2 for i in bad) else "warning", "gps_failure", "GPS lost 3D fix while armed",
            f"No 3D fix for {len(bad) * tl['dt']:.0f} s in total (first at T+{ts[bad[0]] - t0:.0f} s).", ts[bad[0]])
    lows = [i for i in range(a0, a1 + 1) if c["sats"][i] is not None and c["sats"][i] < thresholds.get("sats_low", 8)]
    if lows:
        add("warning", "sats_low", "Low satellite count",
            f"Down to {min(c['sats'][i] for i in lows)} satellites (limit {thresholds.get('sats_low', 8)}) for {len(lows) * tl['dt']:.0f} s.", ts[lows[0]])
    hd = [i for i in range(a0, a1 + 1) if c["hdop"][i] is not None and c["hdop"][i] > thresholds.get("hdop_weak", 2.0)]
    if hd:
        add("warning", "gps_weak", "Weak GPS (high HDOP)",
            f"HDOP up to {max(c['hdop'][i] for i in hd):.1f} (limit {thresholds.get('hdop_weak', 2.0)}) for {len(hd) * tl['dt']:.0f} s.", ts[hd[0]])
    # ---- vibration (ArduPilot guidance: below 30 m/s/s is fine, above 60 is a problem)
    for ax in ("x", "y", "z"):
        v = vals(f"vibe_{ax}")
        if v and max(v) > 60:
            add("warning", "vibration", f"High vibration ({ax.upper()} axis)", f"Peak {max(v):.0f} m/s² (ArduPilot guidance: above 60 is too high).",
                ts[_argmax(c[f'vibe_{ax}'], a0, a1)], max(v))
    clips = vals("clip")
    if clips and max(clips) - min(clips) > 0:
        add("warning", "clipping", "Accelerometer clipping", f"{int(max(clips) - min(clips))} clipping events while armed.")
    # ---- attitude / descent
    lim = thresholds.get("attitude_abnormal_deg", 45)
    for i in range(a0, a1 + 1):
        r_, p_ = c["roll"][i], c["pitch"][i]
        if (alt[i] or 0) > 2 and ((r_ is not None and abs(r_) > lim) or (p_ is not None and abs(p_) > lim)):
            add("critical", "attitude", "Abnormal attitude", f"Roll {r_:.0f}°, pitch {p_:.0f}° (limit {lim}°) at {alt[i]:.0f} m.", ts[i])
            break
    dlim = thresholds.get("descent_abnormal_ms", 6.0)
    for i in range(a0, a1 + 1):
        vz = c["vz"][i]
        if vz is not None and vz < -dlim and (alt[i] or 0) > 2 and (c["mode"][i] or "") not in ("LAND", "RTL", "SMART_RTL"):
            add("critical", "descent", "Abnormal descent rate", f"Descending at {-vz:.1f} m/s (limit {dlim}) in {c['mode'][i] or 'unknown mode'} at {alt[i]:.0f} m.", ts[i])
            break
    # ---- motor saturation
    if tl["motors"]:
        k = len(tl["motors"])
        run = 0
        for i in range(a0, a1 + 1):
            row = [tl["motors"][j][i] for j in range(k)]
            if all(x is not None for x in row) and max(row) >= 1950 and (alt[i] or 0) > 1 and sum(row) / k < 1800:
                run += 1
                if run * tl["dt"] >= 1.0:
                    j = row.index(max(row))
                    add("critical", "motor_saturation", "Motor at full output",
                        f"Motor {tl['motor_channels'][j]} at {max(row)} µs while the average was {sum(row) / k:.0f} µs (possible motor/ESC/propeller problem).", ts[i])
                    break
            else:
                run = 0
    ref = (tl["home"][0], tl["home"][1]) if tl["home"] else takeoff
    far = max((_hav(ref[0], ref[1], c["lat"][i], c["lon"][i]) for i in range(a0, a1 + 1) if c["lat"][i] is not None), default=None) if ref else None
    findings.sort(key=lambda f: (f["ts"] or 0))
    crit = [f for f in findings if f["level"] == "critical"]
    warn = [f for f in findings if f["level"] == "warning"]
    level = "critical" if crit else "warning" if warn else "normal"
    if term == "log_ends_airborne":
        headline = term_text
    elif term == "crash":
        i = _idx(ts, crash_t)
        headline = f"Crash detected: the flight controller disarmed the motors in {c['mode'][i] or 'flight'}, {alt[i] or 0:.0f} m above home"
    elif term == "disarmed_in_air":
        f = next(x for x in findings if x["kind"] == "disarm_in_air")
        headline = f"The motors were disarmed in flight, {f['value']:.0f} m above home"
    elif crit:
        first = crit[0]["detail"] if crit[0]["kind"] in ("fc_message", "fc_error") else crit[0]["title"]
        headline = f"{first}" + (f" and {len(crit) - 1} more critical finding{'s' if len(crit) > 2 else ''}" if len(crit) > 1 else "")
    elif warn:
        headline = f"Flight completed with {len(warn)} warning{'s' if len(warn) > 1 else ''}"
    elif not segs:
        headline = "No flight in this log (never armed)"
    else:
        headline = "Normal flight: landed and disarmed, no abnormalities found"
    return {
        "version": 1, "analysed": time.time(), "level": level, "headline": headline,
        "termination": term, "termination_text": term_text,
        "start_ts": t0, "end_ts": ts[-1] if ts else t0, "log_duration_s": tl["duration_s"],
        "armed_s": round(air_time, 1), "flight_time_s": round(flight_time, 1),
        "max_alt_m": _r(mx("alt")), "max_speed_ms": _r(mx("gs")), "distance_m": round(dist), "max_range_m": _r(far, 0),
        "volt_takeoff": _r(v_to, 2), "volt_landing": _r(v_land, 2), "volt_min": _r(v_min, 2), "max_current_a": _r(mx("curr")),
        "batt_start_pct": next((x for x in c["batt_pct"][a0:a1 + 1] if x is not None), None),
        "batt_end_pct": next((x for x in reversed(c["batt_pct"][a0:a1 + 1]) if x is not None), None),
        "takeoff": takeoff, "landing": landing if term in ("landed", "ends_armed", "disarmed_in_air") else None,
        "last_position": (c["lat"][-1], c["lon"][-1]) if c["lat"][-1] is not None else None,
        "home": tl["home"], "modes": sorted({m["mode"] for m in tl["modes"]}),
        "findings": findings, "counts": {"critical": len(crit), "warning": len(warn)},
        "fc_messages": len(tl["msgs"]), "fc_errors": sum(1 for m in tl["msgs"] if m["sev"] <= 3) + sum(1 for e in tl["events"] if e["type"] == "err" and not e.get("cleared")),
        "position_source": tl["position_source"], "position_rate_hz": tl["position_rate_hz"], "samples": tl["n"], "sample_hz": round(1 / tl["dt"], 1),
        "kind": tl["kind"],
    }


def _dedupe(f):
    seen = set()
    keep = []
    for x in f:
        k = (x["kind"], x["detail"])
        if k in seen:
            continue
        seen.add(k)
        keep.append(x)
    f[:] = keep


def _idx(ts, t):
    lo, hi = 0, len(ts) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if ts[mid] < t:
            lo = mid + 1
        else:
            hi = mid
    return lo


def _argmin(col, a, b):
    best, bi = None, a
    for i in range(a, b + 1):
        if col[i] is not None and (best is None or col[i] < best):
            best, bi = col[i], i
    return bi


def _argmax(col, a, b):
    best, bi = None, a
    for i in range(a, b + 1):
        if col[i] is not None and (best is None or col[i] > best):
            best, bi = col[i], i
    return bi


def _r(x, n=1):
    return None if x is None else round(x, n)


def track_points(tl, every_s=1.0):
    """Downsampled (t, lat, lon, alt) for maps and the points table."""
    c = tl["cols"]
    k = max(1, int(every_s / tl["dt"]))
    out = []
    for i in range(0, tl["n"], k):
        if c["lat"][i] is not None:
            out.append((c["ts"][i] - tl["t0"], c["lat"][i], c["lon"][i], c["alt"][i]))
    return out


# ------------------------------------------------------------------ cache

def save(fid, tl):
    TL_DIR.mkdir(parents=True, exist_ok=True)
    with gzip.open(TL_DIR / f"{fid}.json.gz", "wt") as f:
        json.dump(tl, f, separators=(",", ":"))


def load(fid):
    p = TL_DIR / f"{fid}.json.gz"
    if not p.exists():
        return None
    with gzip.open(p, "rt") as f:
        return json.load(f)


def from_telemetry(rows, t_start):
    """Fallback timeline from the 1 Hz telemetry table (flights recorded without a .tlog): no attitude or vibration."""
    if not rows:
        return None
    cols = {c: [] for c in COLS}
    for r in rows:
        for c in COLS:
            cols[c].append(r.get(c) if c not in ("armed",) else True)
    t0 = rows[0]["ts"]
    return {"version": 1, "kind": "telemetry", "t0": t0, "dt": 1.0, "n": len(rows), "duration_s": round(rows[-1]["ts"] - t0, 1),
            "cols": cols, "motors": [], "motor_channels": [], "msgs": [], "events": [], "modes": [], "home": None, "origin": None,
            "sources": {"lat": "telemetry"}, "rates": {}, "position_source": "1 Hz telemetry record", "position_rate_hz": 1.0}
