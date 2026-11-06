"""Fleet registry and the independent GCS connections that feed it.

Every drone has its own slot: TAVAS 01 is fed only by GCS 01, TAVAS 02 only by GCS 02, and so on. Each GCS is a
separate data source with its own adapter, its own connection state, its own reconnect loop and its own event
history, so one GCS dropping out never affects the others.

Telemetry adapters
- relay        the field relay on (or next to) the GCS pushes MAVLink over a WebSocket (wss://.../ws/ingest?gcs=GCS-01)
- udp_listen   the GCS (or a radio/VPN bridge) sends raw MAVLink to a UDP port reserved for that GCS
- tcp_client   the server connects to a MAVLink TCP server on the GCS (e.g. Mission Planner / MAVProxy / QGC TCP link)
- rest, custom placeholders for manufacturer protocols. They are NOT implemented: the protocol has to be verified
               with the GCS manufacturer first, so the slot shows "awaiting protocol verification".

Video adapters
- relay_push   the field relay pushes the camera stream to MediaMTX (rtsp://.../<path>)
- rtsp_pull    MediaMTX pulls the GCS's RTSP output directly (needs a route to the GCS, e.g. a VPN)
- none
Each drone can have a main stream (detail view) and an optional sub stream (low-bitrate, for the 15-feed wall).
"""
import asyncio
import re
import time
from collections import deque

from . import config

TELEMETRY_TYPES = {
    "relay": "Field relay (WebSocket)",
    "udp_listen": "MAVLink over UDP (server listens)",
    "tcp_client": "MAVLink over TCP (server connects)",
    "rest": "GCS REST API (protocol to be verified)",
    "custom": "Manufacturer protocol (to be verified)",
}
VIDEO_TYPES = {"relay_push": "Pushed by the field relay", "rtsp_pull": "Pulled from the GCS (RTSP)", "none": "No video"}
VERIFIED_TELEMETRY = {"relay", "udp_listen", "tcp_client"}


def key_for(slot):
    return f"TAVAS-{slot:02d}"


def default_slot(n):
    return {
        "slot": n, "key": key_for(n), "drone_id": f"TAVAS {n:02d}", "gcs_id": f"GCS {n:02d}", "msn": "", "model": "TAVAS",
        "telemetry": {"type": "relay", "port": 14600 + n, "host": "", "tcp_port": 5760},
        "video": {"type": "relay_push", "main_url": "", "sub_url": "", "record": False},
        "geofence": {"type": "circle", "radius_m": 1500, "max_alt_m": 120},
        "battery_cells": 6, "enabled": True, "notes": "",
    }


def video_path(slot_key, sub=False):
    return re.sub(r"[^a-z0-9_-]", "_", slot_key.lower()) + ("_sub" if sub else "")


class GcsLink:
    """Connection state of one GCS (one data source)."""

    def __init__(self, manager, slot):
        self.m = manager
        self.slot = slot
        self.state = "never"        # never | connected | stale | disconnected | error | awaiting_verification | disabled
        self.detail = ""
        self.since = None
        self.last_rx = 0.0
        self.rx_bytes = 0
        self.rx_msgs = 0
        self.rtt_ms = None
        self.peer = None
        self.sessions = 0
        self.disconnects = 0
        self.rate = deque(maxlen=30)  # (ts, bytes) per second
        self._task = None
        self._transport = None
        self._bucket = [int(time.time()), 0]

    @property
    def gcs_id(self):
        return self.slot["gcs_id"]

    @property
    def key(self):
        return self.slot["key"]

    @property
    def kind(self):
        return (self.slot.get("telemetry") or {}).get("type", "relay")

    def set_state(self, state, detail=""):
        if state == self.state and detail == self.detail:
            return
        prev = self.state
        self.state, self.detail = state, detail
        self.since = time.time()
        if state in ("connected", "disconnected", "error", "stale") and not (prev == "never" and state == "disconnected"):
            if state == "disconnected" and prev in ("connected", "stale"):
                self.disconnects += 1
            self.m.store.gcs_event(self.gcs_id, self.key, state, detail)
            self.m.on_state(self, prev, state)

    def data(self, n_bytes, n_msgs):
        now = time.time()
        self.last_rx = now
        self.rx_bytes += n_bytes
        self.rx_msgs += n_msgs
        sec = int(now)
        if sec != self._bucket[0]:
            self.rate.append(tuple(self._bucket))
            self._bucket = [sec, 0]
        self._bucket[1] += n_bytes
        if self.state != "connected" and self.kind != "relay":
            self.set_state("connected", self.peer or "")

    def kbps(self):
        now = int(time.time())
        recent = [b for t, b in self.rate if now - t <= 5]
        return round(sum(recent) * 8 / 1000 / max(1, len(recent)), 1) if recent else 0.0

    def info(self):
        now = time.time()
        return {
            "gcs_id": self.gcs_id, "key": self.key, "drone_id": self.slot["drone_id"], "adapter": self.kind,
            "adapter_label": TELEMETRY_TYPES.get(self.kind, self.kind), "state": self.state, "detail": self.detail,
            "since": self.since, "last_rx_s": round(now - self.last_rx, 1) if self.last_rx else None,
            "rx_msgs": self.rx_msgs, "kbps": self.kbps(), "rtt_ms": self.rtt_ms, "peer": self.peer,
            "disconnects": self.disconnects, "enabled": self.slot.get("enabled", True),
        }


class FleetManager:
    def __init__(self, store, hub):
        self.store = store
        self.hub = hub
        self.links = {}
        self.listeners = []   # callbacks(link, prev, state)
        self.slots = []
        self.load()

    # ---------------------------------------------------------------- registry
    def load(self):
        slots = self.store.fleet()
        if not slots:
            for n in range(1, config.FLEET_SIZE + 1):
                self.store.save_slot(default_slot(n))
            slots = self.store.fleet()
        self.slots = slots
        for s in slots:
            if s["key"] in self.links:
                self.links[s["key"]].slot = s
            else:
                self.links[s["key"]] = GcsLink(self, s)
            self.hub.register_slot(s)
        for k in list(self.links):
            if k not in {s["key"] for s in slots}:
                self.links.pop(k)

    def slot_by_gcs(self, gcs_id):
        g = (gcs_id or "").replace("-", " ").replace("_", " ").strip().upper()
        for s in self.slots:
            if s["gcs_id"].upper() == g or s["key"].upper() == g.replace(" ", "-"):
                return s
        return None

    def slot_by_msn(self, msn):
        for s in self.slots:
            if msn and (s.get("msn") == msn or s["drone_id"] == msn or s["key"] == msn):
                return s
        return None

    def update_slot(self, slot_no, data):
        cur = next((s for s in self.slots if s["slot"] == slot_no), None)
        if not cur:
            raise KeyError(slot_no)
        new = dict(cur)
        for k in ("drone_id", "gcs_id", "msn", "model", "notes", "battery_cells", "enabled"):
            if k in data:
                new[k] = data[k]
        for k in ("telemetry", "video", "geofence"):
            if isinstance(data.get(k), dict):
                new[k] = {**cur.get(k, {}), **data[k]}
        if new["telemetry"].get("type") not in TELEMETRY_TYPES:
            raise ValueError("unknown telemetry adapter")
        if new["video"].get("type") not in VIDEO_TYPES:
            raise ValueError("unknown video adapter")
        self.store.save_slot(new)
        self.load()
        return new

    def on_state(self, link, prev, state):
        for cb in self.listeners:
            try:
                cb(link, prev, state)
            except Exception:
                pass

    # ---------------------------------------------------------------- adapters
    async def start(self):
        for link in self.links.values():
            await self.start_link(link)

    async def restart_link(self, key):
        link = self.links.get(key)
        if link:
            await self.stop_link(link)
            d = self.hub.drones.get(key)
            if d is not None:
                d.sysid = None      # the new source's autopilot is bound on its first heartbeat
            link.rx_msgs = 0
            await self.start_link(link)

    async def stop_link(self, link):
        if link._task:
            link._task.cancel()
            link._task = None
        if link._transport:
            link._transport.close()
            link._transport = None

    async def start_link(self, link):
        t = link.slot.get("telemetry") or {}
        if not link.slot.get("enabled", True):
            link.set_state("disabled", "slot switched off in Settings")
            return
        kind = t.get("type", "relay")
        if kind not in VERIFIED_TELEMETRY:
            link.set_state("awaiting_verification",
                           "This adapter needs the GCS manufacturer's protocol specification before it can be built and tested.")
            return
        if kind == "relay":
            if link.state in ("awaiting_verification", "disabled", "error"):
                link.state, link.detail = "never", ""
            return
        if kind == "udp_listen":
            port = int(t.get("port") or 0)
            try:
                loop = asyncio.get_running_loop()
                link._transport, _ = await loop.create_datagram_endpoint(lambda: _Udp(self, link), local_addr=("0.0.0.0", port))
                link.state, link.detail = "never", f"listening on UDP {port}"
            except OSError as e:
                link.set_state("error", f"cannot listen on UDP {port}: {e}")
            return
        if kind == "tcp_client":
            link._task = asyncio.create_task(self._tcp_loop(link))

    async def _tcp_loop(self, link):
        t = link.slot["telemetry"]
        host, port = t.get("host"), int(t.get("tcp_port") or 5760)
        delay = 1
        while True:
            if not host:
                link.set_state("error", "no GCS address set")
                return
            source = f"tcp:{link.key}"
            try:
                reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=10)
                link.peer = f"{host}:{port}"
                link.set_state("connected", link.peer)
                delay = 1
                while True:
                    data = await asyncio.wait_for(reader.read(65536), timeout=config.OFFLINE_S)
                    if not data:
                        raise ConnectionError("GCS closed the connection")
                    n = self.hub.feed(source, data, slot=link.slot)
                    link.data(len(data), n)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                link.set_state("disconnected", f"{host}:{port}: {e}"[:200])
                self.hub.drop_source(source)
            await asyncio.sleep(delay)
            delay = min(30, delay * 2)

    def tick(self):
        """Mark sources that stopped sending."""
        now = time.time()
        for link in self.links.values():
            if link.state == "connected" and link.last_rx and now - link.last_rx > config.OFFLINE_S:
                link.set_state("stale" if link.kind == "relay" else "disconnected", f"no data for {int(now - link.last_rx)} s")
            elif link.state == "stale" and link.last_rx and now - link.last_rx < 2:
                link.set_state("connected", link.peer or "")

    def infos(self):
        return [self.links[s["key"]].info() for s in self.slots if s["key"] in self.links]


class _Udp(asyncio.DatagramProtocol):
    def __init__(self, manager, link):
        self.m, self.link = manager, link

    def datagram_received(self, data, addr):
        self.link.peer = f"{addr[0]}:{addr[1]}"
        n = self.m.hub.feed(f"udp:{self.link.key}", data, slot=self.link.slot)
        self.link.data(len(data), n)
