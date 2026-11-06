#!/usr/bin/env python3
"""Build twin/data/airspace_india.json: India's airports (with runway ends) and land-border lines.

Sources (both public domain):
- OurAirports (ourairports.com/data): airports.csv, runways.csv
- Natural Earth 1:10m admin-0 boundary lines (naturalearthdata.com): international boundaries, LoC/LAC as drawn

    python tools/build_airspace_data.py            # downloads the files from GitHub mirrors
    python tools/build_airspace_data.py --dir DIR  # or uses airports.csv, runways.csv, borders.geojson in DIR

Re-run it now and then to pick up new airports.
"""
import argparse
import csv
import io
import json
import math
import urllib.request
from datetime import date
from pathlib import Path

URLS = {
    "airports.csv": "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv",
    "runways.csv": "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/runways.csv",
    "borders.geojson": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_boundary_lines_land.geojson",
}
OUT = Path(__file__).resolve().parent.parent / "twin" / "data" / "airspace_india.json"
KEEP_TYPES = {"large_airport", "medium_airport", "small_airport", "heliport", "seaplane_base"}


def read(name, folder):
    if folder:
        return (Path(folder) / name).read_text(encoding="utf-8")
    with urllib.request.urlopen(URLS[name], timeout=120) as r:
        return r.read().decode("utf-8")


def simplify(pts, tol):
    """Douglas-Peucker on lon/lat pairs (tolerance in degrees)."""
    if len(pts) < 3:
        return pts

    def perp(p, a, b):
        if a == b:
            return math.hypot(p[0] - a[0], p[1] - a[1])
        dx, dy = b[0] - a[0], b[1] - a[1]
        t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
        return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)

    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = 0, None
        for k in range(i + 1, j):
            d = perp(pts[k], pts[i], pts[j])
            if d > best:
                best, idx = d, k
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", help="folder with already-downloaded airports.csv, runways.csv, borders.geojson")
    a = ap.parse_args()

    airports = {}
    for r in csv.DictReader(io.StringIO(read("airports.csv", a.dir))):
        if r["iso_country"] != "IN" or r["type"] not in KEEP_TYPES:
            continue
        airports[r["id"]] = {
            "id": r["ident"], "name": r["name"], "type": r["type"], "city": r["municipality"],
            "iata": r["iata_code"] or None, "icao": r["icao_code"] or r["gps_code"] or None,
            "lat": round(float(r["latitude_deg"]), 6), "lon": round(float(r["longitude_deg"]), 6),
            "scheduled": r["scheduled_service"] == "yes", "runways": [],
        }
    for r in csv.DictReader(io.StringIO(read("runways.csv", a.dir))):
        ap_ = airports.get(r["airport_ref"])
        if not ap_ or r["closed"] == "1":
            continue
        try:
            le = (float(r["le_latitude_deg"]), float(r["le_longitude_deg"]))
            he = (float(r["he_latitude_deg"]), float(r["he_longitude_deg"]))
        except ValueError:
            le = he = None
        ap_["runways"].append({"len_ft": int(float(r["length_ft"] or 0)), "ends": [[round(le[0], 6), round(le[1], 6)], [round(he[0], 6), round(he[1], 6)]] if le else None})

    lines = []
    for f in json.loads(read("borders.geojson", a.dir))["features"]:
        p = f["properties"]
        if "IND" not in (p.get("ADM0_A3_L"), p.get("ADM0_A3_R")):
            continue
        geoms = f["geometry"]["coordinates"]
        if f["geometry"]["type"] == "LineString":
            geoms = [geoms]
        for g in geoms:
            pts = simplify([(round(x, 5), round(y, 5)) for x, y in g], 0.003)
            lines.append({"kind": p.get("FEATURECLA"), "between": [p.get("ADM0_LEFT"), p.get("ADM0_RIGHT")],
                          "coords": [[y, x] for x, y in pts]})  # stored lat, lon

    out = {
        "built": date.today().isoformat(),
        "sources": ["OurAirports (public domain)", "Natural Earth 1:10m admin-0 boundary lines (public domain)"],
        "airports": sorted(airports.values(), key=lambda x: x["id"]),
        "borders": lines,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"{len(out['airports'])} airports, {len(lines)} border lines -> {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
