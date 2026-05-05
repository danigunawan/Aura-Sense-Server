"""
Live stream endpoint.

Flow:
  1. Verify user JWT (app-level auth).
  2. Check camera exists and is online.
  3. Create an ephemeral viewer device ID and secret.
  4. Write the device record to Redis (TTL = stream_session_ttl).
     The signaling server reads this record on WS upgrade to validate the device.
  5. Mint a signaling JWT directly using the shared SIGNALING_JWT_SECRET.
     No HTTP round-trip to the signaling server needed.
  6. Return everything the mobile app needs to open a WebRTC session.

Mobile app next steps after receiving StreamResponse:
  1. Open WebSocket to signaling_url with ?token=<token>
  2. Wait for { type: "connected" }
  3. Send { type: "request-stream", nvrId: nvr_device_id, cameraId: camera_id }
  4. Complete WebRTC offer/answer/ICE exchange as normal
"""

import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, status
from redis.asyncio import Redis

import auth
from config import config
from deps import DB, User
from models import MessageResponse, StreamResponse, StreamUrlsResponse

router = APIRouter(prefix="/cameras", tags=["streams"])

# Injected by main.py after Redis is initialised
_redis: Redis | None = None


def set_redis(r: Redis) -> None:
    global _redis
    _redis = r


@router.get("/{camera_id}/stream-urls", response_model=StreamUrlsResponse)
async def get_stream_urls(camera_id: int, db: DB, _user: User):
    """
    Return the mediamtx WebRTC, HLS, and internal RTSP URLs for a camera.
    No session is created — these are permanent relay URLs from the proxy.
    """
    async with db.execute(
        "SELECT id, name FROM cameras WHERE id = ?", (camera_id,)
    ) as cur:
        cam = await cur.fetchone()

    if not cam:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Camera not found")

    key = cam["name"].lower().replace(" ", "-")
    base_webrtc = config.mediamtx_url.rstrip("/")
    base_hls    = config.mediamtx_hls_url.rstrip("/")

    return StreamUrlsResponse(
        camera_id  = cam["id"],
        name       = cam["name"],
        webrtc_url = f"{base_webrtc}/{key}/whep",
        hls_url    = f"{base_hls}/{key}-sub",
        rtsp_url   = f"rtsp://localhost:8554/{key}",
        stream_key = key,
    )


@router.post("/{camera_id}/stream", response_model=StreamResponse, status_code=status.HTTP_201_CREATED)
async def request_stream(camera_id: int, db: DB, user: User):
    """
    Provision a short-lived WebRTC session for the requesting user.
    Returns signaling credentials — no media passes through this server.
    """
    # ── 1. Verify camera exists and is reachable ──
    async with db.execute(
        "SELECT id, name, status FROM cameras WHERE id = ?", (camera_id,)
    ) as cur:
        cam = await cur.fetchone()

    if not cam:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Camera not found")

    if cam["status"] != "online":
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            f"Camera '{cam['name']}' is currently {cam['status']}",
        )

    # ── 2. Create ephemeral viewer identity ──
    session_id  = f"viewer-{secrets.token_hex(12)}"
    device_secret = secrets.token_hex(32)
    ttl           = config.stream_session_ttl
    expires_at    = datetime.now(timezone.utc) + timedelta(seconds=ttl)

    # ── 3. Register in Redis so the signaling server accepts this viewer ──
    if _redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Redis unavailable")

    await _redis.hset(
        f"device:{session_id}",
        mapping={"secret": device_secret, "peerType": "viewer"},
    )
    await _redis.expire(f"device:{session_id}", ttl)

    # ── 4. Mint signaling JWT (same secret the signaling server uses) ──
    signaling_token = auth.issue_signaling_token(session_id, ttl)

    return StreamResponse(
        session_id    = session_id,
        signaling_url = config.signaling_url,
        token         = signaling_token,
        nvr_device_id = config.nvr_device_id,
        camera_id     = cam["name"],  # name is the stable cameraId in signaling protocol
        expires_at    = expires_at,
    )


@router.delete("/{camera_id}/stream/{session_id}", response_model=MessageResponse)
async def end_stream(camera_id: int, session_id: str, _user: User):
    """
    Revoke a stream session early.
    The mobile app should also send { type: 'leave', sessionId } on the WS.
    """
    if _redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Redis unavailable")

    if not session_id.startswith("viewer-"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid session ID")

    deleted = await _redis.delete(f"device:{session_id}")
    if not deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Session not found or already expired")

    return MessageResponse(message="Stream session revoked")
