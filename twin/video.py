"""Video streams of every drone, via MediaMTX's control API.

- Watches every path (ready or not, bitrate, viewers) so the app can show video connection health and raise
  "camera/video interruption" alerts.
- Sets up the paths each drone needs: pulled from the GCS (rtsp_pull) or published by the field relay
  (relay_push), each with an optional low-bitrate sub stream for the 15-feed wall, and recording on or off.
Each drone's streams are independent: one camera dropping out never affects the other feeds.
"""
import asyncio
import logging
import time

import httpx

from . import config
from .fleet import video_path

log = logging.getLogger("twin.video")


class VideoMonitor:
    def __init__(self, fleet):
        self.fleet = fleet
        self.paths = {}      # path name -> {ready, kbps, readers, bytes, ts}
        self.status = {}     # drone key -> summary for alerts / UI
        self.api_ok = None
        self.api_error = ""
        self.ever_ready = set()

    def _client(self):
        return httpx.AsyncClient(base_url=config.MEDIAMTX_API, timeout=5, auth=("twin", config.VIDEO_READ_PASS))

    async def configure(self):
        """Create / update the MediaMTX path of every drone to match its video settings."""
        try:
            async with self._client() as c:
                for s in self.fleet.slots:
                    v = s.get("video") or {}
                    kind = v.get("type", "none")
                    for sub in (False, True):
                        name = video_path(s["key"], sub)
                        url = v.get("sub_url" if sub else "main_url") or ""
                        if kind == "rtsp_pull" and url:
                            conf = {"source": url, "sourceOnDemand": False, "rtspTransport": "tcp", "record": bool(v.get("record")) and not sub}
                        elif kind == "relay_push":
                            conf = {"source": "publisher", "record": bool(v.get("record")) and not sub}
                        else:
                            await c.delete(f"/v3/config/paths/delete/{name}")
                            continue
                        r = await c.post(f"/v3/config/paths/add/{name}", json=conf)
                        if r.status_code >= 400:
                            await c.patch(f"/v3/config/paths/patch/{name}", json=conf)
            self.api_ok, self.api_error = True, ""
        except Exception as e:
            self.api_ok, self.api_error = False, str(e)[:200]

    async def poll(self):
        try:
            async with self._client() as c:
                r = await c.get("/v3/paths/list", params={"itemsPerPage": 500})
                r.raise_for_status()
                items = r.json().get("items", [])
            self.api_ok, self.api_error = True, ""
        except Exception as e:
            self.api_ok, self.api_error = False, str(e)[:200]
            items = None
        now = time.time()
        if items is not None:
            seen = {}
            for it in items:
                name = it.get("name")
                prev = self.paths.get(name)
                b = it.get("bytesReceived", 0) or 0
                kbps = None
                if prev and now > prev["ts"]:
                    kbps = round(max(0, b - prev["bytes"]) * 8 / 1000 / (now - prev["ts"]))
                seen[name] = {"ready": bool(it.get("ready")), "bytes": b, "ts": now, "kbps": kbps if kbps is not None else (prev or {}).get("kbps"),
                              "readers": len(it.get("readers") or []), "tracks": it.get("tracks") or [],
                              "source": (it.get("source") or {}).get("type")}
            self.paths = seen
        for s in self.fleet.slots:
            v = s.get("video") or {}
            main, sub = video_path(s["key"]), video_path(s["key"], True)
            pm, ps = self.paths.get(main, {}), self.paths.get(sub, {})
            if pm.get("ready"):
                self.ever_ready.add(s["key"])
            self.status[s["key"]] = {
                "configured": v.get("type", "none") != "none", "type": v.get("type", "none"), "path": main, "sub_path": sub if ps.get("ready") else None,
                "ready": bool(pm.get("ready")), "sub_ready": bool(ps.get("ready")), "kbps": pm.get("kbps"), "viewers": pm.get("readers", 0),
                "codec": ", ".join(pm.get("tracks", [])) or None, "recording": bool(v.get("record")), "was_ready": s["key"] in self.ever_ready,
                "api_ok": self.api_ok,
            }
        return self.status

    async def run(self):
        await self.configure()
        while True:
            try:
                await self.poll()
            except Exception:
                log.exception("video poll failed")
            await asyncio.sleep(2)
