"""Video: MediaMTX publish/read permission checks and the WebRTC (WHEP) / HLS proxy for logged-in viewers."""
import hmac

import httpx
from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import config
from .state import user

router = APIRouter()


# ---------------------------------------------------------------- video (MediaMTX)
@router.post("/internal/mtx-auth")
async def mtx_auth(body: dict = Body(...)):
    """MediaMTX asks us whether a publish/read is allowed (authMethod: http)."""
    action, pw, name = body.get("action"), body.get("password") or "", body.get("user") or ""
    is_twin = name == "twin" and hmac.compare_digest(pw, config.VIDEO_READ_PASS)
    if action == "publish":
        ok = hmac.compare_digest(pw, config.VIDEO_PUBLISH_PASS)
    elif action in ("read", "playback"):
        ok = is_twin
    else:  # api, metrics, pprof: only this app (it configures paths and reads stream status)
        ok = is_twin or body.get("ip") in ("127.0.0.1", "::1")
    return Response(status_code=200 if ok else 401)


_HOP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding", "cookie", "authorization", "accept-encoding"}


async def _proxy(request, base, rest, rewrite_prefix):
    url = f"{base}/{rest}"
    if request.url.query:
        url += "?" + request.url.query
    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP}
    body = await request.body()
    client = httpx.AsyncClient(timeout=15, auth=("twin", config.VIDEO_READ_PASS))
    try:
        req = client.build_request(request.method, url, headers=headers, content=body)
        r = await client.send(req, stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        return JSONResponse({"error": f"video server unreachable: {e}"}, status_code=502)
    out_headers = {k: v for k, v in r.headers.items() if k.lower() not in _HOP | {"content-encoding", "www-authenticate"}}
    loc = r.headers.get("location")
    if loc and loc.startswith("/"):
        out_headers["location"] = rewrite_prefix + loc

    async def body_iter():
        try:
            async for chunk in r.aiter_raw():
                yield chunk
        finally:
            await r.aclose()
            await client.aclose()

    return StreamingResponse(body_iter(), status_code=r.status_code, headers=out_headers)


@router.api_route("/video/webrtc/{rest:path}", methods=["POST", "PATCH", "DELETE", "OPTIONS"])
async def video_webrtc(rest: str, request: Request):
    user(request)
    return await _proxy(request, config.MEDIAMTX_WEBRTC, rest, "/video/webrtc")


@router.get("/video/hls/{rest:path}")
async def video_hls(rest: str, request: Request):
    user(request)
    return await _proxy(request, config.MEDIAMTX_HLS, rest, "/video/hls")
