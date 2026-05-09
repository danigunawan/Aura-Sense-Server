#!/usr/bin/env bash
# Phase 06 — UFW firewall (dual-NIC rules)
# Internet NIC: SSH + API + HLS + WebRTC
# Camera NIC: RTSP only (cameras are on this subnet)
# mediamtx internal API (9997) is localhost-only — never exposed.

set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DEPLOY_DIR/config.sh"

echo "[06-firewall] Configuring UFW..."
echo "  Internet NIC: $INET_NIC"
echo "  Camera NIC:   $CAM_NIC"

apt-get install -y -qq ufw

# Reset to clean state
ufw --force reset

# Default policy
ufw default deny incoming
ufw default allow outgoing
ufw default deny routed

# SSH — internet NIC only (restrict to prevent camera-network SSH access)
ufw allow in on "$INET_NIC" to any port 22 proto tcp comment 'SSH management'

# API gateway — accessible from both NICs (Android app via tunnel, kiosk via localhost)
ufw allow 8000/tcp comment 'AuraSense API + dashboard'

# HLS streaming — mediamtx serves LL-HLS here
ufw allow 8888/tcp comment 'HLS streaming'

# WebRTC — mediamtx serves WHEP here
ufw allow 8889/tcp comment 'WebRTC WHEP'

# RTSP — camera NIC only; cameras pull streams from mediamtx via RTSP
ufw allow in on "$CAM_NIC" to any port 8554 proto tcp comment 'RTSP (camera NIC only)'

# Explicitly block mediamtx internal API from outside
ufw deny 9997 comment 'mediamtx API (internal only)'

# Enable
ufw --force enable

echo ""
echo "[06-firewall] Firewall status:"
ufw status verbose
echo ""
echo "[06-firewall] Done."
