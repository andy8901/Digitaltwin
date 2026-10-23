"""Small geodesy helpers (WGS84 sphere; accurate to well under 1 % over the tens of km the planner works with)."""
import math

R = 6371000.0


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(h)))


def bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def destination(lat, lon, brg_deg, dist_m):
    p1, l1 = math.radians(lat), math.radians(lon)
    b, d = math.radians(brg_deg), dist_m / R
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), (math.degrees(l2) + 540) % 360 - 180


class Local:
    """Flat x/y metres around an origin, for point-segment and polygon work."""

    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = math.cos(math.radians(lat0)) * math.pi * R / 180
        self.ky = math.pi * R / 180

    def xy(self, lat, lon):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)


def seg_dist(p, a, b):
    """Distance from point p to segment ab (x/y metres)."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    if dx == 0 and dy == 0:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def polyline_dist(lat, lon, coords):
    """Distance in metres from a point to a polyline of [lat, lon] pairs."""
    if not coords:
        return float("inf")
    loc = Local(lat, lon)
    pts = [loc.xy(a, b) for a, b in coords]
    if len(pts) == 1:
        return math.hypot(*pts[0])
    return min(seg_dist((0, 0), pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def point_in_poly(lat, lon, ring):
    """Ray casting on a ring of [lat, lon] pairs."""
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        yi, xi = ring[i]
        yj, xj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def poly_dist(lat, lon, ring):
    """0 inside the polygon, else distance in metres to its edge."""
    if len(ring) >= 3 and point_in_poly(lat, lon, ring):
        return 0.0
    closed = ring + [ring[0]] if ring and ring[0] != ring[-1] else ring
    return polyline_dist(lat, lon, closed)


def compass(deg):
    names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return names[int((deg % 360) / 22.5 + 0.5) % 16]


def circle(lat, lon, radius_m, n=72):
    return [list(destination(lat, lon, i * 360 / n, radius_m)) for i in range(n)]


def wedge(lat, lon, start_deg, end_deg, r0, r1, step=5):
    pts = [list(destination(lat, lon, a, r1)) for a in _arange(start_deg, end_deg, step)]
    pts += [list(destination(lat, lon, a, r0)) for a in reversed(_arange(start_deg, end_deg, step))]
    return pts


def _arange(a, b, step):
    out, x = [], a
    while x < b:
        out.append(x)
        x += step
    out.append(b)
    return out


def sun_position(lat, lon, when_utc):
    """Solar azimuth and elevation in degrees (NOAA approximation), when_utc: aware datetime in UTC."""
    doy = when_utc.timetuple().tm_yday
    hour = when_utc.hour + when_utc.minute / 60 + when_utc.second / 3600
    g = 2 * math.pi / 365 * (doy - 1 + (hour - 12) / 24)
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g) - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    decl = (0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g)
            - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g))
    tst = hour * 60 + eqt + 4 * lon
    ha = math.radians(tst / 4 - 180)
    phi = math.radians(lat)
    cos_zen = math.sin(phi) * math.sin(decl) + math.cos(phi) * math.cos(decl) * math.cos(ha)
    zen = math.acos(max(-1, min(1, cos_zen)))
    elev = 90 - math.degrees(zen)
    az = math.degrees(math.atan2(math.sin(ha), math.cos(ha) * math.sin(phi) - math.tan(decl) * math.cos(phi))) + 180
    return az % 360, elev
