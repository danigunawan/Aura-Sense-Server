#!/usr/bin/env bash
# Phase 07 — Cloudflare Tunnel setup
# Downloads cloudflared, creates a named tunnel, configures DNS routes,
# writes /etc/cloudflared/config.yml, installs systemd service.

set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DEPLOY_DIR/config.sh"

echo "[07-cloudflare] Setting up Cloudflare tunnel for domain: $CF_DOMAIN"

# ── Download cloudflared ───────────────────────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
    echo "[07-cloudflare] Downloading cloudflared..."
    ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
    # Map arch names
    case "$ARCH" in
        amd64|x86_64) ARCH=amd64 ;;
        arm64|aarch64) ARCH=arm64 ;;
        armhf|armv7l) ARCH=arm ;;
        *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    LATEST=$(curl -s https://api.github.com/repos/cloudflare/cloudflared/releases/latest \
        | grep -o '"tag_name": "[^"]*"' | cut -d'"' -f4)
    curl -L "https://github.com/cloudflare/cloudflared/releases/download/${LATEST}/cloudflared-linux-${ARCH}.deb" \
        -o /tmp/cloudflared.deb
    dpkg -i /tmp/cloudflared.deb
    rm /tmp/cloudflared.deb
fi
echo "[07-cloudflare] cloudflared version: $(cloudflared --version)"

# ── Authenticate with Cloudflare ──────────────────────────────────────────────
echo ""
echo "[07-cloudflare] Authenticating with Cloudflare..."
echo "  A URL will appear below. Open it on any device and log in."
echo "  The certificate will be saved here automatically."
echo ""
cloudflared tunnel login

# ── Create tunnel ─────────────────────────────────────────────────────────────
HOSTNAME=$(hostname)
MAC=$(cat /sys/class/net/"$INET_NIC"/address 2>/dev/null | tr ':' '-' || echo "nvr")
TUNNEL_NAME="aurasense-${HOSTNAME}-${MAC}"

echo "[07-cloudflare] Creating tunnel: $TUNNEL_NAME"
# Delete existing tunnel with same name if any (idempotent re-run)
cloudflared tunnel delete "$TUNNEL_NAME" 2>/dev/null || true
cloudflared tunnel create "$TUNNEL_NAME"

TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null \
    | awk -v name="$TUNNEL_NAME" '$2==name {print $1}')
if [[ -z "$TUNNEL_ID" ]]; then
    echo "ERROR: Could not find tunnel ID after creation."
    exit 1
fi
echo "[07-cloudflare] Tunnel ID: $TUNNEL_ID"

# ── DNS routes ────────────────────────────────────────────────────────────────
echo "[07-cloudflare] Creating DNS routes..."
cloudflared tunnel route dns "$TUNNEL_NAME" "api.$CF_DOMAIN"
cloudflared tunnel route dns "$TUNNEL_NAME" "stream.$CF_DOMAIN"
echo "  api.$CF_DOMAIN    → API gateway (port 8000)"
echo "  stream.$CF_DOMAIN → HLS streaming (port 8888)"

# ── Write config ──────────────────────────────────────────────────────────────
mkdir -p /etc/cloudflared
CREDS_FILE="$HOME/.cloudflared/${TUNNEL_ID}.json"

cat > /etc/cloudflared/config.yml << YAML
tunnel: $TUNNEL_ID
credentials-file: $CREDS_FILE

ingress:
  - hostname: api.$CF_DOMAIN
    service: http://localhost:8000
  - hostname: stream.$CF_DOMAIN
    service: http://localhost:8888
  - service: http_status:404
YAML
echo "[07-cloudflare] Config written to /etc/cloudflared/config.yml"

# ── Install and start systemd service ─────────────────────────────────────────
cloudflared service install
systemctl enable --now cloudflared

sleep 3
if systemctl is-active --quiet cloudflared; then
    echo ""
    echo "[07-cloudflare] Tunnel is live:"
    echo "  Dashboard: https://api.$CF_DOMAIN"
    echo "  Streams:   https://stream.$CF_DOMAIN"
else
    echo "WARNING: cloudflared service not active. Check: journalctl -u cloudflared"
fi

echo ""
echo "[07-cloudflare] Done."
