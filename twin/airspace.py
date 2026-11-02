"""DGCA airspace zones (red / yellow / green) around a point, for demo-site planning.

This is an ESTIMATE built from the published rules of the Drone Airspace Map (Drone Rules 2021) and public data.
The DigitalSky airspace map (digitalsky.dgca.gov.in) is the only authority: always confirm there before flying.

Rules applied (see the README for sources):
- Operational airport (large/medium, or any with scheduled service), distance from the airport perimeter:
    0-5 km   red (treated as no-fly; ATC permission at minimum)
    5-8 km   yellow at any height (ATC permission)
    8-12 km  green up to 200 ft (60 m) AGL, yellow above
    >12 km   green up to 400 ft (120 m) AGL, yellow above
  The perimeter is approximated as 500 m around the runways (or 1 km around the airport point without runway data),
  which errs on the safe side.
- Airstrips without scheduled service: yellow within 5 km (confirm their status on DigitalSky).
- Heliports: yellow within 2 km (confirm on DigitalSky).
- International border, LoC and LAC: red within 25 km; 25-35 km is yellow (verify) because the public border lines
  used here (Natural Earth 1:10m) can be a few km off.
- Vijay Chowk, New Delhi: red within 5 km.
- Military areas, nuclear plants and government seats found in OpenStreetMap: red inside; yellow (verify) nearby.
- Restricted areas you import or draw (e.g. copied from DigitalSky): as you set them.
"""
import json
import re
import time
import uuid
from functools import lru_cache

from . import config
from .geo import Local, circle, destination, haversine, poly_dist, polyline_dist, seg_dist

DATA = config.BASE_DIR / "data" / "airspace_india.json"
ZONES_FILE = config.DATA_DIR / "zones.json"

GREEN_MAX_M = 120   # 400 ft
GREEN_8_12_M = 60   # 200 ft
ORDER = {"green": 0, "yellow": 1, "red": 2}

FIXED_SITES = [
    {"name": "Vijay Chowk, New Delhi", "lat": 28.6143, "lon": 77.1994, "red_km": 5.0},
]


@lru_cache(maxsize=1)
def reference():
    return json.loads(DATA.read_text(encoding="utf-8"))


MILITARY_AERODROME = re.compile(r"air force|air base|\bAFS\b|naval air|\bINS\b|army aviation|\bIAF\b", re.I)


def airport_class(a):
    if a["type"] in ("large_airport", "medium_airport") or a.get("scheduled"):
        return "airport"
    if a["type"] == "small_airport" and MILITARY_AERODROME.search(a["name"]):
        return "airport"  # military aerodromes are operational: full airport rules
    if a["type"] == "small_airport":
        return "airstrip"
    return "heliport"


def perimeter_dist_m(lat, lon, a):
    """Approximate distance from a point to an airport's perimeter (0 inside)."""
    rws = [r["ends"] for r in a.get("runways", []) if r.get("ends")]
    if rws:
        loc = Local(lat, lon)
        d = min(seg_dist((0, 0), loc.xy(*e[0]), loc.xy(*e[1])) for e in rws)
        return max(0.0, d - 500)
    return max(0.0, haversine(lat, lon, a["lat"], a["lon"]) - (1000 if airport_class(a) == "airport" else 300))


def nearby_airports(lat, lon, within_km=40):
    out = []
    for a in reference()["airports"]:
        d = haversine(lat, lon, a["lat"], a["lon"])
        if d <= within_km * 1000:
            out.append((d, a))
    out.sort(key=lambda x: x[0])
    return [a for _, a in out]


def nearby_borders(lat, lon, within_km=80):
    out = []
    for ln in reference()["borders"]:
        d = polyline_dist(lat, lon, ln["coords"])
        if d <= within_km * 1000:
            out.append((d, ln))
    return out


def _iso_ring(a, clat, clon, dist_m, guess_m, n=96):
    """The line where the distance to the airport perimeter equals dist_m (exact shape around the runways)."""
    out = []
    for i in range(n):
        brg = i * 360 / n
        lo, hi = 0.0, guess_m + 3000
        for _ in range(22):
            mid = (lo + hi) / 2
            p = destination(clat, clon, brg, mid)
            if perimeter_dist_m(p[0], p[1], a) < dist_m:
                lo = mid
            else:
                hi = mid
        out.append(list(destination(clat, clon, brg, (lo + hi) / 2)))
    return out


# ---------------------------------------------------------------- custom zones (imported / drawn)
def load_zones():
    try:
        return json.loads(ZONES_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def save_zones(zones):
    ZONES_FILE.parent.mkdir(parents=True, exist_ok=True)
    ZONES_FILE.write_text(json.dumps(zones, indent=1), encoding="utf-8")


def add_zone(name, color, ring=None, center=None, radius_m=None, max_agl_m=None, note=""):
    if color not in ORDER:
        raise ValueError("colour must be red, yellow or green")
    if not ring and not (center and radius_m):
        raise ValueError("a zone needs a polygon or a centre and radius")
    z = {"id": uuid.uuid4().hex[:10], "name": name[:120] or "Restricted area", "color": color, "note": note[:300],
         "ring": ring, "center": center, "radius_m": radius_m, "max_agl_m": max_agl_m, "added": time.time()}
    zones = load_zones()
    zones.append(z)
    save_zones(zones)
    return z


def delete_zone(zid):
    zones = load_zones()
    keep = [z for z in zones if z["id"] != zid]
    save_zones(keep)
    return len(keep) != len(zones)


def zones_from_geojson(gj, default_color="red"):
    """Polygons from a GeoJSON FeatureCollection/Feature/Geometry. Colour from properties.color/zone if present."""
    feats = gj.get("features") if gj.get("type") == "FeatureCollection" else [gj if gj.get("type") == "Feature" else {"type": "Feature", "geometry": gj, "properties": {}}]
    out = []
    for f in feats or []:
        g = f.get("geometry") or {}
        p = f.get("properties") or {}
        color = str(p.get("color") or p.get("zone") or p.get("colour") or default_color).lower()
        color = next((c for c in ORDER if c in color), default_color)
        name = p.get("name") or p.get("Name") or p.get("title") or "Imported area"
        polys = []
        if g.get("type") == "Polygon":
            polys = [g["coordinates"][0]]
        elif g.get("type") == "MultiPolygon":
            polys = [pg[0] for pg in g["coordinates"]]
        elif g.get("type") == "Point" and p.get("radius_m"):
            out.append({"name": name, "color": color, "center": [g["coordinates"][1], g["coordinates"][0]], "radius_m": float(p["radius_m"])})
            continue
        for ring in polys:
            out.append({"name": name, "color": color, "ring": [[c[1], c[0]] for c in ring]})
    return out


def zones_from_kml(text, default_color="red"):
    """Polygons from KML (as exported by Google Earth / many airspace tools)."""
    import re
    out = []
    for pm in re.findall(r"<Placemark\b.*?</Placemark>", text, re.S | re.I):
        name = re.search(r"<name>(.*?)</name>", pm, re.S | re.I)
        name = re.sub(r"<!\[CDATA\[|\]\]>", "", name.group(1)).strip() if name else "Imported area"
        low = pm.lower()
        color = "yellow" if "yellow" in low else "green" if "green" in low else "red" if "red" in low else default_color
        for coords in re.findall(r"<outerBoundaryIs>.*?<coordinates>(.*?)</coordinates>", pm, re.S | re.I):
            ring = []
            for tok in coords.split():
                parts = tok.split(",")
                if len(parts) >= 2:
                    ring.append([float(parts[1]), float(parts[0])])
            if len(ring) >= 3:
                out.append({"name": name, "color": color, "ring": ring})
    return out


# ---------------------------------------------------------------- classification
class Airspace:
    """Zone lookup around one site. `osm_areas` are sensitive areas found in OpenStreetMap near the site."""

    def __init__(self, lat, lon, osm_areas=None):
        self.lat, self.lon = lat, lon
        self.airports = nearby_airports(lat, lon, 30)
        self.borders = nearby_borders(lat, lon, 60)
        self.custom = [z for z in load_zones() if self._near(z)]
        self.osm = osm_areas or []

    def _near(self, z):
        if z.get("center"):
            return haversine(self.lat, self.lon, *z["center"]) < (z["radius_m"] or 0) + 30000
        return any(haversine(self.lat, self.lon, a, b) < 30000 for a, b in z.get("ring") or [])

    def classify(self, lat, lon):
        """(zone, max height AGL in m that stays green, [reasons])"""
        zone, max_agl, why = "green", GREEN_MAX_M, []

        def hit(z, text, agl=None, kind="rule"):
            nonlocal zone, max_agl
            if ORDER[z] > ORDER[zone]:
                zone = z
            if z == "green" and agl is not None:
                max_agl = min(max_agl, agl)
            elif z != "green":
                max_agl = 0
            why.append({"zone": z, "text": text, "kind": kind})

        for a in self.airports:
            d = perimeter_dist_m(lat, lon, a)
            cls = airport_class(a)
            label = f"{a['name']}" + (f" ({a['iata']})" if a.get("iata") else "")
            if cls == "airport":
                if d < 5000:
                    hit("red", f"{d / 1000:.1f} km from the perimeter of {label}: airport vicinity (0-5 km)", kind="airport")
                elif d < 8000:
                    hit("yellow", f"{d / 1000:.1f} km from {label}: 5-8 km band, ATC permission needed at any height", agl=0, kind="airport")
                elif d < 12000:
                    hit("green", f"{d / 1000:.1f} km from {label}: 8-12 km band, green only up to 200 ft (60 m)", agl=GREEN_8_12_M, kind="airport")
            elif cls == "airstrip" and d < 5000:
                hit("yellow", f"{d / 1000:.1f} km from airstrip {label}: confirm on DigitalSky whether it is active", agl=GREEN_8_12_M, kind="airport")
            elif cls == "heliport" and d < 2000:
                hit("yellow", f"{d / 1000:.1f} km from heliport {label}: confirm on DigitalSky", agl=GREEN_8_12_M, kind="airport")

        for d0, ln in self.borders:
            d = polyline_dist(lat, lon, ln["coords"]) if d0 < 40000 else d0
            names = " / ".join(x for x in ln["between"] if x)
            if d < 25000:
                hit("red", f"{d / 1000:.1f} km from the {names} border line (25 km red belt)", kind="border")
                break
            if d < 35000:
                # the public border lines can be several km off: treat the edge of the belt as "verify"
                hit("yellow", f"{d / 1000:.1f} km from the {names} border line: just outside the 25 km red belt, "
                    "but the line used here is approximate; confirm on DigitalSky", agl=0, kind="border")
                break

        for s in FIXED_SITES:
            d = haversine(lat, lon, s["lat"], s["lon"])
            if d < s["red_km"] * 1000:
                hit("red", f"{d / 1000:.1f} km from {s['name']} ({s['red_km']:g} km no-drone zone)", kind="fixed")

        for o in self.osm:
            d = poly_dist(lat, lon, o["ring"]) if o.get("ring") else haversine(lat, lon, o["lat"], o["lon"])
            if d == 0:
                hit("red", f"inside {o['label']}", kind="osm")
            elif d < o["buffer_m"]:
                hit("yellow", f"{d / 1000:.1f} km from {o['label']}: treat as restricted until confirmed on DigitalSky", agl=0, kind="osm")

        for z in self.custom:
            inside = (haversine(lat, lon, *z["center"]) <= z["radius_m"]) if z.get("center") else poly_dist(lat, lon, z["ring"]) == 0
            if inside:
                hit(z["color"], f"inside '{z['name']}' (your restricted areas)", agl=z.get("max_agl_m"), kind="custom")
        return zone, max_agl, why

    # ------------------------------------------------------------ map overlay
    def overlay(self):
        """Shapes for the map: airport rings, border lines, sensitive areas, custom zones."""
        shapes = []
        for a in self.airports[:12]:
            cls = airport_class(a)
            rws = [r["ends"] for r in a.get("runways", []) if r.get("ends")]
            if rws:
                pts = [p for e in rws for p in e]
                clat = sum(p[0] for p in pts) / len(pts)
                clon = sum(p[1] for p in pts) / len(pts)
                half = max(haversine(clat, clon, p[0], p[1]) for p in pts) + 500
            else:
                clat, clon, half = a["lat"], a["lon"], 1000 if cls == "airport" else 300
            if cls == "airport":
                for r_km, color in ((12, "green"), (8, "yellow"), (5, "red")):
                    shapes.append({"type": "ring", "color": color, "name": f"{a['name']}: {r_km} km from the perimeter",
                                   "coords": _iso_ring(a, clat, clon, r_km * 1000, half + r_km * 1000)})
            else:
                r_km = 5 if cls == "airstrip" else 2
                shapes.append({"type": "ring", "color": "yellow", "name": f"{a['name']} ({'airstrip' if cls == 'airstrip' else 'heliport'}): {r_km} km",
                               "coords": _iso_ring(a, clat, clon, r_km * 1000, half + r_km * 1000, 48)})
            shapes.append({"type": "airport", "name": a["name"], "iata": a.get("iata"), "class": cls, "lat": a["lat"], "lon": a["lon"]})
        for _, ln in self.borders:
            shapes.append({"type": "border", "color": "red", "name": " / ".join(x for x in ln["between"] if x) + " border (25 km red belt)", "coords": ln["coords"]})
        for s in FIXED_SITES:
            if haversine(self.lat, self.lon, s["lat"], s["lon"]) < 40000:
                shapes.append({"type": "ring", "color": "red", "name": s["name"], "coords": circle(s["lat"], s["lon"], s["red_km"] * 1000)})
        for o in self.osm:
            if o.get("ring"):
                shapes.append({"type": "area", "color": "red", "name": o["label"], "coords": o["ring"]})
        for z in self.custom:
            coords = z["ring"] if z.get("ring") else circle(z["center"][0], z["center"][1], z["radius_m"])
            shapes.append({"type": "custom", "color": z["color"], "name": z["name"], "coords": coords, "id": z["id"]})
        return shapes
