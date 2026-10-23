"""Neosky Live Twin web server.

    uvicorn twin.app:app --host 0.0.0.0 --port 8080

Browsers: login page, the live dashboard, JSON APIs and a WebSocket that pushes every drone's state 4x per second.
Field relays: WebSocket /ws/ingest carrying raw MAVLink bytes. Optional raw UDP MAVLink listener.
Video: MediaMTX receives each drone's camera stream; this app proxies WebRTC (WHEP) and HLS so a viewer needs
only the app login, and checks MediaMTX's publish/read permissions (/internal/mtx-auth).
"""
import asyncio
import contextlib
import hmac
import json
import time
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, URLSafeTimedSerializer

from . import airspace, config, planner, stats
from .store import Store
from .vehicle import Hub
from .version import __version__

STATIC = config.BASE_DIR / "static"
COOKIE = "twin_session"
signer = URLSafeTimedSerializer(config.SECRET_KEY, salt="twin-login")

store = Store()
hub = Hub(store)
clients = set()


@contextlib.asynccontextmanager
async def lifespan(app):
    tasks = [asyncio.create_task(_broadcast_loop()), asyncio.create_task(_tick_loop())]
    transport = None
    if config.UDP_PORT:
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(lambda: _UdpMavlink(), local_addr=("0.0.0.0", config.UDP_PORT))
    yield
    for t in tasks:
        t.cancel()
    if transport:
        transport.close()
    hub.shutdown()


app = FastAPI(title="Neosky Live Twin", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


# ---------------------------------------------------------------- auth
def current_user(request):
    tok = request.cookies.get(COOKIE)
    if not tok:
        return None
    try:
        user = signer.loads(tok, max_age=7 * 24 * 3600)
    except BadSignature:
        return None
    return user if user in config.USERS else None


def need_user(request):
    u = current_user(request)
    if not u:
        raise HTTPException(401, "login required")
    return u


@app.get("/login", response_class=HTMLResponse)
def login_page():
    return (STATIC / "login.html").read_text(encoding="utf-8").replace("{{VERSION}}", __version__)


@app.post("/login")
async def login(request: Request):
    form = await request.form()
    user, pw = (form.get("username") or "").strip(), form.get("password") or ""
    ok = user in config.USERS and hmac.compare_digest(config.USERS[user], pw)
    if not ok:
        return RedirectResponse("/login?error=1", status_code=303)
    r = RedirectResponse("/", status_code=303)
    r.set_cookie(COOKIE, signer.dumps(user), max_age=7 * 24 * 3600, httponly=True, samesite="lax")
    return r


@app.get("/logout")
def logout():
    r = RedirectResponse("/login", status_code=303)
    r.delete_cookie(COOKIE)
    return r


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    if not current_user(request):
        return RedirectResponse("/login", status_code=303)
    return (STATIC / "index.html").read_text(encoding="utf-8").replace("{{VERSION}}", __version__)


@app.get("/healthz")
def healthz():
    return {"ok": True, "version": __version__, "drones": len(hub.drones), "viewers": len(clients)}


# ---------------------------------------------------------------- JSON API
@app.get("/api/config")
def api_config(request: Request):
    user = need_user(request)
    return {"user": user, "version": __version__, "periods": stats.PERIODS,
            "models": config.MODEL_MAP, "tz": config.TIMEZONE}


@app.get("/api/drones")
def api_drones(request: Request):
    need_user(request)
    return hub.snapshot()


@app.get("/api/drones/{key}/trail")
def api_trail(key: str, request: Request):
    need_user(request)
    d = hub.drones.get(key)
    if not d:
        raise HTTPException(404)
    if d.flight:
        return {"flight_id": d.flight.id, "live": True, "points": list(d.trail)}
    fid = d.last_flight_id or next((f["id"] for f in store.flights(msn=d.msn, limit=1)), None)
    return {"flight_id": fid, "live": False, "points": store.track(fid) if fid else []}


def _flight_row(f):
    s = f["summary"]
    return {"id": f["id"], "msn": f["msn"], "model": f["model"], "start_ts": f["start_ts"], "end_ts": f["end_ts"],
            "status": f["status"], "conclusion": f["conclusion"], "note": f["note"], "has_tlog": bool(f["tlog_path"]),
            "summary": {k: v for k, v in s.items() if k not in ("events", "modes", "prearm_messages", "counts")},
            "events": [e["type"] for e in s.get("events", [])]}


@app.get("/api/flights")
def api_flights(request: Request, msn: str = None, period: str = "all", limit: int = 200):
    need_user(request)
    return [_flight_row(f) for f in store.flights(msn=msn or None, since=stats.period_start(period), limit=min(limit, 2000))]


@app.get("/api/flights/{fid}")
def api_flight(fid: int, request: Request):
    need_user(request)
    f = store.flight(fid)
    if not f:
        raise HTTPException(404)
    f.pop("tlog_path", None)
    f["track"] = store.track(fid)
    f["messages"] = store.messages(fid)
    return f


@app.post("/api/flights/{fid}/conclusion")
def api_conclusion(fid: int, request: Request, body: dict = Body(...)):
    need_user(request)
    if not store.flight(fid):
        raise HTTPException(404)
    store.set_conclusion(fid, body.get("conclusion"), (body.get("note") or "")[:1000])
    return {"ok": True}


@app.get("/api/flights/{fid}/tlog")
def api_tlog(fid: int, request: Request):
    need_user(request)
    f = store.flight(fid)
    if not f or not f["tlog_path"] or not Path(f["tlog_path"]).exists():
        raise HTTPException(404, "no telemetry log recorded for this flight")
    return FileResponse(f["tlog_path"], filename=Path(f["tlog_path"]).name, media_type="application/octet-stream")


@app.get("/api/stats")
async def api_stats(request: Request, msn: str = None, period: str = "all"):
    need_user(request)
    flights = store.flights(msn=msn or None, since=stats.period_start(period))
    out = stats.aggregate(flights)
    out["period"] = period
    out["msn"] = msn or None
    return out


# ---------------------------------------------------------------- demo-site planner
@app.get("/api/planner/profiles")
def api_profiles(request: Request):
    need_user(request)
    return planner.profiles()


@app.post("/api/planner/analyze")
async def api_analyze(request: Request, body: dict = Body(...)):
    need_user(request)
    try:
        lat, lon = planner.parse_coords(str(body.get("coords") or ""))
    except ValueError as e:
        raise HTTPException(400, str(e))
    when = None
    if body.get("when"):
        try:
            when = datetime.fromisoformat(body["when"])
        except ValueError:
            raise HTTPException(400, "Use a date and time like 2026-10-24T11:00.")
    try:
        result = await planner.analyze(lat, lon, int(body.get("radius_m") or 0) or None, int(body.get("altitude_m") or 60),
                                       when, body.get("profile") or "tavas")
    except ValueError as e:
        raise HTTPException(400, str(e))
    name = (body.get("name") or "").strip()[:120] or f"Site {lat:.4f}, {lon:.4f}"
    customer = (body.get("customer") or "").strip()[:120]
    result["id"] = store.save_plan(name, customer, lat, lon, result)
    result["name"], result["customer"] = name, customer
    return result


@app.get("/api/planner/plans")
def api_plans(request: Request):
    need_user(request)
    return store.plans()


def _plan_or_404(pid):
    p = store.plan(pid)
    if not p:
        raise HTTPException(404, "plan not found")
    r = p["result"]
    r.update(id=p["id"], name=p["name"], customer=p["customer"])
    return r


@app.get("/api/planner/plans/{pid}")
def api_plan(pid: int, request: Request):
    need_user(request)
    return _plan_or_404(pid)


@app.delete("/api/planner/plans/{pid}")
def api_plan_delete(pid: int, request: Request):
    need_user(request)
    store.delete_plan(pid)
    return {"ok": True}


def _fname(r, ext):
    import re as _re
    return _re.sub(r"[^A-Za-z0-9_-]+", "_", r["name"])[:60] + f"_{r['route']['dir']}.{ext}"


@app.get("/api/planner/plans/{pid}/mission.plan")
def api_plan_qgc(pid: int, request: Request):
    need_user(request)
    r = _plan_or_404(pid)
    if not r.get("route"):
        raise HTTPException(409, "this site has no flyable direction")
    return Response(json.dumps(planner.qgc_plan(r), indent=2), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{_fname(r, "plan")}"'})


@app.get("/api/planner/plans/{pid}/mission.waypoints")
def api_plan_mp(pid: int, request: Request):
    need_user(request)
    r = _plan_or_404(pid)
    if not r.get("route"):
        raise HTTPException(409, "this site has no flyable direction")
    return PlainTextResponse(planner.mp_waypoints(r), headers={"Content-Disposition": f'attachment; filename="{_fname(r, "waypoints")}"'})


@app.get("/api/zones")
def api_zones(request: Request):
    need_user(request)
    return airspace.load_zones()


@app.post("/api/zones")
def api_zone_add(request: Request, body: dict = Body(...)):
    need_user(request)
    try:
        center = None
        if body.get("coords"):
            center = list(planner.parse_coords(body["coords"]))
        z = airspace.add_zone(body.get("name") or "", body.get("color") or "red", ring=body.get("ring"), center=center,
                              radius_m=float(body["radius_m"]) if body.get("radius_m") else None,
                              max_agl_m=float(body["max_agl_m"]) if body.get("max_agl_m") else None, note=body.get("note") or "")
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))
    return z


@app.post("/api/zones/import")
async def api_zone_import(request: Request, file: UploadFile = File(...), color: str = Form("red")):
    need_user(request)
    raw = (await file.read()).decode("utf-8", "replace")
    try:
        if raw.lstrip().startswith("<"):
            found = airspace.zones_from_kml(raw, color)
        else:
            found = airspace.zones_from_geojson(json.loads(raw), color)
    except ValueError:
        raise HTTPException(400, "Could not read the file. Use GeoJSON or KML polygons.")
    if not found:
        raise HTTPException(400, "No polygons found in the file.")
    added = [airspace.add_zone(z["name"], z["color"], ring=z.get("ring"), center=z.get("center"), radius_m=z.get("radius_m"),
                               note=f"imported from {file.filename}") for z in found]
    return {"added": len(added)}


@app.delete("/api/zones/{zid}")
def api_zone_delete(zid: str, request: Request):
    need_user(request)
    if not airspace.delete_zone(zid):
        raise HTTPException(404)
    return {"ok": True}


# ---------------------------------------------------------------- live push to browsers
@app.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    if not current_user(ws):
        await ws.close(code=4401)
        return
    await ws.accept()
    clients.add(ws)
    try:
        await ws.send_text(json.dumps({"type": "snapshot", "t": time.time(), "drones": hub.snapshot()}))
        while True:
            await ws.receive_text()  # keeps the socket open; the page sends pings
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        clients.discard(ws)


async def _broadcast_loop():
    while True:
        await asyncio.sleep(0.25)
        if not clients:
            continue
        try:
            payload = json.dumps({"type": "snapshot", "t": time.time(), "drones": hub.snapshot()})
        except Exception:
            continue
        dead = []
        for c in list(clients):
            try:
                await asyncio.wait_for(c.send_text(payload), timeout=2)
            except Exception:
                dead.append(c)
        for c in dead:
            clients.discard(c)


async def _tick_loop():
    while True:
        await asyncio.sleep(5)
        try:
            hub.tick()
        except Exception:
            pass


# ---------------------------------------------------------------- telemetry in
@app.websocket("/ws/ingest")
async def ws_ingest(ws: WebSocket):
    q = ws.query_params
    if not hmac.compare_digest(q.get("token", ""), config.INGEST_TOKEN):
        await ws.close(code=4401)
        return
    msn = (q.get("msn") or "").strip()[:40] or None
    model = (q.get("model") or "").strip()[:40] or None
    await ws.accept()
    source = f"ws:{id(ws)}"
    try:
        while True:
            m = await ws.receive()
            if m.get("type") == "websocket.disconnect":
                break
            data = m.get("bytes")
            if data:
                hub.feed(source, data, msn, model)
    except WebSocketDisconnect:
        pass
    finally:
        hub.drop_source(source)


class _UdpMavlink(asyncio.DatagramProtocol):
    def datagram_received(self, data, addr):
        hub.feed(f"udp:{addr[0]}:{addr[1]}", data)


# ---------------------------------------------------------------- video (MediaMTX)
@app.post("/internal/mtx-auth")
async def mtx_auth(body: dict = Body(...)):
    """MediaMTX asks us whether a publish/read is allowed (authMethod: http)."""
    action, pw, user = body.get("action"), body.get("password") or "", body.get("user") or ""
    if action == "publish":
        ok = hmac.compare_digest(pw, config.VIDEO_PUBLISH_PASS)
    elif action in ("read", "playback"):
        ok = user == "twin" and hmac.compare_digest(pw, config.VIDEO_READ_PASS)
    else:
        ok = body.get("ip") in ("127.0.0.1", "::1")
    return Response(status_code=200 if ok else 401)


_HOP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding", "cookie", "authorization", "accept-encoding"}


async def _proxy(request, base, rest, rewrite_prefix):
    url = f"{base}/{rest}"
    if request.url.query:
        url += "?" + request.url.query
    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP}
    body = await request.body()
    client = httpx.AsyncClient(timeout=15, auth=("twin", config.VIDEO_READ_PASS))
    try:
        req = client.build_request(request.method, url, headers=headers, content=body)
        r = await client.send(req, stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        return JSONResponse({"error": f"video server unreachable: {e}"}, status_code=502)
    out_headers = {k: v for k, v in r.headers.items() if k.lower() not in _HOP | {"content-encoding", "www-authenticate"}}
    loc = r.headers.get("location")
    if loc and loc.startswith("/"):
        out_headers["location"] = rewrite_prefix + loc

    async def body_iter():
        try:
            async for chunk in r.aiter_raw():
                yield chunk
        finally:
            await r.aclose()
            await client.aclose()

    return StreamingResponse(body_iter(), status_code=r.status_code, headers=out_headers)


@app.api_route("/video/webrtc/{rest:path}", methods=["POST", "PATCH", "DELETE", "OPTIONS"])
async def video_webrtc(rest: str, request: Request):
    need_user(request)
    return await _proxy(request, config.MEDIAMTX_WEBRTC, rest, "/video/webrtc")


@app.get("/video/hls/{rest:path}")
async def video_hls(rest: str, request: Request):
    need_user(request)
    return await _proxy(request, config.MEDIAMTX_HLS, rest, "/video/hls")
