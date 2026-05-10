#!/usr/bin/env bash
# Phase 00 — Dual-NIC network configuration
# Writes netplan YAML for internet NIC (DHCP) + camera NIC (static).
# Fixes systemd-networkd-wait-online to not stall boot if camera NIC has no link.

set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DEPLOY_DIR/config.sh"

echo "[00-netplan] Configuring dual-NIC network..."
echo "  Internet NIC: $INET_NIC (DHCP)"
echo "  Camera NIC:   $CAM_NIC  (static $CAMERA_NIC_IP)"

# ── Write netplan config ───────────────────────────────────────────────────────
NETPLAN_FILE="/etc/netplan/00-installer-config.yaml"

cat > "$NETPLAN_FILE" << YAML
network:
  version: 2
  ethernets:
    $INET_NIC:
      dhcp4: true
    $CAM_NIC:
      dhcp4: false
      addresses:
        - $CAMERA_NIC_IP/$(echo "$CAMERA_SUBNET" | cut -d'/' -f2)
      # IPv4 link-local fallback: ensures the host has a 169.254/16 route via
      # this NIC so discovery can reach cameras that lost their DHCP lease and
      # fell back to 169.254.x.x. Without this, link-local packets leave via
      # the internet NIC and never reach the camera segment.
      link-local: [ipv4]
YAML

chmod 600 "$NETPLAN_FILE"
echo "[00-netplan] Wrote $NETPLAN_FILE"

# ── Fix network-online wait — only wait for internet NIC ──────────────────────
# Without this, boot stalls for 2 min if the camera NIC has no physical link.
mkdir -p /etc/systemd/system/systemd-networkd-wait-online.service.d
cat > /etc/systemd/system/systemd-networkd-wait-online.service.d/override.conf << UNIT
[Service]
ExecStart=
ExecStart=/lib/systemd/systemd-networkd-wait-online --interface=$INET_NIC --timeout=30
UNIT
echo "[00-netplan] Boot wait-online restricted to $INET_NIC"

systemctl daemon-reload
netplan apply

echo "[00-netplan] Done. Verifying..."
sleep 2
ip addr show "$INET_NIC"  | grep "inet " && echo "  Internet NIC: OK"
ip addr show "$CAM_NIC"   | grep "inet " && echo "  Camera NIC:   OK" || \
    echo "  Camera NIC: no IP yet (normal if no cable connected)"
