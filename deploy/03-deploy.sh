#!/usr/bin/env bash
# Phase 03 — Clone repo, build venvs, configure .env, install systemd services.

set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DEPLOY_DIR/config.sh"

PROJECT_DIR="/home/aura/Documents/aurasense"

# ── Clone or update repo ──────────────────────────────────────────────────────
echo "[03-deploy] Setting up project..."
mkdir -p /home/aura/Documents
if [[ -d "$PROJECT_DIR/.git" ]]; then
    echo "[03-deploy] Repo already exists — pulling latest..."
    sudo -u aura git -C "$PROJECT_DIR" pull
else
    sudo -u aura git clone "$REPO_URL" "$PROJECT_DIR"
fi

cd "$PROJECT_DIR"
chmod +x mediamtx 2>/dev/null || true

# ── Python venv — camera_discovery ────────────────────────────────────────────
echo "[03-deploy] Building camera_discovery venv (Python 3.11)..."
cd "$PROJECT_DIR/camera_discovery"
sudo -u aura python3.11 -m venv .venv
sudo -u aura .venv/bin/pip install --upgrade pip wheel -q
sudo -u aura .venv/bin/pip install -r requirements.txt -q

# ── Python venv — api-gateway ─────────────────────────────────────────────────
echo "[03-deploy] Building api-gateway venv (Python 3.11)..."
cd "$PROJECT_DIR/api-gateway"
sudo -u aura python3.11 -m venv .venv
sudo -u aura .venv/bin/pip install --upgrade pip wheel -q
sudo -u aura .venv/bin/pip install -r requirements.txt -q

# ── Node.js — recording-service ───────────────────────────────────────────────
echo "[03-deploy] Installing recording-service Node.js deps..."
cd "$PROJECT_DIR/recording-service"
sudo -u aura npm install --silent

# ── Node.js — dashboard ───────────────────────────────────────────────────────
echo "[03-deploy] Installing dashboard deps + building production bundle..."
cd "$PROJECT_DIR/dashboard"
sudo -u aura npm install --silent
sudo -u aura npm run build

# ── Configure .env ────────────────────────────────────────────────────────────
echo "[03-deploy] Writing .env..."
cd "$PROJECT_DIR"
if [[ ! -f .env ]]; then
    cp .env.template .env
fi
chmod 600 .env

# Inject values from config
sed -i "s|^CAMERA_ONVIF_USER=.*|CAMERA_ONVIF_USER=admin|"          .env
sed -i "s|^CAMERA_ONVIF_PASS=.*|CAMERA_ONVIF_PASS=$CAMERA_ONVIF_PASS|" .env
sed -i "s|^CAMERA_RTSP_USER=.*|CAMERA_RTSP_USER=admin|"            .env
sed -i "s|^CAMERA_RTSP_PASS=.*|CAMERA_RTSP_PASS=$CAMERA_ONVIF_PASS|"  .env
sed -i "s|^API_SECRET_KEY=.*|API_SECRET_KEY=$API_SECRET_KEY|"      .env

# Add DISCOVERY_INTERFACE if not present (forces WS-Discovery out camera NIC)
grep -q "^DISCOVERY_INTERFACE=" .env \
    && sed -i "s|^DISCOVERY_INTERFACE=.*|DISCOVERY_INTERFACE=$CAMERA_NIC_IP|" .env \
    || echo "DISCOVERY_INTERFACE=$CAMERA_NIC_IP" >> .env

chown aura:aura .env

# ── Install systemd services ──────────────────────────────────────────────────
echo "[03-deploy] Installing systemd services..."
cd "$PROJECT_DIR/systemd"
bash install.sh

echo ""
echo "[03-deploy] Done."
