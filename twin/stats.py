"""Fleet statistics over the flights this twin recorded."""
from collections import OrderedDict
from datetime import datetime, timedelta

from . import config

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo(config.TIMEZONE)
except Exception:  # pragma: no cover
    TZ = None

AVERAGES = OrderedDict([
    ("flight_time_min", ("Avg flight time", "min")),
    ("distance_m", ("Avg distance per flight", "m")),
    ("range_m", ("Avg range per flight", "m")),
    ("max_alt_m", ("Avg altitude (max per flight)", "m")),
    ("max_voltage", ("Avg max voltage", "V")),
    ("min_voltage", ("Avg min voltage", "V")),
    ("avg_current", ("Avg current", "A")),
    ("cold_start_s", ("Avg cold-start time", "s")),
])
FAILSAFES = OrderedDict([
    ("battery_fs_t_min", ("Avg flight time at battery failsafe", "min", "battery_fs")),
    ("gcs_fs_dist_m", ("Avg distance at GCS failsafe", "m", "gcs_fs")),
    ("rc_fs_dist_m", ("Avg distance at RC failsafe", "m", "rc_fs")),
    ("battery_fs_voltage", ("Avg voltage at battery failsafe", "V", "battery_fs")),
])
COUNTS = OrderedDict([
    ("crash", "Crashes"),
    ("thrust_loss", "Potential thrust losses"),
    ("motor_issue", "Motor issues"),
    ("gps_issue", "GPS issues"),
    ("ekf_issue", "EKF issues"),
    ("prearm_issue", "Pre-arm issues"),
    ("vibration_issue", "High vibration"),
    ("battery_fs", "Battery failsafes"),
    ("gcs_fs", "GCS failsafes"),
    ("rc_fs", "RC failsafes"),
])
PERIODS = OrderedDict([("all", "All time"), ("today", "Today"), ("7d", "Last 7 days"), ("30d", "Last 30 days")])


def period_start(period):
    now = datetime.now(TZ) if TZ else datetime.now()
    if period == "today":
        return now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    if period == "7d":
        return (now - timedelta(days=7)).timestamp()
    if period == "30d":
        return (now - timedelta(days=30)).timestamp()
    return None


def _avg(vals):
    vals = [v for v in vals if isinstance(v, (int, float))]
    return (round(sum(vals) / len(vals), 2), len(vals)) if vals else (None, 0)


def aggregate(flights):
    # Flights cut short by a server restart have partial figures, so they are left out of the statistics.
    done = [f for f in flights if f["status"] in ("completed", "link_lost", "reboot")]
    S = [f["summary"] for f in done]
    out = {"flights": len(done), "flying_now": sum(1 for f in flights if f["status"] == "flying")}
    out["averages"] = [{"key": k, "label": lab, "unit": u, "value": v, "n": n}
                       for k, (lab, u) in AVERAGES.items() for v, n in [_avg([s.get(k) for s in S])]]
    out["failsafes"] = [{"key": k, "label": lab, "unit": u, "value": v, "n": n, "flights": sum(1 for s in S if s.get(flag))}
                        for k, (lab, u, flag) in FAILSAFES.items() for v, n in [_avg([s.get(k) for s in S])]]
    out["counts"] = [{"key": k, "label": lab, "value": sum(1 for s in S if s.get(k))} for k, lab in COUNTS.items()]
    conc = {"pilot_error": 0, "system_error": 0, "undetermined": 0, "none": 0}
    for f in done:
        conc[f.get("conclusion") or "none"] = conc.get(f.get("conclusion") or "none", 0) + 1
    out["conclusions"] = conc
    out["total_hours"] = round(sum((s.get("flight_time_min") or 0) for s in S) / 60, 2)
    out["total_km"] = round(sum((s.get("distance_m") or 0) for s in S) / 1000, 2)
    out["tlogs"] = sum(1 for f in flights if f.get("tlog_path"))
    return out
