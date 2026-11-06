"""Fleet health: a component-by-component view of each drone, built only from data the drone actually sends.

Every component is "healthy", "warning", "critical" or "unavailable" (no data received, e.g. the flight controller
doesn't send ESC telemetry). The health score averages only the components that have data (healthy 100,
warning 60, critical 0), so missing data never counts as good or bad: it's shown as unavailable.
"""
import time

SCORE = {"healthy": 100, "warning": 60, "critical": 0}


def _c(name, status, detail, value=None):
    return {"name": name, "status": status, "detail": detail, "value": value}


def drone_health(d, th, video=None, alert_level=None):
    now = time.time()
    t = d.t
    live = d.last_hb and now - d.last_hb < 15
    comps = []

    # battery
    pct, v = t.get("batt_pct"), t.get("volt")
    cells = (d.slot or {}).get("battery_cells") or 0
    if not live or (pct is None and v is None):
        comps.append(_c("Battery", "unavailable", "no battery data"))
    else:
        st, bits = "healthy", []
        if pct is not None:
            bits.append(f"{pct}%")
            st = "critical" if pct <= th["batt_critical_pct"] else "warning" if pct <= th["batt_low_pct"] else st
        if v:
            bits.append(f"{v:.2f} V" + (f" ({v / cells:.2f} V/cell)" if cells else ""))
            if cells and d.armed:
                cv = v / cells
                if cv < th["cell_v_critical"]:
                    st = "critical"
                elif cv < th["cell_v_low"] and st == "healthy":
                    st = "warning"
        bt = t.get("batt_temp")
        if bt is not None:
            bits.append(f"{bt:.0f} °C")
            if bt >= th["temp_high_c"] and st == "healthy":
                st = "warning"
        comps.append(_c("Battery", st, ", ".join(bits), pct))

    # motors (outputs balance)
    if not live or not d.motors:
        comps.append(_c("Motors", "unavailable", "no motor output data"))
    else:
        m = d.motors
        if d.armed and d.airborne and len(m) >= 4:
            hi, lo = max(m), min(m)
            st = "critical" if hi >= 1950 and hi - sum(m) / len(m) > 300 else "warning" if hi - lo > 300 else "healthy"
            comps.append(_c("Motors", st, f"outputs {lo}–{hi} µs (spread {hi - lo} µs)", hi - lo))
        else:
            comps.append(_c("Motors", "healthy", "idle" if not d.armed else f"outputs {min(m)}–{max(m)} µs"))

    # ESC telemetry
    esc = [e for e in d.esc.values() if now - e["ts"] < 10]
    if not live or not esc:
        comps.append(_c("ESC", "unavailable", "the flight controller sends no ESC telemetry"))
    else:
        temps = [e["temp"] for e in esc if e["temp"]]
        stopped = d.airborne and any(e["rpm"] == 0 for e in esc) and any(e["rpm"] > 0 for e in esc)
        st = "critical" if stopped else "warning" if temps and max(temps) >= th["temp_high_c"] else "healthy"
        comps.append(_c("ESC", st, ("a motor reports 0 rpm while others spin; " if stopped else "")
                        + (f"max {max(temps)} °C" if temps else f"{len(esc)} ESCs reporting")))

    # GPS
    fix, sats, hdop = t.get("fix"), t.get("sats"), t.get("hdop")
    if not live or fix is None:
        comps.append(_c("GPS", "unavailable", "no GPS data"))
    else:
        st = "critical" if fix < 3 and d.armed else "warning" if fix < 3 or (sats is not None and sats < th["sats_low"]) or (hdop is not None and hdop > th["hdop_weak"]) else "healthy"
        names = ["no GPS", "no fix", "2D fix", "3D fix", "DGPS", "RTK float", "RTK fixed", "static", "PPP"]
        comps.append(_c("GPS", st, f"{names[fix] if fix < len(names) else fix}, {sats} satellites, HDOP {hdop}", sats))

    # flight controller
    if not live:
        comps.append(_c("Flight controller", "unavailable", "no heartbeat"))
    else:
        ekf = t.get("ekf") or {}
        bad_sensors = [s["name"] for s in (d.sensor_report() or []) if not s["ok"]]
        st, bits = "healthy", []
        if d.system_status is not None and d.system_status >= 5:
            st = "critical"
            bits.append({5: "critical state", 6: "emergency", 7: "powering off", 8: "terminating"}.get(d.system_status, f"state {d.system_status}"))
        if ekf.get("max") is not None:
            bits.append(f"EKF variance {ekf['max']:.2f}")
            if ekf["max"] >= 0.8:
                st = "critical"
            elif ekf["max"] >= 0.5 and st == "healthy":
                st = "warning"
        if t.get("load") is not None:
            bits.append(f"CPU load {t['load']:.0f}%")
        if bad_sensors and st == "healthy":
            st = "warning"
        comps.append(_c("Flight controller", st, ", ".join(bits) or "heartbeat OK"))

    # communication link
    if not d.last_hb:
        comps.append(_c("Communication link", "unavailable", "never connected"))
    else:
        age = now - d.last_hb
        link, rssi = d.link_pct(), d.rssi_pct()
        if age > th["telemetry_lost_s"]:
            st = "critical" if d.armed else "warning"
            det = f"no telemetry for {age:.0f} s"
        else:
            st = "warning" if (link is not None and link < th["link_weak_pct"]) or (rssi is not None and rssi < th["rssi_weak_pct"]) else "healthy"
            det = ", ".join(x for x in [f"{link}% packets" if link is not None else "", f"RSSI {rssi}%" if rssi is not None else ""] if x) or "receiving"
        comps.append(_c("Communication link", st, det, link))

    # camera
    if not video or not video.get("configured"):
        comps.append(_c("Camera", "unavailable", "no video source configured"))
    elif video.get("api_ok") is False:
        comps.append(_c("Camera", "unavailable", "video server not reachable"))
    else:
        st = "healthy" if video.get("ready") else ("warning" if live else "unavailable")
        comps.append(_c("Camera", st, (f"streaming {video.get('kbps') or 0} kbit/s" if video.get("ready") else "no stream")
                        + (", recording" if video.get("recording") else "")))

    # sensors
    rep = d.sensor_report() if live else None
    if not rep:
        comps.append(_c("Sensors", "unavailable", "no sensor status (SYS_STATUS)"))
    else:
        bad = [s["name"] for s in rep if not s["ok"]]
        crit = {"3D gyro", "3D accelerometer", "AHRS", "GPS", "absolute pressure"}
        st = "critical" if any(b in crit for b in bad) and d.armed else "warning" if bad else "healthy"
        comps.append(_c("Sensors", st, ("not healthy: " + ", ".join(bad)) if bad else f"{len(rep)} sensors healthy"))

    # temperature
    temps = {k: v for k, (v, ts) in d.temps.items() if now - ts < 30}
    if not live or not temps:
        comps.append(_c("Temperature", "unavailable", "no temperature data"))
    else:
        hot = max(temps.items(), key=lambda x: x[1])
        st = "critical" if hot[1] >= th["temp_high_c"] + 15 else "warning" if hot[1] >= th["temp_high_c"] else "healthy"
        comps.append(_c("Temperature", st, ", ".join(f"{k} {v:.0f} °C" for k, v in temps.items()), round(hot[1])))

    avail = [c for c in comps if c["status"] in SCORE]
    score = round(sum(SCORE[c["status"]] for c in avail) / len(avail)) if avail else None
    worst = "critical" if any(c["status"] == "critical" for c in comps) else "warning" if any(c["status"] == "warning" for c in comps) else (
        "healthy" if avail else "unavailable")
    return {"key": d.key, "drone_id": d.drone_id, "gcs_id": d.gcs_id, "score": score, "overall": worst, "alert_level": alert_level,
            "components": comps, "available": len(avail), "total": len(comps)}
