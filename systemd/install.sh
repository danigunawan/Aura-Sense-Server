#!/usr/bin/env bash
# Install AuraSense systemd services.
# Run with: sudo bash install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_DIR="/etc/systemd/system"

echo "==> Copying unit files to ${SYSTEMD_DIR}"
for f in "${SCRIPT_DIR}"/*.service "${SCRIPT_DIR}"/*.target; do
    cp "$f" "${SYSTEMD_DIR}/"
    echo "    installed $(basename "$f")"
done

echo "==> Installing storage helper script"
install -o root -g root -m 0755 "${SCRIPT_DIR}/aurasense-format-hdd.sh" /usr/local/bin/aurasense-format-hdd.sh
echo "    installed /usr/local/bin/aurasense-format-hdd.sh"

echo "==> Installing sudoers rule"
install -o root -g root -m 0440 "${SCRIPT_DIR}/aurasense-storage.sudoers" /etc/sudoers.d/aurasense-storage
visudo -c -f /etc/sudoers.d/aurasense-storage
echo "    installed /etc/sudoers.d/aurasense-storage"

echo "==> Reloading systemd"
systemctl daemon-reload

echo "==> Enabling services to start at boot"
systemctl enable aurasense.target
systemctl enable aurasense-mediamtx.service
systemctl enable aurasense-api.service
systemctl enable aurasense-entrance-encoder.service
systemctl enable aurasense-lobby-encoder.service
systemctl enable aurasense-watchdog.service
systemctl enable aurasense-recording.service
systemctl enable aurasense-kiosk.service

echo ""
echo "Done. To start everything now:"
echo "    sudo systemctl start aurasense.target"
echo ""
echo "Useful commands:"
echo "    sudo systemctl status aurasense-*        # check all services"
echo "    journalctl -u aurasense-mediamtx -f      # mediamtx logs"
echo "    journalctl -u aurasense-watchdog -f      # watchdog logs
    journalctl -u aurasense-recording -f     # recording service logs"
echo "    journalctl -u aurasense-* --since -1h    # last hour, all services"
echo "    cat /run/aurasense/health.json | python3 -m json.tool"
