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

# ── Silence netplan permission warnings on sibling NM yaml ───────────────────
# `01-network-manager-all.yaml` ships world-readable on some Ubuntu installs;
# every netplan invocation warns loudly. Tighten it (no-op if already 600).
[ -f /etc/netplan/01-network-manager-all.yaml ] && \
    chmod 600 /etc/netplan/01-network-manager-all.yaml

# ── NetworkManager fallback: pin a static 169.254/16 on the camera NIC ───────
# When the renderer is NetworkManager (Ubuntu 24.04 desktop default), netplan's
# `link-local: [ipv4]` does not translate reliably to NM. Older NM builds also
# lack the `ipv4.link-local` connection property entirely. Pin a deterministic
# secondary address instead — same effect (kernel routes 169.254/16 out the
# camera NIC), works on every NM version, idempotent. 169.254.1.1 is outside
# RFC 3927's dynamic-allocation pool so it won't collide with a camera's
# auto-IP. No-op when the renderer is networkd (nmcli absent / NM not running).
LINK_LOCAL_ADDR="169.254.1.1/16"
if command -v nmcli >/dev/null 2>&1 && systemctl is-active --quiet NetworkManager; then
    sleep 1  # let NM ingest the regenerated connection profile
    CAM_CONN="$(nmcli -t -f NAME,DEVICE connection show \
        | awk -F: -v d="$CAM_NIC" '$2==d{print $1; exit}')"
    if [ -n "$CAM_CONN" ]; then
        CURRENT_ADDRS="$(nmcli -g ipv4.addresses connection show "$CAM_CONN" 2>/dev/null || true)"
        if echo "$CURRENT_ADDRS" | grep -qF "$LINK_LOCAL_ADDR"; then
            echo "[00-netplan] $LINK_LOCAL_ADDR already on '$CAM_CONN' — skipping."
        else
            echo "[00-netplan] NetworkManager detected — adding $LINK_LOCAL_ADDR to '$CAM_CONN'..."
            nmcli connection modify "$CAM_CONN" +ipv4.addresses "$LINK_LOCAL_ADDR"
            nmcli connection up "$CAM_CONN" >/dev/null
        fi
    else
        echo "[00-netplan] WARN: NetworkManager active but no connection profile owns $CAM_NIC."
        echo "                 Link-local fallback recovery will NOT work until this is fixed."
    fi
fi

echo "[00-netplan] Done. Verifying..."
sleep 2
ip addr show "$INET_NIC"  | grep "inet " && echo "  Internet NIC: OK"
ip addr show "$CAM_NIC"   | grep "inet " && echo "  Camera NIC:   OK" || \
    echo "  Camera NIC: no IP yet (normal if no cable connected)"
ip -4 addr show "$CAM_NIC" | grep -q "169.254" && \
    echo "  Camera NIC link-local: OK (169.254/16 present)" || \
    echo "  Camera NIC link-local: MISSING — recovery from 169.254 won't work"
