"""TAVAS Digital Twin Command Centre (Neosky Live Twin) web server.

    uvicorn twin.app:app --host 0.0.0.0 --port 8080        (one process: live state is kept in memory)

- Browsers: login, the command-centre single-page app, JSON APIs, and /ws/live which pushes the whole fleet
  4 times a second, the full twin of the drone being viewed, and every alert the moment it is raised.
- GCS links: /ws/ingest?gcs=GCS-01 (field relay), or UDP / TCP adapters configured per GCS (twin/fleet.py).
- Video: MediaMTX; proxied here for logged-in viewers (twin/routes_video.py).
The app only monitors. It never sends anything to a drone or a GCS.
"""
import asyncio
import contextlib
import hmac
import json
import logging
import time
from datetime import datetime
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from . import auth, config, reports, stats
from .alerts import DEFAULT_THRESHOLDS, RULE_LABELS, THRESHOLD_HELP
from .fleet import TELEMETRY_TYPES, VIDEO_TYPES, video_path
from .health import drone_health
from .routes_planner import router as planner_router
from .routes_video import router as video_router
from .state import alerts, fleet, hub, store, user, video
from .version import __version__

log = logging.getLogger("twin")
STATIC = config.BASE_DIR / "static"
SPA = STATIC / "cc"
clients = {}      # websocket -> {"sub": drone key or None, "user": name}
relays = {}       # gcs key -> set of websockets


@contextlib.asynccontextmanager
async def lifespan(app):
    loop = asyncio.get_running_loop()
    alerts.listeners.append(lambda kind, a: loop.call_soon_threadsafe(_push_alert, kind, a))
    await fleet.start()
    tasks = [asyncio.create_task(_broadcast_loop()), asyncio.create_task(_tick_loop()), asyncio.create_task(video.run())]
    transport = None
    if config.UDP_PORT:
        transport, _ = await loop.create_datagram_endpoint(lambda: _UdpMavlink(), local_addr=("0.0.0.0", config.UDP_PORT))
    yield
    for t in tasks:
        t.cancel()
    if transport:
        transport.close()
    hub.shutdown()


app = FastAPI(title="TAVAS Digital Twin Command Centre", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")
app.include_router(planner_router)
app.include_router(video_router)


# ---------------------------------------------------------------- pages
@app.get("/login", response_class=HTMLResponse)
def login_page():
    return (STATIC / "login.html").read_text(encoding="utf-8").replace("{{VERSION}}", __version__)


@app.post("/login")
async def login(request: Request):
    form = await request.form()
    u = auth.login(store, (form.get("username") or "").strip(), form.get("password") or "")
    if not u:
        return RedirectResponse("/login?error=1", status_code=303)
    r = RedirectResponse("/", status_code=303)
    r.set_cookie(auth.COOKIE, auth.session_cookie(u["username"]), max_age=7 * 24 * 3600, httponly=True, samesite="lax")
    return r


@app.get("/logout")
def logout():
    r = RedirectResponse("/login", status_code=303)
    r.delete_cookie(auth.COOKIE)
    return r


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    if not auth.current_user(store, request):
        return RedirectResponse("/login", status_code=303)
    page = SPA / "index.html"
    if not page.exists():
        return HTMLResponse("<p>The command-centre front end hasn't been built. Run <code>npm run build</code> in <code>frontend/</code>.</p>", 500)
    return page.read_text(encoding="utf-8")


@app.get("/healthz")
def healthz():
    return {"ok": True, "version": __version__, "drones": len(hub.drones), "viewers": len(clients)}


# ---------------------------------------------------------------- session / config
@app.get("/api/me")
def api_me(request: Request):
    u = user(request)
    return {"user": u, "version": __version__, "tz": config.TIMEZONE, "fleet_size": len(fleet.slots), "periods": stats.PERIODS,
            "rule_labels": RULE_LABELS, "telemetry_types": TELEMETRY_TYPES, "video_types": VIDEO_TYPES}


@app.post("/api/me/password")
def api_my_password(request: Request, body: dict = Body(...)):
    u = user(request)
    full = store.user(u["username"])
    if not auth.check_pw(body.get("current") or "", full["pw_hash"]):
        raise HTTPException(400, "The current password is wrong.")
    new = body.get("new") or ""
    if len(new) < 8:
        raise HTTPException(400, "Use at least 8 characters.")
    store.save_user(u["username"], auth.hash_pw(new), full["role"], full["full_name"])
    return {"ok": True}


# ---------------------------------------------------------------- fleet, drones, GCS
def _drone_row(d, now=None):
    row = d.compact(now or time.time())
    row["level"] = alerts.level(d.key)
    row["alerts"] = alerts.counts(d.key)
    v = video.status.get(d.key) or {}
    row["video"] = {"path": v.get("path") or video_path(d.key), "sub_path": v.get("sub_path"), "ready": v.get("ready", False),
                    "configured": v.get("configured", False), "kbps": v.get("kbps"), "recording": v.get("recording", False)}
    link = fleet.links.get(d.key)
    row["gcs_state"] = link.state if link else None
    return row


def _summary(rows):
    connected = [r for r in rows if r["conn"] not in ("offline",) and r["last_seen_s"] is not None and r["last_seen_s"] < config.OFFLINE_S]
    batts = [r["batt_pct"] for r in connected if r["batt_pct"] is not None]
    return {
        "total": len([r for r in rows if r.get("enabled", True)]),
        "airborne": sum(1 for r in rows if r["airborne"]),
        "ground": sum(1 for r in connected if not r["airborne"]),
        "warnings": sum(1 for r in rows if r["level"] == "warning"),
        "critical": sum(1 for r in rows if r["level"] == "critical"),
        "disconnected": sum(1 for r in rows if r not in connected and r.get("enabled", True)),
        "avg_battery": round(sum(batts) / len(batts)) if batts else None,
        "fleet_flight_s_today": _today_flight_s(rows),
    }


_today_cache = [0, 0.0]


def _today_flight_s(rows):
    now = time.time()
    if now - _today_cache[0] > 10:
        done = sum((f["summary"].get("flight_time_min") or 0) * 60 for f in store.flights(since=stats.period_start("today"))
                   if f["status"] != "flying")
        _today_cache[:] = [now, done]
    return round(_today_cache[1] + sum(r["flight_s"] or 0 for r in rows if r["armed"] and r["flight_s"]))


def fleet_payload():
    now = time.time()
    rows = [_drone_row(d, now) for d in hub.ordered()]
    return {"type": "fleet", "t": now, "drones": rows, "summary": _summary(rows), "gcs": fleet.infos(),
            "video_api": {"ok": video.api_ok, "error": video.api_error}}


@app.get("/api/fleet")
def api_fleet(request: Request):
    user(request)
    return fleet_payload()


@app.get("/api/fleet/config")
def api_fleet_config(request: Request):
    user(request, "admin")
    return {"slots": fleet.slots, "telemetry_types": TELEMETRY_TYPES, "video_types": VIDEO_TYPES}


@app.put("/api/fleet/config/{slot}")
async def api_fleet_slot(slot: int, request: Request, body: dict = Body(...)):
    user(request, "admin")
    try:
        s = fleet.update_slot(slot, body)
    except KeyError:
        raise HTTPException(404, "no such slot")
    except ValueError as e:
        raise HTTPException(400, str(e))
    # A relay that is connected for this GCS is dropped when the slot no longer uses the relay (or is disabled),
    # so two sources never feed the same drone.
    if (s.get("telemetry") or {}).get("type") != "relay" or not s.get("enabled", True):
        for ws in list(relays.get(s["key"], ())):
            try:
                await ws.close(code=4409)
            except Exception:
                pass
    await fleet.restart_link(s["key"])
    await video.configure()
    return s


@app.get("/api/drones/{key}")
def api_drone(key: str, request: Request):
    user(request)
    d = hub.drones.get(key)
    if not d:
        raise HTTPException(404)
    out = d.detail(time.time())
    out.update(_drone_row(d))
    return out


@app.get("/api/drones/{key}/trail")
def api_trail(key: str, request: Request):
    user(request)
    d = hub.drones.get(key)
    if not d:
        raise HTTPException(404)
    if d.flight:
        return {"flight_id": d.flight.id, "live": True, "points": list(d.trail), "simulated": d.simulated}
    fid = d.last_flight_id or next((f["id"] for f in store.flights(drone_key=key, limit=1)), None)
    return {"flight_id": fid, "live": False, "points": store.track(fid) if fid else []}


@app.get("/api/fleet/paths")
def api_fleet_paths(request: Request):
    """Flight path of every drone: the live flight's points (or none), the planned route heard on its GCS link."""
    user(request)
    out = {}
    for d in hub.ordered():
        out[d.key] = {"live": bool(d.flight), "points": list(d.trail) if d.flight else [], "simulated": d.simulated,
                      "mission": d.mission_items, "mission_ver": d.mission_ver}
    return out


@app.get("/api/drones/{key}/telemetry")
def api_drone_telemetry(key: str, request: Request, minutes: float = 10):
    user(request)
    return store.telemetry(key, time.time() - min(minutes, 24 * 60) * 60, step=max(1, int(minutes * 60 / 900)))


@app.get("/api/gcs")
def api_gcs(request: Request):
    user(request)
    since = time.time() - 24 * 3600
    counts = store.gcs_event_counts(since)
    out = []
    for info in fleet.infos():
        d = hub.drones.get(info["key"])
        v = video.status.get(info["key"]) or {}
        info.update({"disconnects_24h": counts.get(info["gcs_id"], 0), "link_pct": d.link_pct() if d else None,
                     "rssi": d.rssi_pct() if d else None, "last_hb_s": round(time.time() - d.last_hb, 1) if d and d.last_hb else None,
                     "video": {"type": v.get("type"), "ready": v.get("ready"), "kbps": v.get("kbps"), "sub_ready": v.get("sub_ready"),
                               "viewers": v.get("viewers"), "codec": v.get("codec")}})
        out.append(info)
    return {"links": out, "video_api": {"ok": video.api_ok, "error": video.api_error}}


@app.get("/api/gcs/{gcs_key}/events")
def api_gcs_events(gcs_key: str, request: Request):
    user(request)
    link = fleet.links.get(gcs_key)
    if not link:
        raise HTTPException(404)
    return store.gcs_events(link.gcs_id, 100)


@app.post("/api/gcs/{gcs_key}/reconnect")
async def api_gcs_reconnect(gcs_key: str, request: Request):
    user(request, "operator")
    if gcs_key not in fleet.links:
        raise HTTPException(404)
    await fleet.restart_link(gcs_key)
    return {"ok": True}


# ---------------------------------------------------------------- alerts
def _alert_out(a):
    a = dict(a)
    a.setdefault("label", RULE_LABELS.get(a["rule"], a["rule"]))
    return a


@app.get("/api/alerts")
def api_alerts(request: Request, open: int = 0, drone: str = None, severity: str = None, hours: float = 24, limit: int = 500):
    user(request)
    if open:
        rows = alerts.open()
        if drone:
            rows = [a for a in rows if a["drone_key"] == drone]
        if severity:
            rows = [a for a in rows if a["severity"] == severity]
        return [_alert_out(a) for a in rows]
    return [_alert_out(a) for a in store.alerts(drone or None, severity or None, time.time() - hours * 3600, limit=min(limit, 5000))]


@app.post("/api/alerts/{aid}/ack")
def api_alert_ack(aid: int, request: Request):
    u = user(request, "operator")
    a = alerts.acknowledge(aid, u["username"])
    if not a:
        raise HTTPException(404)
    return _alert_out(a)


@app.post("/api/alerts/ack")
def api_alert_ack_many(request: Request, body: dict = Body(...)):
    u = user(request, "operator")
    n = 0
    for a in list(alerts.open()):
        if a["ack_ts"]:
            continue
        if body.get("severity") and a["severity"] != body["severity"]:
            continue
        if body.get("drone") and a["drone_key"] != body["drone"]:
            continue
        alerts.acknowledge(a["id"], u["username"])
        n += 1
    return {"acknowledged": n}


# ---------------------------------------------------------------- health
@app.get("/api/health")
def api_health(request: Request):
    user(request)
    return [drone_health(d, alerts.thresholds, video.status.get(d.key), alerts.level(d.key)) for d in hub.ordered()]


# ---------------------------------------------------------------- settings & users
@app.get("/api/settings")
def api_settings(request: Request):
    user(request)
    return {"thresholds": alerts.thresholds, "defaults": DEFAULT_THRESHOLDS,
            "help": {k: {"label": v[0], "unit": v[1], "severity": v[2]} for k, v in THRESHOLD_HELP.items()}}


@app.put("/api/settings/thresholds")
def api_set_thresholds(request: Request, body: dict = Body(...)):
    user(request, "admin")
    try:
        alerts.set_thresholds(body)
    except (TypeError, ValueError):
        raise HTTPException(400, "Thresholds must be numbers.")
    return alerts.thresholds


@app.get("/api/users")
def api_users(request: Request):
    user(request, "admin")
    return store.users()


@app.post("/api/users")
def api_user_save(request: Request, body: dict = Body(...)):
    user(request, "admin")
    name = (body.get("username") or "").strip()
    role = body.get("role")
    if not name or role not in auth.ROLES:
        raise HTTPException(400, "A user name and a role (admin, operator or viewer) are needed.")
    existing = store.user(name)
    pw = body.get("password") or ""
    if not existing and len(pw) < 8:
        raise HTTPException(400, "New users need a password of at least 8 characters.")
    store.save_user(name, auth.hash_pw(pw) if pw else None, role, body.get("full_name") or name)
    auth.forget(name)
    return {"ok": True}


@app.delete("/api/users/{name}")
def api_user_delete(name: str, request: Request):
    u = user(request, "admin")
    if name == u["username"]:
        raise HTTPException(400, "You can't delete your own account.")
    store.delete_user(name)
    auth.forget(name)
    return {"ok": True}


# ---------------------------------------------------------------- flights, history, reports
def _flight_row(f):
    s = f["summary"]
    d = hub.drones.get(f["drone_key"])
    return {"id": f["id"], "drone_key": f["drone_key"], "drone_id": s.get("drone_id") or (d.drone_id if d else f["msn"]),
            "gcs_id": s.get("gcs_id") or (d.gcs_id if d else None), "msn": f["msn"], "model": f["model"],
            "start_ts": f["start_ts"], "end_ts": f["end_ts"], "status": f["status"], "conclusion": f["conclusion"], "note": f["note"],
            "has_tlog": bool(f["tlog_path"]),
            "summary": {k: v for k, v in s.items() if k not in ("events", "modes", "prearm_messages", "counts")},
            "events": [e["type"] for e in s.get("events", [])]}


@app.get("/api/flights")
def api_flights(request: Request, drone: str = None, msn: str = None, period: str = "all", limit: int = 300):
    user(request)
    return [_flight_row(f) for f in store.flights(msn=msn or None, drone_key=drone or None, since=stats.period_start(period),
                                                   limit=min(limit, 5000))]


@app.get("/api/flights/{fid}")
def api_flight(fid: int, request: Request):
    user(request)
    f = store.flight(fid)
    if not f:
        raise HTTPException(404)
    row = _flight_row(f)
    f.pop("tlog_path", None)
    f.update({k: row[k] for k in ("drone_id", "gcs_id", "has_tlog", "events")})
    f["track"] = store.track(fid)
    f["messages"] = store.messages(fid)
    f["alerts"] = [_alert_out(a) for a in store.alerts(f["drone_key"], since=f["start_ts"] - 1, limit=2000)
                   if a["ts"] <= (f["end_ts"] or time.time()) + 1]
    return f


@app.post("/api/flights/{fid}/conclusion")
def api_conclusion(fid: int, request: Request, body: dict = Body(...)):
    user(request, "operator")
    if not store.flight(fid):
        raise HTTPException(404)
    store.set_conclusion(fid, body.get("conclusion"), (body.get("note") or "")[:1000])
    return {"ok": True}


@app.get("/api/flights/{fid}/tlog")
def api_tlog(fid: int, request: Request):
    user(request)
    f = store.flight(fid)
    if not f or not f["tlog_path"] or not Path(f["tlog_path"]).exists():
        raise HTTPException(404, "no telemetry log recorded for this flight")
    return FileResponse(f["tlog_path"], filename=Path(f["tlog_path"]).name, media_type="application/octet-stream")


@app.get("/api/flights/{fid}/report.pdf")
def api_flight_pdf(fid: int, request: Request):
    user(request)
    f = store.flight(fid)
    if not f:
        raise HTTPException(404)
    al = [_alert_out(a) for a in store.alerts(f["drone_key"], since=f["start_ts"] - 1, limit=2000) if a["ts"] <= (f["end_ts"] or time.time()) + 1]
    pdf = reports.flight_pdf(f, store.track(fid), list(reversed(al)), store.messages(fid))
    name = f"{(f['summary'].get('drone_id') or f['msn']).replace(' ', '_')}_flight{fid}.pdf"
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/flights/{fid}/telemetry.csv")
def api_flight_csv(fid: int, request: Request):
    user(request)
    f = store.flight(fid)
    if not f:
        raise HTTPException(404)
    rows = store.telemetry(f["drone_key"], f["start_ts"] - 1, (f["end_ts"] or time.time()) + 1, flight_id=fid)
    for r in rows:
        r["time"] = datetime.fromtimestamp(r["ts"], stats.TZ).isoformat(timespec="seconds")
    cols = ["time", "lat", "lon", "alt", "alt_msl", "gs", "heading", "batt_pct", "volt", "curr", "sats", "hdop", "link", "mode"]
    return PlainTextResponse(reports.to_csv(rows, cols), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="flight{fid}_telemetry.csv"'})


@app.get("/api/export/flights.csv")
def api_flights_csv(request: Request, drone: str = None, period: str = "all"):
    user(request)
    rows = []
    for f in store.flights(drone_key=drone or None, since=stats.period_start(period)):
        r = _flight_row(f)
        s = r["summary"]
        rows.append({"flight": r["id"], "drone": r["drone_id"], "gcs": r["gcs_id"], "date": datetime.fromtimestamp(r["start_ts"], stats.TZ).strftime("%Y-%m-%d"),
                     "armed": datetime.fromtimestamp(r["start_ts"], stats.TZ).strftime("%H:%M:%S"),
                     "takeoff": datetime.fromtimestamp(s["takeoff_ts"], stats.TZ).strftime("%H:%M:%S") if s.get("takeoff_ts") else "",
                     "landing": datetime.fromtimestamp(s["landing_ts"], stats.TZ).strftime("%H:%M:%S") if s.get("landing_ts") else "",
                     "duration_min": s.get("flight_time_min"), "max_alt_m": s.get("max_alt_m"), "max_speed_ms": s.get("max_speed_ms"),
                     "distance_m": s.get("distance_m"), "batt_start_pct": s.get("batt_start_pct"), "batt_end_pct": s.get("batt_end_pct"),
                     "mah_used": s.get("mah_used"), "mission_completed": (s.get("mission") or {}).get("completed"),
                     "events": " ".join(sorted(set(r["events"]))), "status": r["status"], "root_cause": r["conclusion"]})
    cols = list(rows[0].keys()) if rows else ["flight"]
    return PlainTextResponse(reports.to_csv(rows, cols), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="flights.csv"'})


@app.get("/api/export/alerts.csv")
def api_alerts_csv(request: Request, drone: str = None, hours: float = 24 * 30):
    user(request)
    rows = store.alerts(drone or None, None, time.time() - hours * 3600, limit=100000)
    for r in rows:
        r["time"] = datetime.fromtimestamp(r["ts"], stats.TZ).isoformat(timespec="seconds")
        r["label"] = RULE_LABELS.get(r["rule"], r["rule"])
        r["acknowledged"] = datetime.fromtimestamp(r["ack_ts"], stats.TZ).isoformat(timespec="seconds") if r["ack_ts"] else ""
    cols = ["time", "drone_id", "gcs_id", "severity", "label", "message", "source", "param", "value", "threshold", "lat", "lon", "ack_by", "acknowledged"]
    return PlainTextResponse(reports.to_csv(rows, cols), media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="alerts.csv"'})


def _analytics(period):
    since = stats.period_start(period)
    flights = store.flights(since=since)
    al = store.alerts(since=since or 0, limit=100000)
    per = {}
    for d in hub.ordered():
        per[d.key] = {"key": d.key, "drone_id": d.drone_id, "gcs_id": d.gcs_id, "flights": 0, "hours": 0.0, "km": 0.0, "max_alt": None,
                      "batt_used": [], "critical": 0, "warning": 0, "info": 0, "failsafes": 0, "crashes": 0}
    days = {}
    for f in flights:
        if f["status"] == "flying":
            continue
        s = f["summary"]
        r = per.get(f["drone_key"])
        if not r:
            continue
        r["flights"] += 1
        r["hours"] += (s.get("flight_time_min") or 0) / 60
        r["km"] += (s.get("distance_m") or 0) / 1000
        if s.get("max_alt_m") is not None:
            r["max_alt"] = max(r["max_alt"] or 0, s["max_alt_m"])
        if s.get("batt_start_pct") is not None and s.get("batt_end_pct") is not None:
            r["batt_used"].append(s["batt_start_pct"] - s["batt_end_pct"])
        r["failsafes"] += sum(1 for k in ("battery_fs", "gcs_fs", "rc_fs") if s.get(k))
        r["crashes"] += 1 if s.get("crash") else 0
        day = datetime.fromtimestamp(f["start_ts"], stats.TZ).strftime("%Y-%m-%d")
        days[day] = days.get(day, 0) + (s.get("flight_time_min") or 0) / 60
    for a in al:
        r = per.get(a["drone_key"])
        if r and a["severity"] in ("critical", "warning", "info"):
            r[a["severity"]] += 1
    rows = []
    for r in per.values():
        r["avg_batt_used"] = round(sum(r["batt_used"]) / len(r["batt_used"]), 1) if r["batt_used"] else None
        r.pop("batt_used")
        r["hours"] = round(r["hours"], 2)
        r["km"] = round(r["km"], 2)
        rows.append(r)
    totals = {"flights": sum(r["flights"] for r in rows), "hours": round(sum(r["hours"] for r in rows), 2),
              "km": round(sum(r["km"] for r in rows), 2), "crashes": sum(r["crashes"] for r in rows)}
    counts = {k: sum(r[k] for r in rows) for k in ("critical", "warning", "info")}
    by_rule = {}
    for a in al:
        if a["severity"] != "info":
            by_rule[a["rule"]] = by_rule.get(a["rule"], 0) + 1
    return {"period": period, "drones": rows, "totals": totals, "alert_counts": counts,
            "alerts_by_rule": sorted(([RULE_LABELS.get(k, k), v] for k, v in by_rule.items()), key=lambda x: -x[1]),
            "daily_hours": sorted(days.items()), "stats": stats.aggregate(flights)}


@app.get("/api/analytics")
def api_analytics(request: Request, period: str = "30d"):
    user(request)
    return _analytics(period)


@app.get("/api/reports/fleet.pdf")
def api_fleet_pdf(request: Request, period: str = "30d"):
    user(request)
    a = _analytics(period)
    pdf = reports.fleet_pdf(stats.PERIODS.get(period, period), a["drones"], a["totals"], a["alert_counts"])
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="fleet_report_{period}.pdf"'})


@app.get("/api/stats")
def api_stats(request: Request, drone: str = None, msn: str = None, period: str = "all"):
    user(request)
    flights = store.flights(msn=msn or None, drone_key=drone or None, since=stats.period_start(period))
    out = stats.aggregate(flights)
    out.update(period=period, msn=msn or None, drone=drone or None)
    return out


# ---------------------------------------------------------------- live push to browsers
@app.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    u = auth.current_user(store, ws)
    if not u:
        await ws.close(code=4401)
        return
    await ws.accept()
    clients[ws] = {"sub": None, "user": u["username"]}
    try:
        await ws.send_text(json.dumps(fleet_payload()))
        await ws.send_text(json.dumps({"type": "alerts", "alerts": [_alert_out(a) for a in alerts.open()]}))
        while True:
            msg = await ws.receive_text()
            if msg.startswith("{"):
                try:
                    j = json.loads(msg)
                except ValueError:
                    continue
                if "sub" in j:
                    clients[ws]["sub"] = j["sub"] if j["sub"] in hub.drones else None
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        clients.pop(ws, None)


def _push_alert(kind, a):
    payload = json.dumps({"type": "alert", "kind": kind, "alert": _alert_out(a)})
    for c in list(clients):
        asyncio.ensure_future(_safe_send(c, payload))


async def _safe_send(c, payload):
    try:
        await asyncio.wait_for(c.send_text(payload), timeout=2)
    except Exception:
        clients.pop(c, None)


async def _broadcast_loop():
    tick = 0
    while True:
        await asyncio.sleep(0.25)
        tick += 1
        if not clients:
            continue
        try:
            payload = json.dumps(fleet_payload())
        except Exception:
            log.exception("fleet payload failed")
            continue
        now = time.time()
        details = {}
        for c, info in list(clients.items()):
            await _safe_send(c, payload)
            key = info.get("sub")
            if key and key in hub.drones:
                if key not in details:
                    d = hub.drones[key]
                    det = d.detail(now)
                    det.update(_drone_row(d, now))
                    if tick % 4 == 0:
                        det["health"] = drone_health(d, alerts.thresholds, video.status.get(key), alerts.level(key))
                    details[key] = json.dumps({"type": "detail", "drone": det})
                await _safe_send(c, details[key])


async def _tick_loop():
    n = 0
    while True:
        await asyncio.sleep(1)
        n += 1
        try:
            fleet.tick()
            alerts.tick(video.status if video.api_ok else None)
            store.add_telemetry(hub.sample())
            if n % 5 == 0:
                hub.tick()
            if n % 3600 == 0:
                store.prune_telemetry(time.time() - config.TELEMETRY_KEEP_DAYS * 86400)
        except Exception:
            log.exception("tick failed")


# ---------------------------------------------------------------- telemetry in
@app.websocket("/ws/ingest")
async def ws_ingest(ws: WebSocket):
    q = ws.query_params
    if not hmac.compare_digest(q.get("token", ""), config.INGEST_TOKEN):
        await ws.close(code=4401)
        return
    gcs = (q.get("gcs") or "").strip()
    msn = (q.get("msn") or "").strip()[:40] or None
    model = (q.get("model") or "").strip()[:40] or None
    simulated = q.get("mode") == "simulation"   # the simulator and log replays say so; field relays never do
    slot = fleet.slot_by_gcs(gcs) if gcs else fleet.slot_by_msn(msn)
    if gcs and not slot:
        await ws.close(code=4404)
        return
    link = fleet.links.get(slot["key"]) if slot else None
    if link and link.kind != "relay":
        await ws.close(code=4409)   # this GCS is set up for another adapter
        return
    await ws.accept()
    source = f"ws:{id(ws)}"
    if link:
        relays.setdefault(link.key, set()).add(ws)
        link.sessions = len(relays[link.key])
        link.peer = ws.client.host if ws.client else None
        link.set_state("connected", f"relay from {link.peer}")
    if slot:
        await ws.send_text(json.dumps({"hello": {"drone_id": slot["drone_id"], "key": slot["key"], "gcs_id": slot["gcs_id"],
                                                 "video_path": video_path(slot["key"]), "video_sub_path": video_path(slot["key"], True)}}))
    pinger = asyncio.create_task(_ping_relay(ws, link)) if link else None
    try:
        while True:
            m = await ws.receive()
            if m.get("type") == "websocket.disconnect":
                break
            if link and link.kind != "relay":
                await ws.close(code=4409)
                break
            data = m.get("bytes")
            if data:
                n = hub.feed(source, data, msn, model, slot=slot, simulated=simulated)
                if link:
                    link.data(len(data), n)
            elif m.get("text") and link and m["text"].startswith("pong "):
                try:
                    link.rtt_ms = round((time.time() - float(m["text"][5:])) * 1000)
                except ValueError:
                    pass
    except WebSocketDisconnect:
        pass
    finally:
        if pinger:
            pinger.cancel()
        hub.drop_source(source)
        if link:
            relays.get(link.key, set()).discard(ws)
            link.sessions = len(relays.get(link.key, ()))
            if not link.sessions and link.kind == "relay":
                link.rtt_ms = None
                link.set_state("disconnected", "relay connection closed")


async def _ping_relay(ws, link):
    while True:
        await asyncio.sleep(5)
        try:
            await ws.send_text(f"ping {time.time():.3f}")
        except Exception:
            return


class _UdpMavlink(asyncio.DatagramProtocol):
    def datagram_received(self, data, addr):
        hub.feed(f"udp:{addr[0]}:{addr[1]}", data)
