#!/usr/bin/env python3
"""Neosky Live Twin field relay. Runs on the ground-station laptop next to Mission Planner / QGroundControl.

It takes the drone's MAVLink telemetry (which the GCS forwards to it) and sends it to the Live Twin server over
a secure WebSocket, and pushes the camera's RTSP video to the server's video service. Both reconnect on their
own when the internet drops; telemetry received while offline is buffered (last 2 minutes) and sent on reconnect.
Nothing is ever sent back to the drone.

  python field_relay.py --server wss://twin.example.com --token <TWIN_INGEST_TOKEN> --msn 064 --model Tavas
                        [--mavlink udpin:0.0.0.0:14551] [--rtsp rtsp://192.168.144.25:8554/main.264 --video-pass <TWIN_VIDEO_PUBLISH_PASS>]

Mission Planner: press Ctrl+F > "Mavlink" > UDP Client, host 127.0.0.1, port 14551 (leave "Write access" off).
QGroundControl: Application Settings > MAVLink > "Enable MAVLink forwarding", host 127.0.0.1:14551.
Without a GCS you can read the telemetry radio directly: --mavlink COM5:57600 (Windows) or /dev/ttyUSB0:57600.
"""
import argparse
import asyncio
import os
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from urllib.parse import quote, urlencode, urlparse

try:
    import websockets
    from pymavlink import mavutil
except ImportError:
    sys.exit("Missing packages. Run:  pip install websockets pymavlink pyserial")

BACKLOG_S = 120


class Stats:
    def __init__(self):
        self.rx = 0
        self.tx = 0
        self.connected = False
        self.last_rx = 0.0
        self.video = "off"
        self.vehicles = set()


def mavlink_reader(url, loop, q, stats, stop):
    """Blocking reader thread: parse MAVLink from the GCS forward (or a radio) and queue the raw packets."""
    while not stop.is_set():
        try:
            dev, _, baud = url.rpartition(":")
            if not url.startswith(("udp", "tcp")) and dev and baud.isdigit():  # serial: COM5:57600, /dev/ttyUSB0:57600
                conn = mavutil.mavlink_connection(dev, baud=int(baud), robust_parsing=True)
            else:
                conn = mavutil.mavlink_connection(url, robust_parsing=True, source_system=254)
            print(f"[mavlink] listening on {url}")
            while not stop.is_set():
                m = conn.recv_msg()
                if m is None:
                    time.sleep(0.005)
                    continue
                if m.get_type() == "BAD_DATA":
                    continue
                sysid = m.get_srcSystem()
                if sysid in (0, 255):  # the GCS itself
                    continue
                buf = m.get_msgbuf()
                if not buf:
                    continue
                stats.rx += 1
                stats.last_rx = time.time()
                if m.get_type() == "HEARTBEAT":
                    stats.vehicles.add(sysid)
                loop.call_soon_threadsafe(q.put_nowait, (time.time(), bytes(buf)))
        except Exception as e:  # serial unplugged, port busy...
            print(f"[mavlink] {e}; retrying in 3 s")
            time.sleep(3)


async def sender(args, q, stats):
    params = {"token": args.token, "msn": args.msn}
    if args.model:
        params["model"] = args.model
    url = f"{args.server.rstrip('/')}/ws/ingest?{urlencode(params)}"
    backlog = deque()
    delay = 1
    while True:
        try:
            async with websockets.connect(url, max_size=None, ping_interval=20, ping_timeout=20, open_timeout=15) as ws:
                stats.connected = True
                delay = 1
                print(f"[server] connected to {args.server} as {args.msn}")
                while backlog:  # telemetry received while offline
                    _, b = backlog.popleft()
                    await ws.send(b)
                closed = asyncio.ensure_future(ws.wait_closed())
                while True:
                    getter = asyncio.ensure_future(q.get())
                    await asyncio.wait({getter, closed}, return_when=asyncio.FIRST_COMPLETED)
                    if not getter.done():
                        getter.cancel()
                        raise ConnectionError("server closed the connection")
                    ts, b = getter.result()
                    if closed.done():
                        backlog.append((ts, b))
                        raise ConnectionError("server closed the connection")
                    chunk = [b]
                    size = len(b)
                    while not q.empty() and size < 16000:  # batch small packets into one frame
                        _, b2 = q.get_nowait()
                        chunk.append(b2)
                        size += len(b2)
                    data = b"".join(chunk)
                    try:
                        await ws.send(data)
                        stats.tx += len(chunk)
                    except Exception:
                        backlog.append((ts, data))
                        raise
        except Exception as e:
            if stats.connected:
                print(f"[server] disconnected: {e}")
            elif delay == 1:
                print(f"[server] cannot connect: {e}")
            stats.connected = False
            if getattr(e, "code", None) == 4401 or "4401" in str(e):
                print("[server] the server rejected the token (TWIN_INGEST_TOKEN). Check --token.")
            # keep buffering while offline
            end = time.time() + delay
            while time.time() < end:
                try:
                    item = await asyncio.wait_for(q.get(), timeout=max(0.05, end - time.time()))
                    backlog.append(item)
                except asyncio.TimeoutError:
                    pass
                while backlog and time.time() - backlog[0][0] > BACKLOG_S:
                    backlog.popleft()
            delay = min(30, delay * 2)


def video_loop(args, stats, stop):
    """Pull the camera's RTSP and push it to MediaMTX on the server; restart whenever it stops."""
    ff = shutil.which(args.ffmpeg) or (args.ffmpeg if os.path.exists(args.ffmpeg) else None)
    if not ff:
        print("[video] ffmpeg not found: install it (Windows: winget install ffmpeg) or pass --ffmpeg C:\\path\\ffmpeg.exe")
        stats.video = "no ffmpeg"
        return
    host = urlparse(args.server).hostname
    dest = args.video_server or f"rtsp://{host}:8554"
    path = "".join(c if c.isalnum() or c in "-_" else "_" for c in args.msn)
    p = urlparse(dest)
    target = f"rtsp://relay:{quote(args.video_pass, safe='')}@{p.hostname}:{p.port or 8554}/{path}"
    shown = f"rtsp://relay:***@{p.hostname}:{p.port or 8554}/{path}"
    if args.transcode:
        codec = ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
                 "-vf", f"scale=-2:{args.height}", "-g", "30", "-b:v", args.bitrate, "-an"]
    else:
        codec = ["-c", "copy", "-an"]
    cmd = [ff, "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-timeout", "5000000", "-i", args.rtsp,
           *codec, "-f", "rtsp", "-rtsp_transport", "tcp", target]
    while not stop.is_set():
        print(f"[video] {args.rtsp} -> {shown}")
        stats.video = "streaming"
        t0 = time.time()
        proc = subprocess.Popen(cmd, stderr=subprocess.PIPE, text=True)
        err = proc.communicate()[1]
        stats.video = "reconnecting"
        msg = (err or "").strip().splitlines()[-1:] or ["stopped"]
        print(f"[video] {msg[0]}; restarting in 3 s")
        if "401" in (err or ""):
            print("[video] the server refused the video (wrong --video-pass, or the Live Twin app is restarting).")
        time.sleep(3 if time.time() - t0 > 10 else 6)


async def status(stats):
    while True:
        await asyncio.sleep(10)
        age = time.time() - stats.last_rx if stats.last_rx else None
        drone = f"{len(stats.vehicles)} vehicle(s), last packet {age:.0f} s ago" if age is not None else "no MAVLink yet (is the GCS forwarding?)"
        print(f"[status] server {'connected' if stats.connected else 'OFFLINE'} | {drone} | sent {stats.tx} packets | video {stats.video}")


async def main_async(args):
    loop = asyncio.get_running_loop()
    q = asyncio.Queue(maxsize=50000)
    stats = Stats()
    stop = threading.Event()
    threading.Thread(target=mavlink_reader, args=(args.mavlink, loop, q, stats, stop), daemon=True).start()
    if args.rtsp:
        threading.Thread(target=video_loop, args=(args, stats, stop), daemon=True).start()
    await asyncio.gather(sender(args, q, stats), status(stats))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", required=True, help="Live Twin address, e.g. wss://twin.example.com (ws:// on a LAN)")
    ap.add_argument("--token", required=True, help="TWIN_INGEST_TOKEN from the server's .env")
    ap.add_argument("--msn", required=True, help="drone serial number shown in the twin, e.g. 064")
    ap.add_argument("--model", default="", help="drone model, e.g. Tavas")
    ap.add_argument("--mavlink", default="udpin:0.0.0.0:14551", help="where MAVLink comes from (default: GCS forward to UDP 14551)")
    ap.add_argument("--rtsp", help="camera RTSP URL, e.g. rtsp://192.168.144.25:8554/main.264")
    ap.add_argument("--video-pass", default="", help="TWIN_VIDEO_PUBLISH_PASS from the server's .env")
    ap.add_argument("--video-server", help="override the video server, e.g. rtsp://twin.example.com:8554")
    ap.add_argument("--transcode", action="store_true", help="re-encode to H.264 (use when the camera sends H.265 or a high bitrate)")
    ap.add_argument("--height", default="720", help="output height when transcoding (default 720)")
    ap.add_argument("--bitrate", default="1500k", help="output bitrate when transcoding (default 1500k)")
    ap.add_argument("--ffmpeg", default="ffmpeg", help="path to ffmpeg if it is not on PATH")
    args = ap.parse_args()
    if args.rtsp and not args.video_pass:
        ap.error("--video-pass is required with --rtsp")
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("Relay stopped.")


if __name__ == "__main__":
    main()
