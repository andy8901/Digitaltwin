"""Flight logs: uploads, replay timelines, incident reports and the organisation-wide overview."""
import hashlib
import json
import re
import time
from datetime import datetime, timedelta

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response

from . import config, flightlog, stats
from .state import analyser, fleet, hub, store, user

router = APIRouter()
UPLOADS = config.DATA_DIR / "uploads"
MAX_UPLOAD = 600 * 1024 * 1024


def _slot(key):
    return next((s for s in fleet.slots if s["key"] == key), {})


def _meta(f):
    s = _slot(f["drone_key"])
    d = hub.drones.get(f["drone_key"])
    summ = f["summary"] if isinstance(f["summary"], dict) else json.loads(f["summary"] or "{}")
    return {"id": f["id"], "drone_key": f["drone_key"], "drone_id": s.get("drone_id") or (d.drone_id if d else f["drone_key"]),
            "gcs_id": s.get("gcs_id"), "model": s.get("model") or f.get("model"), "department": s.get("department") or "",
            "customer": s.get("customer") or "", "location": s.get("location") or "",
            "start_ts": f["start_ts"], "end_ts": f["end_ts"], "status": f["status"], "source": f.get("source") or "live",
            "log_name": f.get("log_name"), "analysis_status": f.get("analysis_status"), "analysis_error": f.get("analysis_error"),
            "received_ts": f.get("received_ts") or f["end_ts"], "uploaded_by": f.get("uploaded_by"),
            "conclusion": f.get("conclusion"), "note": f.get("note"), "reviewed_by": f.get("reviewed_by"),
            "has_log": bool(f.get("tlog_path")), "flight_time_min": summ.get("flight_time_min"), "distance_m": summ.get("distance_m")}


# ---------------------------------------------------------------- upload
@router.post("/api/logs/upload")
async def upload_log(request: Request, file: UploadFile = File(...), drone: str = Form(...)):
    u = user(request, "operator")
    slot = _slot(drone)
    if not slot:
        raise HTTPException(400, "choose which drone this log belongs to")
    name = re.sub(r"[^\w.\-]+", "_", file.filename or "log")[-120:]
    ext = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    if ext not in ("bin", "tlog", "log"):
        raise HTTPException(400, "upload an ArduPilot .bin (on-board log) or a .tlog (telemetry log)")
    UPLOADS.mkdir(parents=True, exist_ok=True)
    tmp = UPLOADS / f".incoming-{time.time_ns()}"
    h = hashlib.sha256()
    size = 0
    with open(tmp, "wb") as out:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD:
                out.close()
                tmp.unlink(missing_ok=True)
                raise HTTPException(413, "log larger than 600 MB")
            h.update(chunk)
            out.write(chunk)
    digest = h.hexdigest()
    dup = store.by_hash(digest)
    if dup:
        tmp.unlink(missing_ok=True)
        return {"id": dup, "duplicate": True}
    dest = UPLOADS / f"{digest[:16]}_{name}"
    tmp.rename(dest)
    fid = store.add_upload(slot["key"], slot.get("msn") or slot["drone_id"], slot.get("model"), name, digest, dest, u["username"])
    analyser.enqueue(fid)
    return {"id": fid, "duplicate": False}


@router.get("/api/flights/{fid}/log")
def download_log(fid: int, request: Request):
    user(request)
    f = store.flight(fid)
    if not f or not f.get("tlog_path"):
        raise HTTPException(404)
    return FileResponse(f["tlog_path"], filename=f.get("log_name") or f"flight{fid}.tlog", media_type="application/octet-stream")


# ---------------------------------------------------------------- analysis and replay
@router.get("/api/flights/{fid}/analysis")
def flight_analysis(fid: int, request: Request):
    user(request)
    f = store.flight(fid)
    if not f:
        raise HTTPException(404)
    out = _meta(f)
    out["report"] = json.loads(f["report"]) if f.get("report") else None
    out["queue_position"] = (list(analyser.queued).index(fid) + 1) if fid in analyser.queued else None
    if f.get("file_hash"):
        same = [r[0] for r in store._x("SELECT id FROM flights WHERE file_hash=? AND id!=?", (f["file_hash"], fid))]
        out["same_log"] = same
    out["alerts"] = [dict(a) for a in store.alerts(f["drone_key"], since=f["start_ts"] - 1, limit=500)
                     if f.get("source") != "upload" and a["ts"] <= (f["end_ts"] or time.time()) + 1]
    out["cells"] = _slot(f["drone_key"]).get("battery_cells")
    return out


@router.get("/api/flights/{fid}/timeline")
def flight_timeline(fid: int, request: Request):
    user(request)
    tl = flightlog.load(fid)
    if not tl:
        raise HTTPException(404, "this flight hasn't been analysed yet")
    return Response(json.dumps(tl, separators=(",", ":")), media_type="application/json")


@router.post("/api/flights/{fid}/reanalyse")
def reanalyse(fid: int, request: Request):
    user(request, "operator")
    if not store.flight(fid):
        raise HTTPException(404)
    store.set_analysis(fid, "pending")
    analyser.enqueue(fid)
    return {"ok": True}


# ---------------------------------------------------------------- organisation overview
def _day(s, end=False):
    try:
        d = datetime.strptime(s, "%Y-%m-%d")
    except (TypeError, ValueError):
        return None
    return (d + timedelta(days=1)).timestamp() if end else d.timestamp()


def _verdict(f):
    if not f.get("report"):
        return None
    r = json.loads(f["report"])
    return {"level": r["level"], "headline": r["headline"], "termination": r["termination"], "critical": r["counts"]["critical"],
            "warning": r["counts"]["warning"], "fc_errors": r.get("fc_errors", 0), "analysed": r.get("analysed"),
            "flight_time_s": r.get("flight_time_s"), "distance_m": r.get("distance_m")}


def _filter(rows, q, slots):
    keep = {s["key"] for s in slots
            if (not q.get("department") or s.get("department") == q["department"])
            and (not q.get("type") or (s.get("model") or "") == q["type"])
            and (not q.get("drone") or s["key"] == q["drone"])
            and (not q.get("customer") or s.get("customer") == q["customer"])
            and (not q.get("location") or s.get("location") == q["location"])}
    out = []
    st = q.get("status")
    for f in rows:
        if f["drone_key"] not in keep:
            continue
        v = f["_v"]
        if st == "completed" and not (v and v["termination"] == "landed"):
            continue
        if st == "incident" and not (v and v["level"] == "critical"):
            continue
        if st == "warning" and not (v and v["level"] == "warning"):
            continue
        if st == "in_flight" and f["status"] != "flying":
            continue
        if st == "pending" and f.get("analysis_status") not in ("pending", "running", None):
            continue
        if st == "error" and f.get("analysis_status") != "error":
            continue
        out.append(f)
    return out


def _kpis(rows, today0):
    done = [f for f in rows if f.get("analysis_status") == "done"]
    ft = [f["_v"]["flight_time_s"] for f in done if f["_v"] and f["_v"]["flight_time_s"]]
    dist = [f["_v"]["distance_m"] for f in done if f["_v"] and f["_v"]["flight_time_s"]]
    return {
        "uploads": sum(1 for f in rows if f.get("source") == "upload"),
        "analysed": len(done),
        "active_drones": len({f["drone_key"] for f in rows}),
        "logs_received": sum(1 for f in rows if f.get("tlog_path")),
        "analysed_today": sum(1 for f in done if (f["_v"] or {}).get("analysed", 0) >= today0),
        "critical": sum(1 for f in done if f["_v"]["level"] == "critical"),
        "crashes": sum(1 for f in rows if (f["summary"] or {}).get("crash")),
        "reviewed": sum(1 for f in rows if f.get("conclusion")),
        "flights": len(rows),
        "avg_flight_min": round(sum(ft) / len(ft) / 60, 2) if ft else None,
        "avg_distance_m": round(sum(dist) / len(dist)) if dist else None,
    }


@router.get("/api/org/overview")
def org_overview(request: Request, department: str = "", type: str = "", drone: str = "", customer: str = "",
                 location: str = "", start: str = "", end: str = "", status: str = ""):
    user(request)
    q = {"department": department, "type": type, "drone": drone, "customer": customer, "location": location, "status": status}
    since, until = _day(start), _day(end, end=True)
    every = store.flights(since=None)
    for f in every:
        f["_v"] = _verdict(f)
    slots = fleet.slots
    rows = [f for f in _filter(every, q, slots) if (since is None or f["start_ts"] >= since) and (until is None or f["start_ts"] < until)]
    today0 = stats.period_start("today")
    k = _kpis(rows, today0)
    prev = None
    if since is not None:
        span = (until or time.time()) - since
        pr = [f for f in _filter(every, q, slots) if since - span <= f["start_ts"] < since]
        prev = _kpis(pr, today0)
    depts = sorted({s.get("department") for s in slots if s.get("department")})
    k["departments"] = len({s.get("department") for s in slots if s.get("department")
                            and (not department or s.get("department") == department)})
    k["users"] = len(store.users())
    now = time.time()
    k["connected_now"] = sum(1 for d in hub.ordered() if d.status(now) != "offline")

    def row(f):
        m = _meta(f)
        m["verdict"] = f["_v"]
        return m
    with_log = [f for f in rows if f.get("tlog_path")]
    by_drone = {}
    for f in rows:
        b = by_drone.setdefault(f["drone_key"], {"drone_key": f["drone_key"], "drone_id": _slot(f["drone_key"]).get("drone_id", f["drone_key"]),
                                                 "flights": 0, "hours": 0.0, "critical": 0, "warning": 0, "reviewed": 0, "last": 0, "uploads": 0})
        b["flights"] += 1
        b["hours"] += ((f["summary"] or {}).get("flight_time_min") or 0) / 60
        b["critical"] += 1 if f["_v"] and f["_v"]["level"] == "critical" else 0
        b["warning"] += 1 if f["_v"] and f["_v"]["level"] == "warning" else 0
        b["reviewed"] += 1 if f.get("conclusion") else 0
        b["uploads"] += 1 if f.get("source") == "upload" else 0
        b["last"] = max(b["last"], f["start_ts"])
    return {
        "kpis": k, "previous": prev,
        "options": {
            "departments": depts, "types": sorted({s.get("model") or "" for s in slots if s.get("model")}),
            "drones": [{"key": s["key"], "drone_id": s["drone_id"]} for s in slots],
            "customers": sorted({s.get("customer") for s in slots if s.get("customer")}),
            "locations": sorted({s.get("location") for s in slots if s.get("location")}),
        },
        "lists": {
            "recent": [row(f) for f in sorted(with_log, key=lambda f: -(f.get("received_ts") or f["end_ts"] or f["start_ts"]))[:40]],
            "pending": [row(f) for f in rows if f.get("analysis_status") in ("pending", "running") or (f.get("analysis_status") is None and f["status"] != "flying")][:40],
            "critical": [row(f) for f in rows if f["_v"] and f["_v"]["level"] == "critical"][:40],
            "errors": [row(f) for f in rows if f.get("analysis_status") == "error" or (f["_v"] and f["_v"]["fc_errors"])][:40],
            "analysed": [row(f) for f in rows if f.get("analysis_status") == "done"][:40],
            "by_drone": sorted(({**b, "hours": round(b["hours"], 2)} for b in by_drone.values()), key=lambda b: b["drone_id"]),
        },
        "unassigned_slots": sum(1 for s in slots if not s.get("department")),
    }
