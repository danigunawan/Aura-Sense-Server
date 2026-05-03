# AuraSense NVR — Complete Quick Start

End-to-end setup guide for all services. Follow in order.

## System overview

```
IP Cameras (RTSP)
      │
      ▼
Camera Discovery ──► cameras.db (SQLite)
                           │
                           ▼
                      API Gateway  ◄──── Mobile App
                           │                 │
                           ▼                 ▼
                   Signaling Server ◄── WebSocket (WebRTC)
                           │
                      Redis (shared)
```

### Services

| Service            | Language   | Port   | Purpose                              |
|--------------------|------------|--------|--------------------------------------|
| Camera Discovery   | Python     | —      | ONVIF scan → SQLite                  |
| Signaling Server   | Node.js    | 8080   | WebRTC offer/answer/ICE relay        |
| API Gateway        | Python     | 8000   | REST API for mobile app              |

---

## Step 1 — System prerequisites

```bash
# Ubuntu 22.04+ / 24.04

# Python 3.11+
sudo apt install python3 python3-venv python3-pip python-is-python3

# Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs

# Redis
sudo apt install redis-server
sudo systemctl enable --now redis-server
redis-cli ping    # should return PONG
```

---

## Step 2 — Generate shared secrets

Both the Signaling Server and API Gateway must share the same `SIGNALING_JWT_SECRET`.
Run whichever command is available on your system:

```bash
# Option A — Python (recommended, always available)
python3 -c "
import secrets
print('APP_SECRET=' + secrets.token_hex(32))
print('SIGNALING_JWT_SECRET=' + secrets.token_hex(32))
"

# Option B — Node.js
node -e "
const c = require('crypto');
console.log('APP_SECRET=' + c.randomBytes(32).toString('hex'));
console.log('SIGNALING_JWT_SECRET=' + c.randomBytes(32).toString('hex'));
"

# Option C — openssl (if installed)
echo "APP_SECRET=$(openssl rand -hex 32)"
echo "SIGNALING_JWT_SECRET=$(openssl rand -hex 32)"
```

Copy the two lines of output — you will paste them into the `.env` files below.
The `SIGNALING_JWT_SECRET` value must be **identical** in both files.

---

## Step 3 — Camera Discovery Service

```bash
cd camera_discovery
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Run a single scan to populate the database
python3 main.py --once

# Verify cameras were found
python3 main.py --list
```

The database file `cameras.db` is created in the current directory.
Note its absolute path — the API Gateway needs it.

```bash
realpath cameras.db    # e.g. /home/aura/Documents/aurasense/camera_discovery/cameras.db
```

See `camera_discovery/QUICKSTART.md` for continuous-mode and systemd setup.

---

## Step 4 — Signaling Server

```bash
cd ../signaling-server
cp .env.example .env
```

Edit `.env`:

```env
JWT_SECRET=<SIGNALING_JWT_SECRET from Step 2>
REDIS_URL=redis://localhost:6379
PORT=8080
NODE_ENV=production
```

```bash
npm install

# Register the NVR device identity (run once)
node scripts/register-device.js nvr-001 nvr
# Save the printed secret — you need it for the NVR's WebSocket client
{
  "deviceId": "nvr-001",
  "secret": "715af681f091e1cdfdfa29feeb6dd83da13a917388f62a72af14f186730e4fd8",
  "peerType": "nvr"
}


# Start the server
npm start &

# Verify
curl http://localhost:8080/health
# { "status": "ok", "peers": 0, "uptime": ... }
```

See `signaling-server/QUICKSTART.md` for Docker and systemd setup.

---

## Step 5 — API Gateway

```bash
cd ../api-gateway
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
```

Edit `.env`:

```env
APP_SECRET=<APP_SECRET from Step 2>
SIGNALING_JWT_SECRET=<SIGNALING_JWT_SECRET from Step 2>   # ← MUST match signaling server
DB_PATH=/home/aura/Documents/aurasense/camera_discovery/cameras.db
REDIS_URL=redis://localhost:6379
SIGNALING_URL=wss://localhost:8080/signal
NVR_DEVICE_ID=nvr-001
RECORDINGS_PATH=/recordings
DEFAULT_ADMIN_PASSWORD=changeme123
PORT=8000
```

```bash
python3 main.py &
 If issue in running check 0.0.0. is free
 
  kill $(lsof -ti :8000) 2>/dev/null; echo "cleared"                                                                               
                                                                                                                                   
  Or use --reload with uvicorn during development — it handles restarts without leaving orphan processes:                          
                                                                                                                                   
  .venv/bin/uvicorn main:app --reload --port 8000 

# Verify
curl http://localhost:8000/health
# { "message": "ok" }
```

See `api-gateway/QUICKSTART.md` for full endpoint reference and systemd setup.

---

## Step 6 — End-to-end smoke test

```bash
# 1. Login
TOKEN=$(curl -s -X POST http://localhost:8000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"aura4211"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

echo "Token: $TOKEN"

# 2. List cameras
curl -s http://localhost:8000/cameras \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 3. Check system status
curl -s http://localhost:8000/status \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 4. Request a live stream for camera 1
curl -s -X POST http://localhost:8000/cameras/1/stream \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
# Returns signaling_url, token, nvr_device_id, camera_id
# → pass these to the mobile WebRTC client
```

---

## Service startup order

Always start services in this order:

```
1. Redis          (sudo systemctl start redis)
2. Camera Discovery  (python3 main.py)
3. Signaling Server  (npm start)
4. API Gateway       (python3 main.py)
```

Discovery must run before the API Gateway since it creates `cameras.db`.

---

## Environment variable summary

### Camera Discovery (`camera_discovery/.env`)

| Variable             | Required | Default      |
|----------------------|----------|--------------|
| `DB_PATH`            | no       | `cameras.db` |
| `DISCOVERY_INTERVAL` | no       | `60`         |
| `DISCOVERY_TIMEOUT`  | no       | `5.0`        |
| `ONVIF_TIMEOUT`      | no       | `10`         |
| `LOG_LEVEL`          | no       | `info`       |

### Signaling Server (`signaling-server/.env`)

| Variable      | Required | Default               |
|---------------|----------|-----------------------|
| `JWT_SECRET`  | **yes**  | —                     |
| `REDIS_URL`   | **yes**  | `redis://localhost:6379` |
| `PORT`        | no       | `8080`                |
| `JWT_EXPIRY`  | no       | `24h`                 |
| `LOG_LEVEL`   | no       | `info`                |

### API Gateway (`api-gateway/.env`)

| Variable                 | Required | Default                |
|--------------------------|----------|------------------------|
| `APP_SECRET`             | **yes**  | —                      |
| `SIGNALING_JWT_SECRET`   | **yes**  | — *(= signaling JWT_SECRET)* |
| `DB_PATH`                | **yes**  | —                      |
| `REDIS_URL`              | **yes**  | `redis://localhost:6379` |
| `SIGNALING_URL`          | **yes**  | —                      |
| `NVR_DEVICE_ID`          | **yes**  | —                      |
| `RECORDINGS_PATH`        | no       | `/recordings`          |
| `STREAM_SESSION_TTL`     | no       | `7200`                 |
| `DEFAULT_ADMIN_PASSWORD` | no       | `changeme`             |
| `PORT`                   | no       | `8000`                 |

---

## Useful commands

```bash
# Watch discovery logs
journalctl -u nvr-discovery -f

# Check how many cameras are in the database
sqlite3 camera_discovery/cameras.db "SELECT name, ip_address, status FROM cameras;"

# Check Redis for active stream sessions
redis-cli KEYS "device:viewer-*"

# Signaling server peer count
curl http://localhost:8080/health

# API docs (Swagger UI)
open http://localhost:8000/docs
```
