"""PDF flight / fleet reports and CSV exports."""
import csv
import io
import time
from datetime import datetime

from reportlab.graphics.shapes import Circle, Drawing, PolyLine, Rect, String
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from . import config
from .stats import TZ

INK = colors.HexColor("#14202b")
MUTED = colors.HexColor("#5b6b78")
CYAN = colors.HexColor("#1aa6c8")
RED = colors.HexColor("#c62828")
AMBER = colors.HexColor("#b7791f")
LOGO = config.BASE_DIR / "static" / "neosky-logo-on-light.png"


def _t(ts, fmt="%d %b %Y %H:%M:%S"):
    if not ts:
        return "—"
    return datetime.fromtimestamp(ts, TZ).strftime(fmt) if TZ else datetime.fromtimestamp(ts).strftime(fmt)


def _dur(s):
    if s is None:
        return "—"
    s = int(round(s))
    return f"{s // 3600}:{(s % 3600) // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def _f(v, d=0, unit=""):
    return "—" if v is None else f"{v:.{d}f}{unit}"


def _styles():
    ss = getSampleStyleSheet()
    return {
        "h1": ParagraphStyle("h1", parent=ss["Heading1"], fontName="Helvetica-Bold", fontSize=17, textColor=INK, spaceAfter=2),
        "h2": ParagraphStyle("h2", parent=ss["Heading2"], fontName="Helvetica-Bold", fontSize=12, textColor=INK, spaceBefore=10, spaceAfter=4),
        "p": ParagraphStyle("p", parent=ss["BodyText"], fontName="Helvetica", fontSize=9.5, leading=13, textColor=INK),
        "small": ParagraphStyle("small", parent=ss["BodyText"], fontName="Helvetica", fontSize=8, leading=10, textColor=MUTED),
    }


def _table(rows, widths, head=True, zebra=True):
    t = Table(rows, colWidths=widths, repeatRows=1 if head else 0)
    style = [("FONT", (0, 0), (-1, -1), "Helvetica", 8.5), ("TEXTCOLOR", (0, 0), (-1, -1), INK),
             ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.3, colors.HexColor("#d6dde3")),
             ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]
    if head:
        style += [("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8.5), ("TEXTCOLOR", (0, 0), (-1, 0), MUTED)]
    t.setStyle(TableStyle(style))
    return t


def _header(story, st, title, sub):
    if LOGO.exists():
        story.append(Image(str(LOGO), width=42 * mm, height=42 * mm * 0.2, hAlign="LEFT"))
        story.append(Spacer(1, 4))
    story.append(Paragraph(title, st["h1"]))
    story.append(Paragraph(sub, st["small"]))
    story.append(Spacer(1, 6))


def _track_drawing(track, events, w=170 * mm, h=70 * mm):
    d = Drawing(w, h)
    d.add(Rect(0, 0, w, h, strokeColor=colors.HexColor("#d6dde3"), fillColor=colors.HexColor("#f6f8fa")))
    if len(track) < 2:
        d.add(String(8, h / 2, "No track recorded", fontName="Helvetica", fontSize=9, fillColor=MUTED))
        return d
    lats = [p[1] for p in track]
    lons = [p[2] for p in track]
    import math
    k = math.cos(math.radians(sum(lats) / len(lats)))
    xs = [x * k for x in lons]
    x0, x1, y0, y1 = min(xs), max(xs), min(lats), max(lats)
    span = max(x1 - x0, y1 - y0, 1e-5)
    pad = 8
    sc = min((w - 2 * pad) / span, (h - 2 * pad) / span)
    ox = pad + ((w - 2 * pad) - (x1 - x0) * sc) / 2
    oy = pad + ((h - 2 * pad) - (y1 - y0) * sc) / 2

    def P(lat, lon):
        return ox + (lon * k - x0) * sc, oy + (lat - y0) * sc

    pts = []
    for p in track[:: max(1, len(track) // 800)]:
        pts += list(P(p[1], p[2]))
    d.add(PolyLine(pts, strokeColor=CYAN, strokeWidth=1.6))
    sx, sy = P(track[0][1], track[0][2])
    ex, ey = P(track[-1][1], track[-1][2])
    d.add(Circle(sx, sy, 3.2, fillColor=colors.HexColor("#2e9e5b"), strokeColor=colors.white))
    d.add(Circle(ex, ey, 3.2, fillColor=INK, strokeColor=colors.white))
    for e in events:
        if e.get("lat") is not None:
            x, y = P(e["lat"], e["lon"])
            d.add(Circle(x, y, 3.5, fillColor=RED if e["type"] in ("crash", "thrust_loss", "motor_issue") else AMBER, strokeColor=colors.white))
    d.add(String(w - 70, 6, f"{(x1 - x0) * 111:.2f} × {(y1 - y0) * 111:.2f} km", fontName="Helvetica", fontSize=7, fillColor=MUTED))
    return d


EVENT_NAMES = {"crash": "Crash", "thrust_loss": "Potential thrust loss", "motor_issue": "Motor issue", "battery_fs": "Battery failsafe",
               "gcs_fs": "GCS failsafe", "rc_fs": "RC failsafe", "ekf_issue": "EKF issue", "gps_issue": "GPS issue",
               "vibration_issue": "High vibration"}


def flight_pdf(flight, track, alerts, messages):
    s = flight["summary"]
    st = _styles()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=14 * mm, bottomMargin=14 * mm,
                            title=f"Flight report {flight['id']}")
    story = []
    did = s.get("drone_id") or flight.get("msn")
    _header(story, st, f"Flight report · {did}", f"TAVAS Digital Twin Command Centre · flight {flight['id']} · "
            f"{s.get('gcs_id') or 'GCS —'} · generated {_t(time.time())}")
    events = s.get("events") or []
    emergency = [e for e in events if e["type"] in ("crash", "thrust_loss", "motor_issue", "battery_fs", "gcs_fs", "rc_fs")]
    mission = s.get("mission") or {}
    mstatus = ("completed" if mission.get("completed") else "not completed" if mission.get("flown_auto") else "manual / no mission")
    used = None
    if s.get("batt_start_pct") is not None and s.get("batt_end_pct") is not None:
        used = s["batt_start_pct"] - s["batt_end_pct"]
    rows = [
        ["Flight date", _t(flight["start_ts"], "%d %b %Y"), "Status", (flight.get("status") or "").replace("_", " ")],
        ["Armed", _t(flight["start_ts"], "%H:%M:%S"), "Disarmed", _t(flight.get("end_ts"), "%H:%M:%S")],
        ["Take-off", _t(s.get("takeoff_ts"), "%H:%M:%S"), "Landing", _t(s.get("landing_ts"), "%H:%M:%S")],
        ["Flight duration", _dur((s.get("flight_time_min") or 0) * 60), "Distance flown", _f(s.get("distance_m"), 0, " m")],
        ["Max altitude", _f(s.get("max_alt_m"), 1, " m"), "Max speed", _f(s.get("max_speed_ms"), 1, " m/s")],
        ["Battery used", (f"{used:.0f} % ({s.get('batt_start_pct')} → {s.get('batt_end_pct')} %)" if used is not None else "—")
         + (f", {s['mah_used']:.0f} mAh" if s.get("mah_used") else ""), "Voltage", f"{_f(s.get('max_voltage'), 2)} → {_f(s.get('min_voltage'), 2)} V"],
        ["Max range from home", _f(s.get("range_m"), 0, " m"), "Mission", mstatus],
        ["Satellites (min)", _f(s.get("min_sats")), "HDOP (max)", _f(s.get("max_hdop"), 2)],
    ]
    t = Table(rows, colWidths=[34 * mm, 51 * mm, 34 * mm, 55 * mm])
    t.setStyle(TableStyle([("FONT", (0, 0), (-1, -1), "Helvetica", 9), ("FONT", (0, 0), (0, -1), "Helvetica-Bold", 9),
                           ("FONT", (2, 0), (2, -1), "Helvetica-Bold", 9), ("TEXTCOLOR", (0, 0), (-1, -1), INK),
                           ("LINEBELOW", (0, 0), (-1, -1), 0.3, colors.HexColor("#d6dde3")), ("TOPPADDING", (0, 0), (-1, -1), 3)]))
    story.append(t)
    story.append(Paragraph("Flight trajectory", st["h2"]))
    story.append(_track_drawing(track, events))
    story.append(Paragraph("Green dot: take-off · dark dot: end · red/amber: events", st["small"]))
    story.append(Paragraph(f"Emergency events ({len(emergency)})", st["h2"]))
    if emergency:
        story.append(_table([["Time", "Event", "Detail", "From home", "Alt"]] + [
            [_dur(e.get("t")), EVENT_NAMES.get(e["type"], e["type"]), Paragraph(e.get("text", ""), st["p"]), _f(e.get("dist_m"), 0, " m"), _f(e.get("alt_m"), 1, " m")]
            for e in emergency], [16 * mm, 32 * mm, 82 * mm, 22 * mm, 20 * mm]))
    else:
        story.append(Paragraph("None.", st["p"]))
    story.append(Paragraph(f"Alerts during the flight ({len(alerts)})", st["h2"]))
    if alerts:
        story.append(_table([["Time", "Severity", "Alert", "Message", "Source"]] + [
            [_t(a["ts"], "%H:%M:%S"), a["severity"], a.get("label") or a["rule"], Paragraph(a["message"], st["p"]), a["source"]] for a in alerts[:80]],
            [18 * mm, 18 * mm, 36 * mm, 76 * mm, 24 * mm]))
    else:
        story.append(Paragraph("None.", st["p"]))
    errs = [m for m in messages if m["sev"] <= 4]
    story.append(Paragraph(f"Error and warning messages from the flight controller ({len(errs)})", st["h2"]))
    if errs:
        sev = ["EMERGENCY", "ALERT", "CRITICAL", "ERROR", "WARNING"]
        story.append(_table([["Time", "Severity", "Message (verbatim)"]] + [[_t(m["ts"], "%H:%M:%S"), sev[m["sev"]], Paragraph(m["text"], st["p"])] for m in errs[:120]],
                            [18 * mm, 22 * mm, 134 * mm]))
    else:
        story.append(Paragraph("None.", st["p"]))
    story.append(Spacer(1, 8))
    story.append(Paragraph("Figures are recorded live by the Digital Twin from the drone's telemetry. Alerts state their source: the flight "
                           "controller's own messages (quoted word for word) or a threshold rule set in Settings.", st["small"]))
    doc.build(story)
    return buf.getvalue()


def fleet_pdf(period_label, rows, totals, alert_counts):
    st = _styles()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm, topMargin=14 * mm, bottomMargin=14 * mm,
                            title="Fleet report")
    story = []
    _header(story, st, f"Fleet report · {period_label}", f"TAVAS Digital Twin Command Centre · generated {_t(time.time())}")
    story.append(_table([["Completed flights", "Flight hours", "Distance", "Critical alerts", "Warnings", "Crashes"],
                         [str(totals["flights"]), f"{totals['hours']:.1f} h", f"{totals['km']:.1f} km", str(alert_counts.get("critical", 0)),
                          str(alert_counts.get("warning", 0)), str(totals["crashes"])]], [30 * mm] * 6))
    story.append(Paragraph("By drone", st["h2"]))
    story.append(_table([["Drone", "GCS", "Flights", "Hours", "Distance", "Max alt", "Battery used", "Critical", "Warnings", "Failsafes"]] + [
        [r["drone_id"], r["gcs_id"] or "—", r["flights"], f"{r['hours']:.2f}", f"{r['km']:.1f} km", _f(r["max_alt"], 0, " m"),
         _f(r["avg_batt_used"], 0, " %/flt"), r["critical"], r["warning"], r["failsafes"]] for r in rows],
        [20 * mm, 16 * mm, 14 * mm, 14 * mm, 20 * mm, 16 * mm, 22 * mm, 16 * mm, 18 * mm, 18 * mm]))
    doc.build(story)
    return buf.getvalue()


def to_csv(rows, cols):
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(cols)
    for r in rows:
        w.writerow(["" if r.get(c) is None else r.get(c) for c in cols])
    return out.getvalue()
