"""Phase A test page + LiveKit token endpoint (aiohttp, no framework).

GET /                 -> web/index.html (the browser test page)
GET /token?key=...    -> { url, token, room }  (WEB_ACCESS_KEY protects it)
GET /healthz

Not a product: no users, no design. The key only keeps strangers from burning
STT/TTS minutes on your LiveKit project.
"""

from __future__ import annotations

import hmac
import logging
import os
import pathlib
import uuid

from aiohttp import web
from dotenv import load_dotenv
from livekit import api

load_dotenv()
logger = logging.getLogger("mainbot.rt.token")
WEB_DIR = pathlib.Path(__file__).parent / "web"


def _key_ok(request: web.Request) -> bool:
    expected = os.getenv("WEB_ACCESS_KEY", "")
    given = request.query.get("key", "") or request.headers.get("X-Access-Key", "")
    return len(expected) >= 8 and hmac.compare_digest(given, expected)


async def index(_: web.Request) -> web.Response:
    return web.FileResponse(WEB_DIR / "index.html")


async def healthz(_: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def token(request: web.Request) -> web.Response:
    if not _key_ok(request):
        return web.json_response({"error": "bad or missing key"}, status=401)
    url = os.getenv("LIVEKIT_URL", "")
    if not url or not os.getenv("LIVEKIT_API_KEY") or not os.getenv("LIVEKIT_API_SECRET"):
        return web.json_response({"error": "LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set"}, status=503)
    name = (request.query.get("name") or "בודק").strip()[:40]
    phone = (request.query.get("phone") or "").strip()[:20]
    room = f"mainbot-test-{uuid.uuid4().hex[:8]}"
    identity = f"web-{uuid.uuid4().hex[:8]}"
    jwt = (
        api.AccessToken()
        .with_identity(identity)
        .with_name(name)
        .with_attributes({"mainbot.phone": phone, "mainbot.channel": "web"})
        .with_grants(api.VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True, can_publish_data=True))
        .to_jwt()
    )
    logger.info("token issued", extra={"room": room, "identity": identity})
    return web.json_response({"url": url, "token": jwt, "room": room, "identity": identity})


def build_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/token", token)
    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    web.run_app(build_app(), host="0.0.0.0", port=int(os.getenv("WEB_PORT", "8080")))
