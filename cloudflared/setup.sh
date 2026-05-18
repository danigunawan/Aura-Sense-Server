#!/usr/bin/env bash
# AuraSense NVR — Cloudflare Tunnel first-run setup
# Run once per device: sudo ./setup.sh <your-domain.com>
# Example: sudo ./setup.sh aurasense.app

set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
    echo "Usage: sudo $0 <your-domain.com>"
    exit 1
fi

# ── Device ID from internet NIC MAC (no colons) ─────────────────────────────
# enp3s0 is the internet/management NIC; enp2s0 is the isolated camera NIC.
MAC=$(cat /sys/class/net/enp3s0/address 2>/dev/null | tr -d ':')
if [[ -z "$MAC" ]]; then
    echo "ERROR: could not read MAC from enp3s0"
    exit 1
fi
DEVICE_ID="$MAC"
TUNNEL_NAME="aurasense-$DEVICE_ID"
API_HOSTNAME="api-$DEVICE_ID.$DOMAIN"
STREAM_HOSTNAME="stream-$DEVICE_ID.$DOMAIN"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../api-gateway/.env"

echo "Device ID  : $DEVICE_ID"
echo "Tunnel     : $TUNNEL_NAME"
echo "API URL    : https://$API_HOSTNAME"
echo "Stream URL : https://$STREAM_HOSTNAME"
echo ""

# ── 1. Install cloudflared ──────────────────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
    echo "[1/7] Installing cloudflared..."
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64)  CF_ARCH="amd64" ;;
        aarch64) CF_ARCH="arm64" ;;
        armv7l)  CF_ARCH="arm"   ;;
        *)       echo "Unsupported arch: $ARCH"; exit 1 ;;
    esac
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CF_ARCH" \
        -o /usr/local/bin/cloudflared
    chmod +x /usr/local/bin/cloudflared
    echo "    cloudflared installed."
else
    echo "[1/7] cloudflared already installed."
fi

# ── 2. Find cert.pem (skip login if already authenticated) ─────────────────
echo "[2/7] Checking Cloudflare authentication..."
CERT_PATH=""
for d in "/root/.cloudflared" "$HOME/.cloudflared" "/home/aura/.cloudflared" "/etc/cloudflared"; do
    if [[ -f "$d/cert.pem" ]]; then
        CERT_PATH="$d/cert.pem"
        break
    fi
done

if [[ -n "$CERT_PATH" ]]; then
    echo "    Certificate found at $CERT_PATH — skipping login."
else
    echo "    No certificate found. Opening browser to authenticate..."
    cloudflared tunnel login
    for d in "/root/.cloudflared" "$HOME/.cloudflared" "/home/aura/.cloudflared" "/etc/cloudflared"; do
        if [[ -f "$d/cert.pem" ]]; then
            CERT_PATH="$d/cert.pem"
            break
        fi
    done
fi

if [[ -z "$CERT_PATH" ]]; then
    echo "ERROR: cert.pem not found after login. Authentication may have failed."
    exit 1
fi
export TUNNEL_ORIGIN_CERT="$CERT_PATH"
CRED_DIR="$(dirname "$CERT_PATH")"
echo "    Using cert: $CERT_PATH"

# ── 3. Create tunnel ────────────────────────────────────────────────────────
echo "[3/7] Creating tunnel '$TUNNEL_NAME'..."
TUNNEL_ID=""

if cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
    echo "    Tunnel already exists."
else
    cloudflared tunnel create "$TUNNEL_NAME" 2>&1 | tee /tmp/cf_create.log || true
    TUNNEL_ID=$(grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' /tmp/cf_create.log | head -1)
fi

# Resolve ID from credentials file if not captured from create output
if [[ -z "$TUNNEL_ID" ]]; then
    TUNNEL_ID=$(ls "$CRED_DIR"/*.json 2>/dev/null \
        | xargs -I{} basename {} .json \
        | grep -E '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' \
        | head -1)
fi

# Last resort: parse tunnel list output
if [[ -z "$TUNNEL_ID" ]]; then
    TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null \
        | grep "$TUNNEL_NAME" \
        | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' \
        | head -1)
fi

if [[ -z "$TUNNEL_ID" ]]; then
    echo "ERROR: could not determine tunnel ID. Check: cloudflared tunnel list"
    exit 1
fi
echo "    Tunnel ID: $TUNNEL_ID"

# ── 4. DNS routes ───────────────────────────────────────────────────────────
echo "[4/7] Creating DNS routes..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$API_HOSTNAME"    2>&1 || echo "    (api DNS may already exist)"
cloudflared tunnel route dns "$TUNNEL_NAME" "$STREAM_HOSTNAME" 2>&1 || echo "    (stream DNS may already exist)"

# ── 5. Write /etc/cloudflared/config.yml ────────────────────────────────────
echo "[5/7] Writing /etc/cloudflared/config.yml..."
mkdir -p /etc/cloudflared

# Credentials file: cloudflared writes it next to cert.pem
CRED_FILE="$CRED_DIR/$TUNNEL_ID.json"
if [[ ! -f "$CRED_FILE" ]]; then
    # Also check /etc/cloudflared
    CRED_FILE="/etc/cloudflared/$TUNNEL_ID.json"
fi

cat > /etc/cloudflared/config.yml << EOF
tunnel: $TUNNEL_ID
credentials-file: $CRED_FILE

# Reconnect aggressively to minimise stream interruptions
retries: 5
grace-period: 30s

ingress:
  - hostname: $API_HOSTNAME
    service: http://localhost:8000
    originRequest:
      connectTimeout: 10s
      tcpKeepAlive: 30s

  - hostname: $STREAM_HOSTNAME
    service: http://localhost:8888
    originRequest:
      connectTimeout: 10s
      tcpKeepAlive: 30s
      keepAliveTimeout: 90s

  - service: http_status:404
EOF

# Copy credentials into /etc/cloudflared if not already there
if [[ -f "$CRED_DIR/$TUNNEL_ID.json" && "$CRED_DIR" != "/etc/cloudflared" ]]; then
    cp "$CRED_DIR/$TUNNEL_ID.json" /etc/cloudflared/
    # Update config to point to the copied file
    sed -i "s|credentials-file: .*|credentials-file: /etc/cloudflared/$TUNNEL_ID.json|" /etc/cloudflared/config.yml
fi

echo "    Config written to /etc/cloudflared/config.yml"

# ── 6. Update api-gateway/.env ──────────────────────────────────────────────
echo "[6/7] Updating api-gateway .env..."
for KEY in MEDIAMTX_HLS_URL MEDIAMTX_URL NVR_DEVICE_ID NVR_PUBLIC_URL; do
    sed -i "/^$KEY=/d" "$ENV_FILE"
done
cat >> "$ENV_FILE" << EOF

# Cloudflare Tunnel — cloud-reachable stream endpoints (added by setup.sh)
MEDIAMTX_HLS_URL=https://$STREAM_HOSTNAME
MEDIAMTX_URL=https://$STREAM_HOSTNAME
NVR_DEVICE_ID=$DEVICE_ID
NVR_PUBLIC_URL=https://$API_HOSTNAME
EOF
echo "    .env updated."

# ── 7. Install and start systemd service ────────────────────────────────────
echo "[7/7] Installing cloudflared systemd service..."
cp "$SCRIPT_DIR/../systemd/cloudflared.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable cloudflared
systemctl restart cloudflared

echo ""
echo "✓ Setup complete."
echo ""
echo "  API   : https://$API_HOSTNAME"
echo "  Stream: https://$STREAM_HOSTNAME"
echo ""
echo "Enter this URL in the AuraSense Android app:"
echo "  https://$API_HOSTNAME"
echo ""
echo "Tunnel status : sudo systemctl status cloudflared"
echo "Tunnel logs   : sudo journalctl -u cloudflared -f"
