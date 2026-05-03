# Signaling Server — Quick Start

WebSocket server that brokers WebRTC session negotiation between the NVR and mobile viewers.
Handles ICE candidate exchange and device authentication via JWT + Redis.

## Prerequisites

- Node.js 20+
- Redis 6+ (running and reachable)

## Install

```bash
cd signaling-server
npm install
```

## Configure

```bash
cp .env.example .env
```

**Required — must set before first run:**

```env
JWT_SECRET=<random 256-bit secret>    # openssl rand -hex 32
REDIS_URL=redis://localhost:6379
```

**Optional:**

| Variable     | Default          | Description                          |
|--------------|------------------|--------------------------------------|
| `PORT`       | `8080`           | HTTP + WebSocket listen port         |
| `JWT_EXPIRY` | `24h`            | Device token lifetime                |
| `LOG_LEVEL`  | `info`           | `trace` \| `debug` \| `info`        |
| `NODE_ENV`   | *(unset)*        | Set to `production` to disable pretty logs |

## Register the NVR device

Each physical device (NVR box, mobile app) needs a pre-registered identity in Redis.
Run this once per device — it generates a random secret and stores it.

```bash
# Register the NVR (run once during setup)
node scripts/register-device.js nvr-001 nvr
# Output:
# {
#   "deviceId": "nvr-001",
#   "secret": "a3f9...",
#   "peerType": "nvr"
# }
# Save this secret — it goes into the NVR's config
```

Mobile viewer devices are registered automatically by the API Gateway when a stream is requested.
You do not need to register viewer devices manually.

## Run

```bash
# Development (auto-restart on file change)
npm run dev

# Production
npm start
```

## Verify

```bash
# Health check
curl http://localhost:8080/health
# { "status": "ok", "peers": 0, "uptime": 12 }

# Authenticate the NVR device
curl -X POST http://localhost:8080/auth \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"nvr-001","secret":"<secret from register step>"}'
# { "token": "eyJ..." }
```

## Run integration tests

Requires Redis on localhost:6379.

```bash
node --test test/signaling.test.js
```

## WebSocket message reference

Connect: `ws://host:8080/signal`  with header `Authorization: Bearer <token>`

```jsonc
// Viewer → request a stream
{ "type": "request-stream", "nvrId": "nvr-001", "cameraId": "Entrance" }

// NVR → send SDP offer
{ "type": "offer", "sessionId": "...", "sdp": "v=0\r\n..." }

// Viewer → send SDP answer
{ "type": "answer", "sessionId": "...", "sdp": "v=0\r\n..." }

// Both directions — ICE candidates
{ "type": "ice-candidate", "sessionId": "...", "candidate": { ... } }

// Either side → end session
{ "type": "leave", "sessionId": "..." }
```

## As a systemd service

```ini
# /etc/systemd/system/nvr-signaling.service
[Unit]
Description=AuraSense Signaling Server
After=network-online.target redis.service
Wants=network-online.target

[Service]
User=nvr
WorkingDirectory=/opt/nvr/signaling-server
EnvironmentFile=/opt/nvr/signaling-server/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nvr-signaling
sudo journalctl -u nvr-signaling -f
```

## Docker

```bash
docker build -t nvr-signaling .
docker run -d \
  --name nvr-signaling \
  -p 8080:8080 \
  -e JWT_SECRET=<secret> \
  -e REDIS_URL=redis://redis:6379 \
  nvr-signaling
```
