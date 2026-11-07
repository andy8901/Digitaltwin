"""Background analysis of flight logs: every finished flight (recorded .tlog) and every uploaded log is parsed once
into a replay timeline and an incident report. Runs in one worker thread so the live monitoring is never slowed."""
import logging
import queue
import re
import threading
from pathlib import Path

from . import flightlog

log = logging.getLogger("twin.analysis")

# flight-controller findings -> the event tags the flight history already uses
ERR_TAGS = {5: "rc_fs", 6: "battery_fs", 7: "gps_issue", 8: "gcs_fs", 11: "gps_issue", 12: "crash", 16: "ekf_issue",
            17: "ekf_issue", 24: "ekf_issue", 25: "thrust_loss", 29: "vibration_issue"}


class Analyser:
    def __init__(self, store, fleet, alerts):
        self.store, self.fleet, self.alerts = store, fleet, alerts
        self.q = queue.Queue()
        self.queued = set()
        self.current = None
        threading.Thread(target=self._loop, daemon=True, name="flight-analysis").start()

    def enqueue(self, fid):
        if fid not in self.queued:
            self.queued.add(fid)
            self.q.put(fid)

    def scan(self):
        for fid in self.store.to_analyse():
            self.enqueue(fid)

    def _loop(self):
        while True:
            fid = self.q.get()
            self.current = fid
            try:
                self.run(fid)
            except Exception as e:   # never let one bad log stop the worker
                log.exception("analysis of flight %s failed", fid)
                self.store.set_analysis(fid, "error", error=str(e)[:300])
            finally:
                self.current = None
                self.queued.discard(fid)

    def run(self, fid):
        f = self.store.flight(fid)
        if not f:
            return
        self.store.set_analysis(fid, "running")
        path = f.get("tlog_path")
        tl = None
        if path and Path(path).exists() and Path(path).stat().st_size > 0:
            name = (f.get("log_name") or path).lower()
            tl = flightlog.parse(path, kind="bin" if name.endswith((".bin", ".log")) else "tlog")
        elif f.get("source") != "upload":
            rows = self.store.telemetry(f["drone_key"], f["start_ts"] - 1, f["end_ts"] or None, flight_id=fid)
            tl = flightlog.from_telemetry(rows, f["start_ts"])
        if not tl:
            self.store.set_analysis(fid, "error", error="no recorded data for this flight")
            return
        flightlog.save(fid, tl)
        slot = next((s for s in self.fleet.slots if s["key"] == f["drone_key"]), {})
        rep = flightlog.analyse(tl, self.alerts.thresholds, cells=slot.get("battery_cells"))
        if f.get("source") == "upload":
            self.store.set_upload_result(fid, rep["start_ts"], rep["end_ts"], self._summary(tl, rep),
                                         flightlog.track_points(tl), tl["msgs"])
        self.store.set_analysis(fid, "done", report=rep)

    @staticmethod
    def _summary(tl, rep):
        """Summary in the same shape as live flights, so history, analytics and exports treat uploads the same way."""
        tags = []
        for e in tl["events"]:
            if e["type"] == "err" and not e.get("cleared") and e["subsys"] in ERR_TAGS:
                tags.append(ERR_TAGS[e["subsys"]])
        for m in tl["msgs"]:
            if re.search(r"crash", m["text"], re.I) and m["sev"] <= 3:
                tags.append("crash")
        events = [{"type": t, "t": 0, "text": t, "lat": None, "lon": None} for t in dict.fromkeys(tags)]
        t0 = rep["start_ts"]
        return {
            "flight_time_min": round(rep["flight_time_s"] / 60, 2), "max_alt_m": rep["max_alt_m"], "max_speed_ms": rep["max_speed_ms"],
            "distance_m": rep["distance_m"], "batt_start_pct": rep["batt_start_pct"], "batt_end_pct": rep["batt_end_pct"],
            "takeoff_ts": t0, "landing_ts": rep["end_ts"], "crash": "crash" in tags, "events": events,
            "min_volt": rep["volt_min"], "max_current_a": rep["max_current_a"], "max_voltage": rep["volt_takeoff"], "min_voltage": rep["volt_min"],
            "range_m": rep.get("max_range_m"),
        }
