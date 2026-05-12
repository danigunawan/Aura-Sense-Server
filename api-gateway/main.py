"""
AuraSense NVR — REST API Gateway

Endpoints
─────────
POST  /auth/login                   Obtain a JWT (username + password)
POST  /auth/users                   Create a user [admin only]

GET   /cameras                      List all cameras (paginated)
GET   /cameras/{id}                 Camera detail

POST  /cameras/{id}/stream          Create a live-stream session → signaling credentials
DELETE /cameras/{id}/stream/{sid}   Revoke a stream session early

GET   /cameras/{id}/clips           Paginated recording list (filter by ?from= ?to=)
GET   /clips/{id}/download          Stream MP4 file (signed URL, no auth header needed)

GET   /cameras/{id}/status          Single camera health
GET   /status                       System-wide summary
GET   /health                       Liveness probe (no auth)
"""

import asyncio
import logging
import os
import signal
import subprocess
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from redis.asyncio import Redis

import auth
import database
from config import config
from models import CreateUserRequest, LoginRequest, MessageResponse, TokenResponse, UserResponse
from routes import cameras, clips, discovery, status as status_route, storage, streams

log = logging.getLogger("uvicorn.error")


# ── App lifecycle ─────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    await database.init()
    log.info("Database ready: %s", config.db_path)

    redis = Redis.from_url(config.redis_url, decode_responses=True)
    streams.set_redis(redis)
    discovery.set_redis(redis)
    log.info("Redis connected: %s", config.redis_url)

    await _ensure_default_admin()

    # Signal systemd that we're fully ready (Type=notify). No-op outside
    # systemd because systemd-notify exits 0 when NOTIFY_SOCKET is unset.
    if os.environ.get("NOTIFY_SOCKET"):
        subprocess.run(["systemd-notify", "--ready"], check=False)

    yield

    # Shutdown
    await database.close()
    await redis.aclose()
    log.info("Shutdown complete")


app = FastAPI(
    title       = "AuraSense NVR API",
    version     = "1.0.0",
    description = __doc__,
    lifespan    = lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins     = ["*"],   # tighten for production
    allow_credentials = True,
    allow_methods     = ["*"],
    allow_headers     = ["*"],
)


# ── Global error handler ──────────────────────────────────────────────────────

@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception):
    log.exception("Unhandled error on %s %s", request.method, request.url)
    return JSONResponse(
        status_code = status.HTTP_500_INTERNAL_SERVER_ERROR,
        content     = {"detail": "Internal server error"},
    )


# ── Auth routes ───────────────────────────────────────────────────────────────

@app.post("/auth/login", response_model=TokenResponse, tags=["auth"])
async def login(body: LoginRequest):
    db = database.get()

    async with db.execute(
        "SELECT username, hashed_password, role FROM users WHERE username = ?",
        (body.username,),
    ) as cur:
        row = await cur.fetchone()

    if not row or not auth.verify_password(body.password, row["hashed_password"]):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")

    token, expires_in = auth.issue_app_token(row["username"], row["role"])
    return TokenResponse(access_token=token, expires_in=expires_in)


# Hosts that are allowed to mint an unauthenticated kiosk viewer token.
# Restricted to the loopback interface so a remote caller (cloudflared / LAN)
# can never trade no credentials for a JWT — they still have to /auth/login.
_KIOSK_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}


@app.post("/auth/kiosk-token", response_model=TokenResponse, tags=["auth"])
async def kiosk_token(request: Request):
    """
    Issue a low-privilege "viewer" JWT to the kiosk browser running on this
    same box, so the live page can render without forcing a human login.
    The token role is "viewer" — admin routes still require a real login.
    """
    client_host = (request.client.host if request.client else "") or ""
    if client_host not in _KIOSK_LOCAL_HOSTS:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Kiosk token is loopback-only")

    token, expires_in = auth.issue_app_token("kiosk", "viewer")
    return TokenResponse(access_token=token, expires_in=expires_in)


@app.get("/auth/users", response_model=list[UserResponse], tags=["auth"])
async def list_users(request: Request):
    """List all users. Admin only."""
    creds = request.headers.get("Authorization", "")
    token = creds.removeprefix("Bearer ").strip()
    payload = auth.decode_app_token(token) if token else None
    if not payload or payload.get("role") != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")

    db = database.get()
    async with db.execute(
        "SELECT id, username, role, created_at FROM users ORDER BY id"
    ) as cur:
        rows = await cur.fetchall()

    return [
        UserResponse(
            id=r["id"], username=r["username"], role=r["role"],
            created_at=datetime.fromisoformat(r["created_at"]),
        )
        for r in rows
    ]


@app.delete("/auth/users/{username}", response_model=MessageResponse, tags=["auth"])
async def delete_user(username: str, request: Request):
    """Delete a user. Admin only. Cannot delete yourself."""
    creds = request.headers.get("Authorization", "")
    token = creds.removeprefix("Bearer ").strip()
    payload = auth.decode_app_token(token) if token else None
    if not payload or payload.get("role") != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")
    if payload.get("sub") == username:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Cannot delete your own account")

    db = database.get()
    async with db.execute("SELECT id FROM users WHERE username = ?", (username,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND, "User not found")

    await db.execute("DELETE FROM users WHERE username = ?", (username,))
    await db.commit()
    return MessageResponse(message=f"User '{username}' deleted")


@app.post(
    "/auth/users",
    response_model = MessageResponse,
    status_code    = status.HTTP_201_CREATED,
    tags           = ["auth"],
)
async def create_user(body: CreateUserRequest, request: Request):
    # Only admins can create users; allow unauthenticated creation of first admin
    db    = database.get()
    creds = request.headers.get("Authorization", "")

    async with db.execute("SELECT COUNT(*) FROM users") as cur:
        user_count = (await cur.fetchone())[0]

    if user_count > 0:
        # Require admin JWT for subsequent users
        token = creds.removeprefix("Bearer ").strip()
        payload = auth.decode_app_token(token) if token else None
        if not payload or payload.get("role") != "admin":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")

    try:
        await db.execute(
            "INSERT INTO users (username, hashed_password, role, created_at) VALUES (?,?,?,?)",
            (body.username, auth.hash_password(body.password), body.role,
             datetime.now(timezone.utc).isoformat()),
        )
        await db.commit()
    except Exception:
        raise HTTPException(status.HTTP_409_CONFLICT, "Username already exists")

    return MessageResponse(message=f"User '{body.username}' created")


# ── System control ───────────────────────────────────────────────────────────

_SERVICES = [
    "aurasense-kiosk",        # close browser first
    "aurasense-watchdog",
    "aurasense-parking-encoder",
    "aurasense-mediamtx",
    "aurasense-api",          # last — stops us
]


def _stop_all():
    """Run systemctl stop on all services. Executed in a background thread."""
    subprocess.run(["systemctl", "stop", *_SERVICES], check=False)


@app.post("/system/shutdown", response_model=MessageResponse, tags=["system"])
async def system_shutdown(request: Request):
    """Gracefully stop all AuraSense services. Admin only."""
    creds = request.headers.get("Authorization", "")
    token = creds.removeprefix("Bearer ").strip()
    payload = auth.decode_app_token(token) if token else None
    if not payload or payload.get("role") != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin access required")

    # Give the HTTP response 1 s to flush before we die.
    t = threading.Timer(1.0, _stop_all)
    t.daemon = True
    t.start()

    return MessageResponse(message="Shutdown initiated")


# ── Include routers ───────────────────────────────────────────────────────────

app.include_router(cameras.router)
app.include_router(streams.router)
app.include_router(clips.router)
app.include_router(status_route.router)
app.include_router(discovery.router)
app.include_router(storage.router)

# ── Dashboard static files ────────────────────────────────────────────────────
# Serve the built React dashboard from the same port as the API.
# Must be mounted last so API routes take priority over the catch-all.
_dist = os.path.join(os.path.dirname(__file__), "..", "dashboard", "dist")
if os.path.isdir(_dist):
    app.mount("/", StaticFiles(directory=_dist, html=True), name="dashboard")


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _ensure_default_admin():
    """Create a default admin on first run if no users exist."""
    import os
    db = database.get()
    async with db.execute("SELECT COUNT(*) FROM users") as cur:
        if (await cur.fetchone())[0] > 0:
            return

    default_pass = os.getenv("DEFAULT_ADMIN_PASSWORD", "changeme")
    await db.execute(
        "INSERT INTO users (username, hashed_password, role, created_at) VALUES (?,?,?,?)",
        ("admin", auth.hash_password(default_pass), "admin",
         datetime.now(timezone.utc).isoformat()),
    )
    await db.commit()
    log.warning(
        "Default admin created — password: '%s' — CHANGE THIS IMMEDIATELY", default_pass
    )


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host        = "0.0.0.0",
        port        = config.port,
        log_level   = config.log_level,
        access_log  = True,
    )
