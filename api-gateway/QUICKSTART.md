# API Gateway — Quick Start

FastAPI REST server — the single interface for the mobile app.
Handles user auth, camera listing, live stream provisioning, and clip playback.

## Prerequisites

- Python 3.11+
- Redis 6+ (same instance as signaling server)
- Camera Discovery service must have run at least once (creates `cameras.db`)

## Install

```bash
cd api-gateway
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Configure

```bash
cp .env.example .env
```

**Required — must set before first run:**

```env
APP_SECRET=<random secret>              # openssl rand -hex 32
SIGNALING_JWT_SECRET=<same value as signaling-server JWT_SECRET>
DB_PATH=../camera_discovery/cameras.db  # path to shared SQLite
REDIS_URL=redis://localhost:6379
SIGNALING_URL=wss://your-host:8080/signal
NVR_DEVICE_ID=nvr-001                  # must match the ID registered in signaling server
```

**Optional:**

| Variable                  | Default        | Description                              |
|---------------------------|----------------|------------------------------------------|
| `PORT`                    | `8000`         | Listen port                              |
| `RECORDINGS_PATH`         | `/recordings`  | Root directory of recorded MP4 files     |
| `STREAM_SESSION_TTL`      | `7200`         | Stream session lifetime in seconds (2h)  |
| `APP_TOKEN_EXPIRY_HOURS`  | `24`           | User JWT lifetime                        |
| `DEFAULT_ADMIN_PASSWORD`  | `changeme`     | Password for the auto-created admin user |
| `LOG_LEVEL`               | `info`         | `debug` \| `info` \| `warning`           |

> **Important:** `SIGNALING_JWT_SECRET` must be identical to `JWT_SECRET` in the
> signaling server's `.env`. Both services use it to sign/verify viewer device tokens.

## First run — create admin user

On first startup, an `admin` account is created automatically using `DEFAULT_ADMIN_PASSWORD`.

```bash
DEFAULT_ADMIN_PASSWORD=mysecretpass python3 main.py
# [WARNING] Default admin created — password: 'mysecretpass' — CHANGE THIS IMMEDIATELY
```

## Run

```bash
# Development (auto-reload)
uvicorn main:app --reload --port 8000

# Production
python3 main.py
```

## Verify

```bash
# Health check (no auth)
curl http://localhost:8000/health
# { "message": "ok" }

# Login
curl -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"mysecretpass"}'
# { "access_token": "eyJ...", "token_type": "bearer", "expires_in": 86400 }

TOKEN="eyJ..."

# List cameras
curl http://localhost:8000/cameras \
  -H "Authorization: Bearer $TOKEN"

# Request a live stream for camera ID 1
curl -X POST http://localhost:8000/cameras/1/stream \
  -H "Authorization: Bearer $TOKEN"
# {
#   "session_id": "viewer-abc123",
#   "signaling_url": "wss://...",
#   "token": "eyJ...",         ← give this to the mobile WebSocket client
#   "nvr_device_id": "nvr-001",
#   "camera_id": "Entrance",
#   "expires_at": "..."
# }

# List recordings for camera 1 (last 24 hours)
curl "http://localhost:8000/cameras/1/clips?from=2026-05-01T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN"
```

## Interactive API docs

FastAPI generates live docs at:

```
http://localhost:8000/docs      ← Swagger UI (try endpoints in browser)
http://localhost:8000/redoc     ← ReDoc
```

## Create additional users

```bash
# Create a viewer account (requires admin JWT)
curl -X POST http://localhost:8000/auth/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"mobile-user","password":"pass1234","role":"viewer"}'
```

## As a systemd service

```ini
# /etc/systemd/system/nvr-api.service
[Unit]
Description=AuraSense API Gateway
After=network-online.target redis.service nvr-discovery.service
Wants=network-online.target

[Service]
User=nvr
WorkingDirectory=/opt/nvr/api-gateway
EnvironmentFile=/opt/nvr/api-gateway/.env
ExecStart=/opt/nvr/api-gateway/.venv/bin/python3 main.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nvr-api
sudo journalctl -u nvr-api -f
```
