"""Demo-site planner: given a customer's coordinates, find the safest direction to fly the demo.

For the take-off point and 16 directions around it (out to the planned radius, by default the drone's video range)
it checks:
- DGCA airspace zone (twin.airspace): red / yellow / green and the height that stays green
- obstacles from OpenStreetMap: buildings (with heights), towers and masts, power lines, trees
- ground risk: roads, railways, schools/hospitals/markets/stadiums (no flying over crowds), water
- terrain from the Copernicus/SRTM elevation model (Open-Meteo)
- weather at the planned time (Open-Meteo): wind at 10/80/120 m, gusts, rain, temperature, visibility, daylight
- sun position (camera glare)
against the drone's own limits (twin/data/drone_profiles.json, TAVAS from its spec sheet), then scores each
direction, recommends one, draws a demo route inside it and exports it for Mission Planner / QGroundControl.

Live data sources are fetched by the server; if one is unreachable the plan says so and carries on without it.
"""
import asyncio
import json
import math
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import httpx

from . import config
from .airspace import Airspace
from .geo import bearing, circle, compass, destination, haversine, sun_position, wedge

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo(config.TIMEZONE)
except Exception:  # pragma: no cover
    TZ = timezone(timedelta(hours=5, minutes=30))

PROFILES_FILE = config.BASE_DIR / "data" / "drone_profiles.json"
OVERPASS = [u for u in (config.OVERPASS_URL, "https://overpass-api.de/api/interpreter",
                        "https://overpass.kumi.systems/api/interpreter") if u]
SECTORS = 16
CLEARANCE_M = 20     # keep this far above obstacles
CLIMB_OUT_M = 150    # take-off path checked for anything over 10 m


@lru_cache(maxsize=1)
def profiles():
    return json.loads(PROFILES_FILE.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- coordinates
def parse_coords(text):
    """'12.97, 77.59' / '12°58'17"N 77°35'40"E' / Google Maps links -> (lat, lon)."""
    t = (text or "").strip()
    m = re.search(r"@(-?\d+\.\d+),(-?\d+\.\d+)", t) or re.search(r"[?&](?:q|query|ll|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)", t)
    if m:
        return _check(float(m.group(1)), float(m.group(2)))
    dms = re.findall(r"(\d+(?:\.\d+)?)\s*[°º d]\s*(?:(\d+(?:\.\d+)?)\s*['′m ]\s*)?(?:(\d+(?:\.\d+)?)\s*(?:\"|″|''|s)?\s*)?([NSEW])", t, re.I)
    if len(dms) == 2:
        vals = []
        for d, mi, se, hemi in dms:
            v = float(d) + float(mi or 0) / 60 + float(se or 0) / 3600
            vals.append((-v if hemi.upper() in "SW" else v, hemi.upper()))
        lat = next(v for v, h in vals if h in "NS")
        lon = next(v for v, h in vals if h in "EW")
        return _check(lat, lon)
    nums = re.findall(r"-?\d+(?:\.\d+)?", t)
    if len(nums) >= 2:
        return _check(float(nums[0]), float(nums[1]))
    raise ValueError("Could not read coordinates. Use '12.9716, 77.5946', degrees-minutes-seconds, or a Google Maps link.")


def _check(lat, lon):
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("Coordinates out of range.")
    if not (6 <= lat <= 37.5 and 68 <= lon <= 97.5):
        raise ValueError("These coordinates are outside India; the DGCA airspace rules don't apply there.")
    return round(lat, 6), round(lon, 6)


# ---------------------------------------------------------------- live data
def _overpass_query(lat, lon, r_m):
    def bb(rad):
        s, w = destination(lat, lon, 225, rad * 1.42)
        n, e = destination(lat, lon, 45, rad * 1.42)
        return f"{s:.6f},{w:.6f},{n:.6f},{e:.6f}"
    near, wide = bb(r_m + 300), bb(r_m + 6000)
    return f"""[out:json][timeout:40];
(
  way["building"]({near});
  node["man_made"~"^(mast|tower|communications_tower|chimney|water_tower|crane|lighthouse|flagpole)$"]({near});
  way["man_made"~"^(mast|tower|communications_tower|chimney|water_tower|lighthouse)$"]({near});
  node["power"~"^(tower|pole|portal)$"]({near});
  node["natural"="tree"]({near});
  way["natural"~"^(wood|water)$"]({near});
  way["landuse"="forest"]({near});
  nwr["amenity"~"^(school|college|university|hospital|place_of_worship|marketplace|bus_station)$"]({near});
  nwr["leisure"="stadium"]({near});
  nwr["aeroway"~"^(helipad|aerodrome)$"]({near});
)->.pts;
.pts out center tags qt;
(
  way["power"~"^(line|minor_line)$"]({near});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"]({near});
  way["railway"~"^(rail|light_rail|subway)$"]({near});
  way["natural"="coastline"]({near});
)->.lines;
.lines out geom qt;
(
  way["landuse"="military"]({wide});
  relation["landuse"="military"]({wide});
  way["military"]({wide});
  nwr["plant:source"="nuclear"]({wide});
  nwr["generator:source"="nuclear"]({wide});
  way["office"="government"]["name"~"Secretariat|Vidhana|Vidhan|Raj Bhavan|Parliament|Assembly|Mantralaya",i]({wide});
  way["building"]["name"~"Secretariat|Vidhana Soudha|Vidhan Bhavan|Raj Bhavan|Mantralaya",i]({wide});
)->.sens;
.sens out geom qt;"""


async def fetch_osm(client, lat, lon, r_m):
    q = _overpass_query(lat, lon, r_m)
    last = None
    for url in OVERPASS:
        try:
            r = await client.post(url, data={"data": q}, timeout=60)
            r.raise_for_status()
            return r.json().get("elements", [])
        except Exception as e:  # try the next mirror
            last = e
    raise RuntimeError(f"map data (OpenStreetMap/Overpass) unreachable: {last}")


async def fetch_elevation(client, pts):
    lats = ",".join(f"{p[0]:.5f}" for p in pts)
    lons = ",".join(f"{p[1]:.5f}" for p in pts)
    r = await client.get("https://api.open-meteo.com/v1/elevation", params={"latitude": lats, "longitude": lons}, timeout=20)
    r.raise_for_status()
    return r.json()["elevation"]


async def fetch_weather(client, lat, lon, when_local):
    day = when_local.date()
    if (day - datetime.now(TZ).date()).days > 15:
        raise RuntimeError("the forecast only covers the next 16 days")
    r = await client.get("https://api.open-meteo.com/v1/forecast", params={
        "latitude": lat, "longitude": lon, "timezone": config.TIMEZONE, "wind_speed_unit": "ms",
        "start_date": day.isoformat(), "end_date": day.isoformat(),
        "hourly": "temperature_2m,precipitation,precipitation_probability,weather_code,visibility,cloud_cover,"
                  "wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_80m,wind_speed_120m,wind_direction_120m",
        "daily": "sunrise,sunset",
    }, timeout=20)
    r.raise_for_status()
    j = r.json()
    h = j["hourly"]
    idx = min(range(len(h["time"])), key=lambda i: abs(datetime.fromisoformat(h["time"][i]).replace(tzinfo=TZ) - when_local))
    hour = {k: (v[idx] if isinstance(v, list) else v) for k, v in h.items()}
    hours = [{"time": h["time"][i][11:16], "wind10": h["wind_speed_10m"][i], "wind120": h["wind_speed_120m"][i],
              "gust": h["wind_gusts_10m"][i], "rain": h["precipitation"][i], "temp": h["temperature_2m"][i]}
             for i in range(len(h["time"])) if 6 <= int(h["time"][i][11:13]) <= 18]
    return {"hour": hour, "sunrise": j["daily"]["sunrise"][0][11:16], "sunset": j["daily"]["sunset"][0][11:16], "day": hours}


# ---------------------------------------------------------------- OSM -> obstacles / ground risk / sensitive areas
def _num(v):
    m = re.search(r"\d+(?:\.\d+)?", str(v or ""))
    return float(m.group()) if m else None


def _height(tags):
    h = _num(tags.get("height"))
    if h:
        return h, True
    lv = _num(tags.get("building:levels"))
    if lv:
        return lv * 3.2 + 1.5, True
    mm = tags.get("man_made")
    if mm in ("mast", "communications_tower", "tower"):
        return 35.0, False
    if mm in ("chimney", "crane", "lighthouse"):
        return 40.0, False
    if mm == "water_tower":
        return 20.0, False
    if mm == "flagpole":
        return 15.0, False
    if tags.get("power") in ("tower", "portal"):
        return 30.0, False
    if tags.get("power") == "pole":
        return 10.0, False
    if tags.get("natural") == "tree":
        return 12.0, False
    if tags.get("building"):
        return 7.0, False
    return None, False


def classify_osm(elements):
    obstacles, lines, areas, crowd, sensitive = [], [], [], [], []
    for el in elements:
        tags = el.get("tags", {})
        c = el.get("center") or ({"lat": el["lat"], "lon": el["lon"]} if "lat" in el else None)
        geom = [[g["lat"], g["lon"]] for g in el.get("geometry", []) if g]
        name = tags.get("name")
        if tags.get("landuse") == "military" or tags.get("military"):
            ring = geom or None
            if ring or c:
                sensitive.append({"label": f"military area{f' ({name})' if name else ''}", "ring": ring,
                                  "lat": (c or {}).get("lat"), "lon": (c or {}).get("lon"), "buffer_m": 3000})
            continue
        if tags.get("plant:source") == "nuclear" or tags.get("generator:source") == "nuclear":
            sensitive.append({"label": f"nuclear installation{f' ({name})' if name else ''}", "ring": geom or None,
                              "lat": (c or (geom and {"lat": geom[0][0], "lon": geom[0][1]}) or {}).get("lat"),
                              "lon": (c or (geom and {"lat": geom[0][0], "lon": geom[0][1]}) or {}).get("lon"), "buffer_m": 5000})
            continue
        if tags.get("office") == "government" or (name and re.search(r"Secretariat|Vidhana Soudha|Vidhan Bhavan|Raj Bhavan|Mantralaya", name, re.I)):
            if geom:
                sensitive.append({"label": name or "government seat", "ring": geom, "buffer_m": 2000})
            continue
        if tags.get("power") in ("line", "minor_line"):
            lines.append({"kind": "power_line", "coords": geom, "height": 25.0 if tags.get("power") == "line" else 10.0,
                          "label": "power line" + (f" {tags.get('voltage')} V" if tags.get("voltage") else "")})
            continue
        if tags.get("highway"):
            lines.append({"kind": "road", "coords": geom, "label": name or f"{tags['highway']} road"})
            continue
        if tags.get("railway"):
            lines.append({"kind": "railway", "coords": geom, "label": name or "railway"})
            continue
        if tags.get("natural") == "coastline":
            lines.append({"kind": "coastline", "coords": geom, "label": "coastline"})
            continue
        if c is None:
            continue
        if tags.get("amenity") or tags.get("leisure") == "stadium":
            crowd.append({"lat": c["lat"], "lon": c["lon"], "label": name or (tags.get("amenity") or "stadium").replace("_", " ")})
            if not tags.get("building"):
                continue
        if tags.get("aeroway") in ("helipad", "aerodrome"):
            crowd.append({"lat": c["lat"], "lon": c["lon"], "label": f"{tags['aeroway']}{f' {name}' if name else ''} (check DigitalSky)"})
            continue
        if tags.get("natural") in ("wood", "water") or tags.get("landuse") == "forest":
            areas.append({"lat": c["lat"], "lon": c["lon"], "kind": "water" if tags.get("natural") == "water" else "trees",
                          "label": name or ("water" if tags.get("natural") == "water" else "trees / woods")})
            continue
        h, known = _height(tags)
        if h is None:
            continue
        kind = "building" if tags.get("building") else ("tree" if tags.get("natural") == "tree" else "structure")
        label = name or (tags.get("man_made") or tags.get("power") or kind).replace("_", " ")
        obstacles.append({"lat": c["lat"], "lon": c["lon"], "h": round(h, 1), "known": known, "kind": kind, "label": label})
    return obstacles, lines, areas, crowd, sensitive


# ---------------------------------------------------------------- analysis
def _sector_of(brg):
    return int(((brg % 360) + 360 / SECTORS / 2) // (360 / SECTORS)) % SECTORS


def _densify(coords, step=25):
    out = []
    for i in range(len(coords) - 1):
        a, b = coords[i], coords[i + 1]
        d = haversine(a[0], a[1], b[0], b[1])
        n = max(1, int(d / step))
        for k in range(n):
            f = k / n
            out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
    if coords:
        out.append(tuple(coords[-1]))
    return out


async def analyze(lat, lon, radius_m=None, altitude_m=60, when=None, profile="tavas", fetch=None):
    """Full site analysis. `fetch` overrides the live-data fetchers (used by tests)."""
    prof = profiles().get(profile) or next(iter(profiles().values()))
    radius_m = int(min(max(300, radius_m or prof["video_range_m"]), prof["video_range_m"], 3000))
    altitude_m = int(min(max(15, altitude_m or 60), prof["max_agl_m"]))
    when_local = when or datetime.now(TZ).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    if when_local.tzinfo is None:
        when_local = when_local.replace(tzinfo=TZ)

    # ring of sample points used for terrain (centre, then 16 directions x 3 distances)
    terrain_pts = [(lat, lon)] + [destination(lat, lon, i * 360 / SECTORS, radius_m * f) for i in range(SECTORS) for f in (1 / 3, 2 / 3, 1)]
    sources = {}
    fetch = fetch or {}
    async with httpx.AsyncClient(headers={"User-Agent": "NeoskyLiveTwin/1.1 (demo planner)"}) as client:
        tasks = {
            "osm": (fetch.get("osm") or (lambda: fetch_osm(client, lat, lon, radius_m)))(),
            "elevation": (fetch.get("elevation") or (lambda: fetch_elevation(client, terrain_pts)))(),
            "weather": (fetch.get("weather") or (lambda: fetch_weather(client, lat, lon, when_local)))(),
        }
        res = await asyncio.gather(*tasks.values(), return_exceptions=True)
    data = {}
    for k, v in zip(tasks, res):
        if isinstance(v, Exception):
            sources[k] = {"ok": False, "error": str(v)[:200]}
            data[k] = None
        else:
            sources[k] = {"ok": True}
            data[k] = v

    obstacles, lines, areas, crowd, sensitive = classify_osm(data["osm"] or [])
    air = Airspace(lat, lon, sensitive)
    zone0, maxagl0, why0 = air.classify(lat, lon)
    asked_alt = altitude_m
    if zone0 == "green" and 15 <= maxagl0 < altitude_m:
        altitude_m = maxagl0  # stay green: e.g. 60 m (200 ft) in the 8-12 km band around an airport
    # In a yellow zone the flight needs ATC permission anyway; plan inside the permitted (yellow) area, avoid red.
    permission_mode = zone0 == "yellow"

    # ---- per-direction evaluation
    step = 50
    sectors = []
    elev = data["elevation"]
    elev0 = elev[0] if elev else None
    sun_az, sun_el = sun_position(lat, lon, when_local.astimezone(timezone.utc))
    wx = (data["weather"] or {}).get("hour") if data["weather"] else None
    wind_from = wx.get("wind_direction_120m", wx.get("wind_direction_10m")) if wx else None
    wind_ms = max(wx.get("wind_speed_120m") or 0, wx.get("wind_speed_10m") or 0) if wx else None

    # bucket obstacles / lines / ground risk by direction
    def bucket(items):
        b = [[] for _ in range(SECTORS)]
        for it in items:
            d = haversine(lat, lon, it["lat"], it["lon"])
            if d <= radius_m + 50:
                it = dict(it, d=round(d), brg=round(bearing(lat, lon, it["lat"], it["lon"])))
                b[_sector_of(it["brg"])].append(it)
        return b

    obs_b, crowd_b, area_b = bucket(obstacles), bucket(crowd), bucket(areas)
    line_b = [[] for _ in range(SECTORS)]
    for ln in lines:
        seen = {}
        for p in _densify(ln["coords"]):
            d = haversine(lat, lon, p[0], p[1])
            if d > radius_m + 50:
                continue
            s = _sector_of(bearing(lat, lon, p[0], p[1]))
            if s not in seen or d < seen[s]:
                seen[s] = d
        for s, d in seen.items():
            line_b[s].append({"kind": ln["kind"], "label": ln["label"], "d": round(d), "h": ln.get("height")})

    zone_cache = {}

    def zone_at(p):
        key = (round(p[0], 4), round(p[1], 4))
        if key not in zone_cache:
            zone_cache[key] = air.classify(*p)
        return zone_cache[key]

    for i in range(SECTORS):
        az = i * 360 / SECTORS
        notes, penalty, blocked = [], 0, None
        usable = radius_m
        # airspace along the centre line and both edges
        first_bad = None
        for d in range(step, radius_m + 1, step):
            for off in (-8, 0, 8):
                z, m, w = zone_at(destination(lat, lon, az + off, d))
                bad = z == "red" if permission_mode else (z != "green" or m < altitude_m)
                if bad:
                    first_bad = (d, z, m, w)
                    break
            if first_bad:
                break
        if first_bad:
            d, z, m, w = first_bad
            usable = min(usable, d - step)
            reason = next((x["text"] for x in w if x["zone"] != "green"), None) or next((x["text"] for x in w), "")
            if z == "green":
                notes.append(f"from {d} m the green height limit is {m} m, below the planned {altitude_m} m ({reason})")
            else:
                notes.append(f"{z} zone from {d} m: {reason}")
        # tall obstacles
        tall = [o for o in obs_b[i] if o["h"] >= altitude_m - CLEARANCE_M]
        tall += [dict(l, h=l["h"]) for l in line_b[i] if l["kind"] == "power_line" and (l["h"] or 0) >= altitude_m - CLEARANCE_M]
        if tall:
            nearest = min(tall, key=lambda o: o["d"])
            usable = min(usable, max(0, nearest["d"] - 60))
            penalty += min(35, 12 * len(tall))
            notes.append(f"{len(tall)} obstacle(s) within {CLEARANCE_M} m of the flight height; nearest: {nearest['label']} "
                         f"({nearest['h']:.0f} m{'' if nearest.get('known', False) else ', height estimated'}) at {nearest['d']} m")
        climb = [o for o in obs_b[i] if o["d"] <= CLIMB_OUT_M and o["h"] >= 10]
        if climb:
            penalty += 10
            c = min(climb, key=lambda o: o["d"])
            notes.append(f"climb-out: {c['label']} ({c['h']:.0f} m) at {c['d']} m")
        pl = [l for l in line_b[i] if l["kind"] == "power_line"]
        if pl:
            penalty += 25
            notes.append(f"power line crossing at {min(l['d'] for l in pl)} m: thin wires are hard for obstacle sensors to see")
        roads = [l for l in line_b[i] if l["kind"] in ("road", "railway")]
        if roads:
            penalty += min(15, 5 * len(roads))
            notes.append("crosses " + ", ".join(sorted({l['label'] for l in roads})[:3]) + ": don't hover over traffic")
        if crowd_b[i]:
            penalty += min(16, 8 * len(crowd_b[i]))
            notes.append("crowds possible: " + ", ".join(sorted({c['label'] for c in crowd_b[i]})[:3]))
        nb = sum(1 for o in obs_b[i] if o["kind"] == "building")
        sector_area_km2 = math.pi * (radius_m / 1000) ** 2 / SECTORS
        density = nb / sector_area_km2 if sector_area_km2 else 0
        if density > 400:
            penalty += 15
            notes.append(f"dense buildings ({nb}): few emergency landing spots")
        elif density > 100:
            penalty += 7
            notes.append(f"built-up ({nb} buildings)")
        if any(a["kind"] == "water" for a in area_b[i]):
            penalty += 5
            notes.append("water: no emergency landing")
        if any(a["kind"] == "trees" for a in area_b[i]) or sum(1 for o in obs_b[i] if o["kind"] == "tree") > 5:
            penalty += 4
            notes.append("trees: keep above 30 m")
        if any(l["kind"] == "coastline" for l in line_b[i]):
            penalty += 10
            notes.append("coastline: don't fly over the sea beyond 500 m from the coast")
        # terrain
        rise = None
        if elev and elev0 is not None:
            vals = elev[1 + i * 3: 4 + i * 3]
            rise = max(v - elev0 for v in vals)
            if rise > altitude_m - 30:
                frac = next((k for k, v in enumerate(vals) if v - elev0 > altitude_m - 30), 0)
                usable = min(usable, int(radius_m * frac / 3))
                notes.append(f"terrain rises {rise:.0f} m: too close to the flight height")
            elif rise > 15:
                penalty += min(15, rise / 3)
                notes.append(f"terrain rises {rise:.0f} m")
        # wind: prefer flying out into the wind so the trip home is downwind
        bonus = 0
        if wind_from is not None and wind_ms:
            diff = abs((az - wind_from + 180) % 360 - 180)
            k = 1.5 if wind_ms > 7 else 1.0
            if diff <= 45:
                bonus += round(8 * k)
                notes.append(f"into the wind ({wind_ms:.0f} m/s from {compass(wind_from)}): the return leg is downwind")
            elif diff >= 135:
                penalty += round(8 * k)
                notes.append(f"downwind outbound: the return leg is into a {wind_ms:.0f} m/s wind")
        if sun_el < 35 and sun_el > -2:
            if abs((az - sun_az + 180) % 360 - 180) < 30:
                penalty += 6
                notes.append(f"camera faces the low sun ({sun_el:.0f}° up)")
        if usable < 300:
            blocked = notes[0] if notes else "not enough clear distance"
        elif usable < radius_m:
            penalty += round(45 * (1 - usable / radius_m))
            notes.insert(0, f"clear for {usable} m of {radius_m} m")
        score = 0 if blocked else max(0, min(100, 100 - penalty + bonus))
        sectors.append({"i": i, "az": az, "dir": compass(az), "score": score, "usable_m": int(usable), "blocked": blocked,
                        "notes": notes, "terrain_rise_m": round(rise, 1) if rise is not None else None,
                        "obstacles": len(obs_b[i]), "tall": len(tall)})

    best = max(sectors, key=lambda s: (s["score"], s["usable_m"]))
    clear_arc = _arc(sectors, best["i"])

    # ---- weather & limits against the drone's spec
    checks = _checks(prof, wx, data["weather"], elev0, when_local, zone0, maxagl0, altitude_m, sun_el)
    route = _route(lat, lon, best, altitude_m, prof, elev0, zone_at) if best["score"] > 0 else None

    takeoff = {"zone": zone0, "max_green_agl_m": maxagl0, "reasons": why0}
    verdict = _verdict(zone0, maxagl0, altitude_m, best, checks, sources)
    nearest_airports = [{"name": a["name"], "iata": a.get("iata"), "class": a["type"],
                         "dist_km": round(haversine(lat, lon, a["lat"], a["lon"]) / 1000, 1)} for a in air.airports[:5]]
    if altitude_m < asked_alt:
        verdict["reasons"].insert(0, f"flight height lowered from {asked_alt} m to {altitude_m} m to stay in the green zone")
    return {
        "input": {"lat": lat, "lon": lon, "radius_m": radius_m, "altitude_m": altitude_m, "asked_altitude_m": asked_alt,
                  "when": when_local.isoformat(), "profile": profile, "permission_mode": permission_mode},
        "profile": prof,
        "verdict": verdict,
        "takeoff": takeoff,
        "nearest_airports": nearest_airports,
        "sectors": sectors,
        "best": best,
        "clear_arc": clear_arc,
        "route": route,
        "checks": checks,
        "weather": data["weather"],
        "sun": {"azimuth": round(sun_az), "elevation": round(sun_el, 1)},
        "elevation_m": elev0,
        "overlay": {
            "airspace": air.overlay(),
            "sectors": [{"i": s["i"], "score": s["score"], "blocked": bool(s["blocked"]),
                         "coords": wedge(lat, lon, s["az"] - 180 / SECTORS, s["az"] + 180 / SECTORS, 30, radius_m)} for s in sectors],
            "radius": circle(lat, lon, radius_m, 96),
            "obstacles": [o for b in obs_b for o in b if o["h"] >= altitude_m - CLEARANCE_M or o["kind"] != "building"][:400],
            "lines": [{"kind": ln["kind"], "label": ln["label"], "coords": ln["coords"]} for ln in lines][:300],
            "crowd": [c for b in crowd_b for c in b][:100],
        },
        "counts": {"buildings": sum(1 for o in obstacles if o["kind"] == "building"), "tall": sum(s["tall"] for s in sectors),
                   "power_lines": sum(1 for l in lines if l["kind"] == "power_line"), "crowd": len(crowd)},
        "sources": sources,
        "created": datetime.now(TZ).isoformat(),
    }


def _arc(sectors, i0, threshold=70):
    """The run of neighbouring directions that are nearly as good: score >= threshold and at least 80 % clear."""
    radius = max(s["usable_m"] for s in sectors) or 1

    def good(s):
        return s["score"] >= threshold and s["usable_m"] >= 0.8 * radius

    if not good(sectors[i0]):
        return None
    lo = hi = i0
    for k in range(1, SECTORS // 2):
        j = (i0 - k) % SECTORS
        if good(sectors[j]):
            lo = j
        else:
            break
    for k in range(1, SECTORS // 2):
        j = (i0 + k) % SECTORS
        if good(sectors[j]):
            hi = j
        else:
            break
    start = sectors[lo]["az"] - 180 / SECTORS
    end = sectors[hi]["az"] + 180 / SECTORS
    return {"from": compass(start + 1), "to": compass(end - 1), "from_deg": round(start % 360), "to_deg": round(end % 360),
            "width_deg": round((end - start) % 360 or 360)}


def _checks(prof, wx, weather, elev0, when_local, zone0, maxagl0, altitude_m, sun_el):
    out = []

    def add(name, status, value, limit):
        out.append({"name": name, "status": status, "value": value, "limit": limit})

    if elev0 is not None:
        add("Launch altitude", "ok" if elev0 <= prof["max_launch_amsl_m"] else "no", f"{elev0:.0f} m AMSL", f"up to {prof['max_launch_amsl_m']} m AMSL")
    zone_lim = f"green zone up to {maxagl0} m here" if zone0 == "green" else f"{zone0} zone here: height as permitted"
    add("Flight height", "ok" if altitude_m <= prof["max_agl_m"] else "no", f"{altitude_m} m AGL", f"drone up to {prof['max_agl_m']} m; {zone_lim}")
    if wx:
        w120 = wx.get("wind_speed_120m") or wx.get("wind_speed_80m") or 0
        w10 = wx.get("wind_speed_10m") or 0
        g = wx.get("wind_gusts_10m") or 0
        wmax = prof["wind_max_ms"]
        worst = max(w120, w10, g)
        add("Wind", "no" if worst > wmax else "caution" if worst > wmax * 0.75 else "ok",
            f"{w10:.1f} m/s at 10 m, {w120:.1f} m/s at 120 m, gusts {g:.1f} m/s", f"up to {wmax} m/s")
        t = wx.get("temperature_2m")
        if t is not None:
            add("Temperature", "ok" if prof["temp_min_c"] <= t <= prof["temp_max_c"] else "no", f"{t:.0f} °C", f"{prof['temp_min_c']} to {prof['temp_max_c']} °C")
        rain = wx.get("precipitation") or 0
        prob = wx.get("precipitation_probability")
        add("Rain", "no" if rain > 2.5 else "caution" if rain > 0.2 or (prob or 0) >= 50 else "ok",
            f"{rain:.1f} mm/h" + (f", {prob}% chance" if prob is not None else ""), f"{prof['ingress']}: drizzle only")
        vis = wx.get("visibility")
        if vis is not None:
            add("Visibility", "no" if vis < 1500 else "caution" if vis < 3000 else "ok", f"{vis / 1000:.1f} km", "keep the drone in sight (VLOS)")
    if weather:
        sr, ss = weather["sunrise"], weather["sunset"]
        hm = when_local.strftime("%H:%M")
        add("Daylight", "ok" if sr <= hm <= ss else "no", f"{hm} (sunrise {sr}, sunset {ss})", "fly between sunrise and sunset")
    elif sun_el is not None:
        add("Daylight", "ok" if sun_el > 0 else "no", f"sun {sun_el:.0f}° above the horizon", "fly between sunrise and sunset")
    add("Airspace at take-off", {"green": "ok", "yellow": "caution", "red": "no"}[zone0],
        {"green": "green zone", "yellow": "yellow zone: ATC permission needed", "red": "red zone: no-fly without Central Government permission"}[zone0],
        "confirm on DigitalSky")
    return out


def _verdict(zone0, maxagl0, altitude_m, best, checks, sources):
    reasons = []
    if zone0 == "red":
        level = "no"
        reasons.append("the take-off point is in a red zone")
    elif zone0 == "yellow":
        level = "permission"
        reasons.append("the take-off point is in a yellow zone: get ATC permission through DigitalSky")
    else:
        level = "go"
        if maxagl0 < altitude_m:
            level = "permission"
            reasons.append(f"green only up to {maxagl0} m here: fly at {maxagl0} m or lower, or get ATC permission")
    if best["score"] == 0 and zone0 != "red":
        level = "no"
        reasons.append("no direction has enough clear distance" + (" outside red zones" if zone0 == "yellow" else " in the green zone"))
    for c in checks:
        if c["status"] == "no" and c["name"] not in ("Airspace at take-off",):
            level = "no"
            reasons.append(f"{c['name'].lower()}: {c['value']} (limit {c['limit']})")
        elif c["status"] == "caution" and level == "go" and c["name"] != "Airspace at take-off":
            level = "caution"
            reasons.append(f"{c['name'].lower()}: {c['value']}")
    missing = [k for k, v in sources.items() if not v["ok"]]
    if missing:
        names = {"osm": "obstacle map", "elevation": "terrain", "weather": "weather forecast"}
        reasons.append("not checked (data unavailable): " + ", ".join(names[m] for m in missing))
        if level == "go":
            level = "caution"
    label = {"go": "Good to fly", "caution": "Fly with care", "permission": "Permission needed", "no": "Do not fly"}[level]
    return {"level": level, "label": label, "reasons": reasons}


def _route(lat, lon, best, alt, prof, elev0, zone_at):
    """Out-and-back demo leg with a short sweep, kept inside the chosen direction and its clear distance."""
    az = best["az"]
    reach = min(best["usable_m"] * 0.85, prof["video_range_m"] * 0.9)
    reach = max(150, reach)
    pts = [
        ("Climb-out", destination(lat, lon, az, min(120, reach * 0.3))),
        ("Outbound", destination(lat, lon, az, reach * 0.6)),
        ("Demo point", destination(lat, lon, az, reach)),
        ("Sweep", destination(lat, lon, az + 7, reach * 0.8)),
        ("Sweep", destination(lat, lon, az - 7, reach * 0.8)),
        ("Inbound", destination(lat, lon, az, reach * 0.35)),
    ]
    wps = []
    prev = (lat, lon)
    dist = 0.0
    for name, p in pts:
        z, m, _ = zone_at(p)
        dist += haversine(prev[0], prev[1], p[0], p[1])
        prev = p
        wps.append({"name": name, "lat": round(p[0], 7), "lon": round(p[1], 7), "alt_m": alt, "zone": z})
    dist += haversine(prev[0], prev[1], lat, lon)
    hover_s = 120
    t = dist / prof["cruise_ms"] + alt / prof.get("climb_ms", 3) + alt / prof.get("descent_ms", 1.5) + hover_s
    minutes = t / 60
    return {"heading": round(az), "dir": compass(az), "reach_m": round(reach), "distance_m": round(dist), "minutes": round(minutes, 1),
            "battery_pct": round(100 * minutes / prof["endurance_min"]), "hover_s": hover_s, "waypoints": wps,
            "home": {"lat": lat, "lon": lon, "amsl": elev0}}


# ---------------------------------------------------------------- mission files
def qgc_plan(plan):
    r = plan["route"]
    home = r["home"]
    items = [{"autoContinue": True, "command": 22, "doJumpId": 1, "frame": 3, "params": [15, 0, 0, None, home["lat"], home["lon"], r["waypoints"][0]["alt_m"]], "type": "SimpleItem"}]
    for k, w in enumerate(r["waypoints"]):
        items.append({"autoContinue": True, "command": 16, "doJumpId": k + 2, "frame": 3,
                      "params": [10 if w["name"] == "Demo point" else 0, 0, 0, None, w["lat"], w["lon"], w["alt_m"]], "type": "SimpleItem"})
    items.append({"autoContinue": True, "command": 20, "doJumpId": len(items) + 1, "frame": 2, "params": [0, 0, 0, 0, 0, 0, 0], "type": "SimpleItem"})
    return {
        "fileType": "Plan", "groundStation": "QGroundControl", "version": 1,
        "geoFence": {"circles": [{"circle": {"center": [home["lat"], home["lon"]], "radius": plan["input"]["radius_m"]}, "inclusion": True, "version": 1}],
                     "polygons": [], "version": 2},
        "mission": {"cruiseSpeed": plan["profile"]["cruise_ms"], "firmwareType": 3, "hoverSpeed": 5, "items": items,
                    "plannedHomePosition": [home["lat"], home["lon"], home["amsl"] or 0], "vehicleType": 2, "version": 2},
        "rallyPoints": {"points": [], "version": 2},
    }


def mp_waypoints(plan):
    r = plan["route"]
    home = r["home"]
    rows = ["QGC WPL 110", f"0\t1\t0\t16\t0\t0\t0\t0\t{home['lat']:.7f}\t{home['lon']:.7f}\t{(home['amsl'] or 0):.2f}\t1"]
    rows.append(f"1\t0\t3\t22\t15\t0\t0\t0\t{home['lat']:.7f}\t{home['lon']:.7f}\t{r['waypoints'][0]['alt_m']:.2f}\t1")
    n = 2
    for w in r["waypoints"]:
        hold = 10 if w["name"] == "Demo point" else 0
        rows.append(f"{n}\t0\t3\t16\t{hold}\t0\t0\t0\t{w['lat']:.7f}\t{w['lon']:.7f}\t{w['alt_m']:.2f}\t1")
        n += 1
    rows.append(f"{n}\t0\t3\t20\t0\t0\t0\t0\t0\t0\t0\t1")
    return "\n".join(rows) + "\n"

