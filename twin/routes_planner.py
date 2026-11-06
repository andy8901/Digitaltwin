"""Demo-site planner and restricted-area routes."""
import json
from datetime import datetime

from fastapi import APIRouter, Body, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import PlainTextResponse, Response

from . import airspace, planner
from .state import store, user

router = APIRouter()


# ---------------------------------------------------------------- demo-site planner
@router.get("/api/planner/profiles")
def api_profiles(request: Request):
    user(request)
    return planner.profiles()


@router.post("/api/planner/analyze")
async def api_analyze(request: Request, body: dict = Body(...)):
    user(request)
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


@router.get("/api/planner/plans")
def api_plans(request: Request):
    user(request)
    return store.plans()


def _plan_or_404(pid):
    p = store.plan(pid)
    if not p:
        raise HTTPException(404, "plan not found")
    r = p["result"]
    r.update(id=p["id"], name=p["name"], customer=p["customer"])
    return r


@router.get("/api/planner/plans/{pid}")
def api_plan(pid: int, request: Request):
    user(request)
    return _plan_or_404(pid)


@router.delete("/api/planner/plans/{pid}")
def api_plan_delete(pid: int, request: Request):
    user(request)
    store.delete_plan(pid)
    return {"ok": True}


def _fname(r, ext):
    import re as _re
    return _re.sub(r"[^A-Za-z0-9_-]+", "_", r["name"])[:60] + f"_{r['route']['dir']}.{ext}"


@router.get("/api/planner/plans/{pid}/mission.plan")
def api_plan_qgc(pid: int, request: Request):
    user(request)
    r = _plan_or_404(pid)
    if not r.get("route"):
        raise HTTPException(409, "this site has no flyable direction")
    return Response(json.dumps(planner.qgc_plan(r), indent=2), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{_fname(r, "plan")}"'})


@router.get("/api/planner/plans/{pid}/mission.waypoints")
def api_plan_mp(pid: int, request: Request):
    user(request)
    r = _plan_or_404(pid)
    if not r.get("route"):
        raise HTTPException(409, "this site has no flyable direction")
    return PlainTextResponse(planner.mp_waypoints(r), headers={"Content-Disposition": f'attachment; filename="{_fname(r, "waypoints")}"'})


@router.get("/api/zones")
def api_zones(request: Request):
    user(request)
    return airspace.load_zones()


@router.post("/api/zones")
def api_zone_add(request: Request, body: dict = Body(...)):
    user(request)
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


@router.post("/api/zones/import")
async def api_zone_import(request: Request, file: UploadFile = File(...), color: str = Form("red")):
    user(request)
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


@router.delete("/api/zones/{zid}")
def api_zone_delete(zid: str, request: Request):
    user(request)
    if not airspace.delete_zone(zid):
        raise HTTPException(404)
    return {"ok": True}
