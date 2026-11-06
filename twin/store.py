"""SQLite storage: fleet registry, drones, recorded flights (summary + track), status messages, alerts, GCS link events,
1 Hz telemetry, users, settings and demo-site plans."""
import json
import sqlite3
import threading
import time

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS drones (
    key TEXT PRIMARY KEY, msn TEXT, model TEXT, sysid INTEGER,
    first_seen REAL, last_seen REAL, last_lat REAL, last_lon REAL
);
CREATE TABLE IF NOT EXISTS flights (
    id INTEGER PRIMARY KEY AUTOINCREMENT, drone_key TEXT, msn TEXT, model TEXT,
    start_ts REAL, end_ts REAL, status TEXT, summary TEXT,
    conclusion TEXT, note TEXT, tlog_path TEXT
);
CREATE INDEX IF NOT EXISTS ix_flights_drone ON flights(drone_key, start_ts);
CREATE TABLE IF NOT EXISTS points (
    flight_id INTEGER, t REAL, lat REAL, lon REAL, alt REAL
);
CREATE INDEX IF NOT EXISTS ix_points_flight ON points(flight_id, t);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, drone_key TEXT, flight_id INTEGER, ts REAL, sev INTEGER, text TEXT
);
CREATE INDEX IF NOT EXISTS ix_messages_flight ON messages(flight_id);
CREATE TABLE IF NOT EXISTS fleet (
    slot INTEGER PRIMARY KEY, key TEXT UNIQUE, drone_id TEXT, gcs_id TEXT, msn TEXT, model TEXT,
    telemetry TEXT, video TEXT, geofence TEXT, battery_cells INTEGER, enabled INTEGER DEFAULT 1, notes TEXT
);
CREATE TABLE IF NOT EXISTS gcs_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, gcs_id TEXT, drone_key TEXT, ts REAL, kind TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_gcs_events ON gcs_events(gcs_id, ts);
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, drone_key TEXT, drone_id TEXT, gcs_id TEXT, severity TEXT, rule TEXT,
    message TEXT, source TEXT, param TEXT, value TEXT, threshold TEXT, lat REAL, lon REAL, flight_id INTEGER,
    ts REAL, resolved_ts REAL, ack_by TEXT, ack_ts REAL
);
CREATE INDEX IF NOT EXISTS ix_alerts_ts ON alerts(ts);
CREATE INDEX IF NOT EXISTS ix_alerts_drone ON alerts(drone_key, ts);
CREATE TABLE IF NOT EXISTS telemetry (
    drone_key TEXT, ts REAL, flight_id INTEGER, lat REAL, lon REAL, alt REAL, alt_msl REAL, gs REAL, heading REAL,
    batt_pct REAL, volt REAL, curr REAL, sats INTEGER, hdop REAL, link REAL, mode TEXT
);
CREATE INDEX IF NOT EXISTS ix_telemetry ON telemetry(drone_key, ts);
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY, pw_hash TEXT, role TEXT, full_name TEXT, created REAL, last_login REAL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created REAL, name TEXT, customer TEXT, lat REAL, lon REAL,
    verdict TEXT, best_dir TEXT, result TEXT
);
"""

CONCLUSIONS = ("pilot_error", "system_error", "undetermined")


class Store:
    def __init__(self, path=None):
        path = path or config.DB_PATH
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.lock = threading.Lock()
        with self.lock:
            self.db.executescript(SCHEMA)
            # Flights left open by a previous run can't be finished any more.
            self.db.execute("UPDATE flights SET status='interrupted', end_ts=COALESCE(end_ts, start_ts) WHERE status='flying'")

    def _x(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args)

    # drones
    def upsert_drone(self, key, msn, model, sysid, lat=None, lon=None):
        now = time.time()
        self._x("""INSERT INTO drones(key, msn, model, sysid, first_seen, last_seen, last_lat, last_lon)
                   VALUES(?,?,?,?,?,?,?,?)
                   ON CONFLICT(key) DO UPDATE SET msn=excluded.msn, model=COALESCE(excluded.model, drones.model),
                   sysid=excluded.sysid, last_seen=excluded.last_seen,
                   last_lat=COALESCE(excluded.last_lat, drones.last_lat), last_lon=COALESCE(excluded.last_lon, drones.last_lon)""",
                (key, msn, model, sysid, now, now, lat, lon))

    def drones(self):
        return [dict(r) for r in self._x("SELECT * FROM drones ORDER BY msn")]

    # flights
    def start_flight(self, drone_key, msn, model, start_ts):
        cur = self._x("INSERT INTO flights(drone_key, msn, model, start_ts, status, summary) VALUES(?,?,?,?, 'flying', '{}')",
                      (drone_key, msn, model, start_ts))
        return cur.lastrowid

    def update_flight(self, fid, summary, status=None, end_ts=None, tlog_path=None):
        self._x("UPDATE flights SET summary=?, status=COALESCE(?, status), end_ts=COALESCE(?, end_ts), tlog_path=COALESCE(?, tlog_path) WHERE id=?",
                (json.dumps(summary), status, end_ts, tlog_path, fid))

    def add_points(self, fid, pts):
        if pts:
            with self.lock:
                self.db.executemany("INSERT INTO points(flight_id, t, lat, lon, alt) VALUES(?,?,?,?,?)", [(fid, *p) for p in pts])

    def add_message(self, drone_key, fid, ts, sev, text):
        self._x("INSERT INTO messages(drone_key, flight_id, ts, sev, text) VALUES(?,?,?,?,?)", (drone_key, fid, ts, sev, text))

    def set_conclusion(self, fid, conclusion, note):
        if conclusion not in CONCLUSIONS:
            conclusion = None
        self._x("UPDATE flights SET conclusion=?, note=? WHERE id=?", (conclusion, note, fid))

    def flights(self, msn=None, since=None, limit=None, include_open=True, drone_key=None, until=None):
        q, a = "SELECT * FROM flights WHERE 1=1", []
        if msn:
            q += " AND msn=?"
            a.append(msn)
        if drone_key:
            q += " AND drone_key=?"
            a.append(drone_key)
        if until:
            q += " AND start_ts<=?"
            a.append(until)
        if since:
            q += " AND start_ts>=?"
            a.append(since)
        if not include_open:
            q += " AND status!='flying'"
        q += " ORDER BY start_ts DESC"
        if limit:
            q += " LIMIT ?"
            a.append(int(limit))
        out = []
        for r in self._x(q, a):
            d = dict(r)
            d["summary"] = json.loads(d["summary"] or "{}")
            out.append(d)
        return out

    def flight(self, fid):
        r = self._x("SELECT * FROM flights WHERE id=?", (fid,)).fetchone()
        if not r:
            return None
        d = dict(r)
        d["summary"] = json.loads(d["summary"] or "{}")
        return d

    def track(self, fid):
        return [list(r) for r in self._x("SELECT t, lat, lon, alt FROM points WHERE flight_id=? ORDER BY t", (fid,))]

    def messages(self, fid):
        return [dict(r) for r in self._x("SELECT ts, sev, text FROM messages WHERE flight_id=? ORDER BY ts", (fid,))]

    # demo-site plans
    def save_plan(self, name, customer, lat, lon, result):
        cur = self._x("INSERT INTO plans(created, name, customer, lat, lon, verdict, best_dir, result) VALUES(?,?,?,?,?,?,?,?)",
                      (time.time(), name, customer, lat, lon, result["verdict"]["level"], result["best"]["dir"], json.dumps(result)))
        return cur.lastrowid

    def plans(self, limit=100):
        return [dict(r) for r in self._x("SELECT id, created, name, customer, lat, lon, verdict, best_dir FROM plans ORDER BY created DESC LIMIT ?", (limit,))]

    def plan(self, pid):
        r = self._x("SELECT * FROM plans WHERE id=?", (pid,)).fetchone()
        if not r:
            return None
        d = dict(r)
        d["result"] = json.loads(d["result"])
        return d

    def delete_plan(self, pid):
        self._x("DELETE FROM plans WHERE id=?", (pid,))

    # ---------------------------------------------------------------- fleet registry
    def fleet(self):
        out = []
        for r in self._x("SELECT * FROM fleet ORDER BY slot"):
            d = dict(r)
            for k in ("telemetry", "video", "geofence"):
                d[k] = json.loads(d[k] or "{}")
            d["enabled"] = bool(d["enabled"])
            out.append(d)
        return out

    def save_slot(self, slot):
        self._x("""INSERT INTO fleet(slot, key, drone_id, gcs_id, msn, model, telemetry, video, geofence, battery_cells, enabled, notes)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(slot) DO UPDATE SET key=excluded.key, drone_id=excluded.drone_id, gcs_id=excluded.gcs_id,
                   msn=excluded.msn, model=excluded.model, telemetry=excluded.telemetry, video=excluded.video,
                   geofence=excluded.geofence, battery_cells=excluded.battery_cells, enabled=excluded.enabled, notes=excluded.notes""",
                (slot["slot"], slot["key"], slot["drone_id"], slot["gcs_id"], slot.get("msn"), slot.get("model"),
                 json.dumps(slot.get("telemetry") or {}), json.dumps(slot.get("video") or {}), json.dumps(slot.get("geofence") or {}),
                 slot.get("battery_cells"), 1 if slot.get("enabled", True) else 0, slot.get("notes") or ""))

    # ---------------------------------------------------------------- GCS link events
    def gcs_event(self, gcs_id, drone_key, kind, detail=""):
        self._x("INSERT INTO gcs_events(gcs_id, drone_key, ts, kind, detail) VALUES(?,?,?,?,?)", (gcs_id, drone_key, time.time(), kind, detail))

    def gcs_events(self, gcs_id, limit=50):
        return [dict(r) for r in self._x("SELECT ts, kind, detail FROM gcs_events WHERE gcs_id=? ORDER BY ts DESC LIMIT ?", (gcs_id, limit))]

    def gcs_event_counts(self, since):
        return {r[0]: r[1] for r in self._x("SELECT gcs_id, COUNT(*) FROM gcs_events WHERE kind='disconnected' AND ts>=? GROUP BY gcs_id", (since,))}

    # ---------------------------------------------------------------- alerts
    def add_alert(self, a):
        cur = self._x("""INSERT INTO alerts(drone_key, drone_id, gcs_id, severity, rule, message, source, param, value, threshold,
                         lat, lon, flight_id, ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                      (a["drone_key"], a["drone_id"], a["gcs_id"], a["severity"], a["rule"], a["message"], a["source"], a.get("param"),
                       None if a.get("value") is None else str(a.get("value")), a.get("threshold"), a.get("lat"), a.get("lon"),
                       a.get("flight_id"), a["ts"]))
        return cur.lastrowid

    def resolve_alert(self, aid, ts):
        self._x("UPDATE alerts SET resolved_ts=? WHERE id=? AND resolved_ts IS NULL", (ts, aid))

    def ack_alert(self, aid, user, ts):
        self._x("UPDATE alerts SET ack_by=?, ack_ts=? WHERE id=? AND ack_ts IS NULL", (user, ts, aid))

    def alert(self, aid):
        r = self._x("SELECT * FROM alerts WHERE id=?", (aid,)).fetchone()
        return dict(r) if r else None

    def alerts(self, drone_key=None, severity=None, since=None, open_only=False, limit=500):
        q, a = "SELECT * FROM alerts WHERE 1=1", []
        if drone_key:
            q += " AND drone_key=?"
            a.append(drone_key)
        if severity:
            q += " AND severity=?"
            a.append(severity)
        if since:
            q += " AND ts>=?"
            a.append(since)
        if open_only:
            q += " AND (ack_ts IS NULL OR resolved_ts IS NULL) AND severity!='info'"
        q += " ORDER BY ts DESC LIMIT ?"
        a.append(int(limit))
        return [dict(r) for r in self._x(q, a)]

    def open_alerts(self):
        """Alerts that are not finished: still active, or critical and not yet acknowledged."""
        return [dict(r) for r in self._x(
            "SELECT * FROM alerts WHERE severity!='info' AND (resolved_ts IS NULL OR (severity='critical' AND ack_ts IS NULL)) ORDER BY ts DESC")]

    # ---------------------------------------------------------------- telemetry (1 Hz)
    def add_telemetry(self, rows):
        if rows:
            with self.lock:
                self.db.executemany("INSERT INTO telemetry VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)

    def telemetry(self, drone_key, since, until=None, flight_id=None, step=1):
        q, a = "SELECT * FROM telemetry WHERE drone_key=? AND ts>=?", [drone_key, since]
        if until:
            q += " AND ts<=?"
            a.append(until)
        if flight_id:
            q += " AND flight_id=?"
            a.append(flight_id)
        q += " ORDER BY ts"
        rows = [dict(r) for r in self._x(q, a)]
        return rows[::max(1, int(step))]

    def prune_telemetry(self, older_than):
        self._x("DELETE FROM telemetry WHERE ts<?", (older_than,))

    # ---------------------------------------------------------------- users & settings
    def users(self):
        return [dict(r) for r in self._x("SELECT username, role, full_name, created, last_login FROM users ORDER BY username")]

    def user(self, username):
        r = self._x("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        return dict(r) if r else None

    def save_user(self, username, pw_hash, role, full_name=""):
        self._x("""INSERT INTO users(username, pw_hash, role, full_name, created) VALUES(?,?,?,?,?)
                   ON CONFLICT(username) DO UPDATE SET pw_hash=COALESCE(excluded.pw_hash, users.pw_hash), role=excluded.role,
                   full_name=excluded.full_name""", (username, pw_hash, role, full_name, time.time()))

    def delete_user(self, username):
        self._x("DELETE FROM users WHERE username=?", (username,))

    def touch_login(self, username):
        self._x("UPDATE users SET last_login=? WHERE username=?", (time.time(), username))

    def setting(self, key, default=None):
        r = self._x("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(r[0]) if r else default

    def set_setting(self, key, value):
        self._x("INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value)))
