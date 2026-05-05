#!/usr/bin/env bash
# Install AuraSense systemd services.
# Run with: sudo bash install.sh
# Idempotent — safe to re-run after updating unit files.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DIR="/etc/systemd/system"
BASE_DIR="/home/aura/Documents/aurasense"

echo "==> Copying unit files to ${SYSTEMD_DIR}"
for f in "${SCRIPT_DIR}"/*.service "${SCRIPT_DIR}"/*.target; do
    cp "$f" "${SYSTEMD_DIR}/"
    echo "    installed $(basename "$f")"
done

echo "==> Installing storage helper script"
install -o root -g root -m 0755 \
    "${SCRIPT_DIR}/aurasense-format-hdd.sh" \
    /usr/local/bin/aurasense-format-hdd.sh
echo "    installed /usr/local/bin/aurasense-format-hdd.sh"

echo "==> Installing sudoers rule"
install -o root -g root -m 0440 \
    "${SCRIPT_DIR}/aurasense-storage.sudoers" \
    /etc/sudoers.d/aurasense-storage
visudo -c -f /etc/sudoers.d/aurasense-storage
echo "    installed /etc/sudoers.d/aurasense-storage"

echo "==> Checking .env file"
if [ ! -f "${BASE_DIR}/.env" ]; then
    echo "    WARNING: ${BASE_DIR}/.env not found."
    echo "    Copy ${BASE_DIR}/.env.template to ${BASE_DIR}/.env and fill in credentials."
    echo "    Camera discovery will not authenticate until .env is configured."
else
    echo "    .env found"
fi

echo "==> Reloading systemd"
systemctl daemon-reload

echo "==> Enabling services to start at boot"
systemctl enable aurasense.target
systemctl enable aurasense-mediamtx.service
systemctl enable aurasense-discovery.service
systemctl enable aurasense-api.service
systemctl enable aurasense-watchdog.service
systemctl enable aurasense-recording.service
systemctl enable aurasense-kiosk.service

# Enable cloudflared tunnel only if already configured
if [ -f /etc/cloudflared/config.yml ]; then
    systemctl enable cloudflared.service
    echo "    cloudflared enabled (config found)"
else
    echo ""
    echo "    NOTE: Cloudflare Tunnel not yet configured."
    echo "    Run once to set up cloud access:"
    echo "      sudo ${SCRIPT_DIR}/../cloudflared/setup.sh <your-domain.com>"
fi

echo ""
echo "Done. To start everything now:"
echo "    sudo systemctl start aurasense.target"
echo ""
echo "First-time camera setup:"
echo "    1. Copy .env.template to .env and set CAMERA_ONVIF_PASS / CAMERA_RTSP_PASS"
echo "    2. Run: cd ${BASE_DIR}/camera_discovery && python main.py --probe"
echo "       This shows what manufacturer/model your cameras report (no DB write)"
echo "    3. Set CAMERA_ALLOWED_MANUFACTURER in .env to match"
echo "    4. Plug in cameras — they will auto-discover within 60 seconds"
echo ""
echo "Useful commands:"
echo "    sudo systemctl status aurasense-*"
echo "    journalctl -u aurasense-discovery -f     # camera scan logs"
echo "    journalctl -u aurasense-mediamtx -f      # stream proxy logs"
echo "    journalctl -u aurasense-recording -f     # recording logs"
echo "    journalctl -u cloudflared -f             # cloud tunnel logs"
echo "    journalctl -u aurasense-* --since -1h"
echo "    cat /run/aurasense/health.json | python3 -m json.tool"
echo "    cd ${BASE_DIR}/camera_discovery && python main.py --list"
