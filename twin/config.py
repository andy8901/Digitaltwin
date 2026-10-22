"""Settings, all from environment variables (see ../.env.example)."""
import os
import secrets
from pathlib import Path


def _env(name, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else default


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(_env("TWIN_DATA_DIR", str(BASE_DIR.parent / "data")))
DB_PATH = Path(_env("TWIN_DB_PATH", str(DATA_DIR / "twin.db")))
TLOG_DIR = Path(_env("TWIN_TLOG_DIR", str(DATA_DIR / "tlogs")))

SECRET_KEY = _env("TWIN_SECRET_KEY") or secrets.token_hex(32)

# "name:password;name2:password2". TWIN_PASSWORD alone creates the single user "admin".
_users = _env("TWIN_USERS", "")
USERS = {}
for part in _users.split(";"):
    if ":" in part:
        n, p = part.split(":", 1)
        USERS[n.strip()] = p.strip()
if not USERS:
    USERS["admin"] = _env("TWIN_PASSWORD", "admin")

# Shared secret every field relay must present (wss://.../ws/ingest?token=...).
INGEST_TOKEN = _env("TWIN_INGEST_TOKEN", "change-me")

# Optional raw MAVLink over UDP (a GCS forwarding straight to the server, e.g. on a LAN or VPN).
# 0 disables. Unauthenticated, so keep it off on a public server unless firewalled.
UDP_PORT = int(_env("TWIN_UDP_PORT", "0"))
# "1:064,2:101" -> name MAVLink system ids heard over UDP.
SYSID_MAP = {}
for part in _env("TWIN_SYSID_MAP", "").split(","):
    if ":" in part:
        a, b = part.split(":", 1)
        try:
            SYSID_MAP[int(a)] = b.strip()
        except ValueError:
            pass

# Seconds without a heartbeat before a drone is shown as stale / link lost / offline.
STALE_S = float(_env("TWIN_STALE_S", "3"))
OFFLINE_S = float(_env("TWIN_OFFLINE_S", "15"))
# An armed drone silent for this long has its flight closed as "link lost".
LOST_CLOSE_S = float(_env("TWIN_LOST_CLOSE_S", "900"))

# Video: MediaMTX. The app proxies WebRTC (WHEP) and HLS so browsers only talk to the app.
MEDIAMTX_WEBRTC = _env("TWIN_MEDIAMTX_WEBRTC", "http://127.0.0.1:8889").rstrip("/")
MEDIAMTX_HLS = _env("TWIN_MEDIAMTX_HLS", "http://127.0.0.1:8888").rstrip("/")
# Password field relays use to publish video (rtsp://relay:<this>@server:8554/<MSN>).
VIDEO_PUBLISH_PASS = _env("TWIN_VIDEO_PUBLISH_PASS", "change-me-too")
# Internal password the app uses when it reads from MediaMTX on a viewer's behalf.
VIDEO_READ_PASS = _env("TWIN_VIDEO_READ_PASS") or secrets.token_hex(16)

TIMEZONE = _env("TWIN_TZ", "Asia/Kolkata")

# Model names and photos shown for each MSN; "064:Tavas,101:Nimble".
MODEL_MAP = {}
for part in _env("TWIN_MODEL_MAP", "").split(","):
    if ":" in part:
        a, b = part.split(":", 1)
        MODEL_MAP[a.strip()] = b.strip()
