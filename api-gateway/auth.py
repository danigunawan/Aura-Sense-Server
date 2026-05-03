"""
Two separate JWT concerns live here:

1. App JWT  — authenticates human users to the REST API.
              Secret: APP_SECRET.  Payload: { sub, role }.

2. Signaling JWT — authenticates ephemeral viewer devices to the WebSocket
                   signaling server.  Secret: SIGNALING_JWT_SECRET (must
                   match signaling-server JWT_SECRET).
                   Payload: { deviceId, peerType }.
"""

import hashlib
import hmac
import time
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from config import config


# ── Password helpers ──────────────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


# ── App JWT (user sessions) ───────────────────────────────────────────────────

def issue_app_token(username: str, role: str) -> tuple[str, int]:
    """Returns (token, expires_in_seconds)."""
    ttl = config.app_token_expiry_hours * 3600
    exp = datetime.now(timezone.utc) + timedelta(seconds=ttl)
    token = jwt.encode(
        {"sub": username, "role": role, "exp": exp},
        config.app_secret,
        algorithm="HS256",
    )
    return token, ttl


def decode_app_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, config.app_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


# ── Signaling JWT (ephemeral viewer device tokens) ────────────────────────────

def issue_signaling_token(device_id: str, ttl_seconds: int) -> str:
    """
    Mint a JWT that the signaling server will accept for a viewer WebSocket
    connection.  Uses the shared SIGNALING_JWT_SECRET.
    """
    exp = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
    return jwt.encode(
        {"deviceId": device_id, "peerType": "viewer", "exp": exp},
        config.signaling_jwt_secret,
        algorithm="HS256",
    )


# ── Clip download URL signing ─────────────────────────────────────────────────

def sign_clip_url(clip_id: int, ttl_seconds: int = 3600) -> tuple[str, int]:
    """Returns (hex_sig, unix_expiry)."""
    exp = int(time.time()) + ttl_seconds
    msg = f"{clip_id}:{exp}".encode()
    sig = hmac.new(config.app_secret.encode(), msg, hashlib.sha256).hexdigest()
    return sig, exp


def verify_clip_sig(clip_id: int, sig: str, exp: int) -> bool:
    if int(time.time()) > exp:
        return False
    msg = f"{clip_id}:{exp}".encode()
    expected = hmac.new(config.app_secret.encode(), msg, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)
