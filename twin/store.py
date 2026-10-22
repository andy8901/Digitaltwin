"""SQLite storage: drones, recorded flights (summary + track), and status messages."""
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

    def flights(self, msn=None, since=None, limit=None, include_open=True):
        q, a = "SELECT * FROM flights WHERE 1=1", []
        if msn:
            q += " AND msn=?"
            a.append(msn)
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
