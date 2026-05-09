#!/usr/bin/env bash
# AuraSense NVR — Deployment configuration
# Sourced by all deploy scripts. Auto-detects NICs + HDD, prompts for secrets.

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$DEPLOY_DIR/.config"

# ── Load saved config ──────────────────────────────────────────────────────────
if [[ -f "$CONFIG_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$CONFIG_FILE"
    return 0 2>/dev/null || true
fi

echo ""
echo "========================================"
echo "  AuraSense NVR — Initial Configuration"
echo "========================================"

# ── Auto-detect internet NIC ───────────────────────────────────────────────────
echo ""
echo "Detecting network interfaces..."
INET_NIC=$(ip route get 8.8.8.8 2>/dev/null \
    | awk '/dev/{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -1)
if [[ -z "$INET_NIC" ]]; then
    echo "  ERROR: Cannot detect internet NIC. Check internet connectivity."
    exit 1
fi
echo "  Internet NIC: $INET_NIC"

# ── Auto-detect camera NIC ────────────────────────────────────────────────────
CAM_NIC=$(ip -o link show \
    | awk -F': ' '{print $2}' \
    | grep -v -E '^lo$|^docker|^veth|^virbr' \
    | grep -v "^$INET_NIC$" \
    | head -1)
if [[ -z "$CAM_NIC" ]]; then
    echo ""
    ip -o link show | awk -F': ' '{print "  " $2}' | grep -v lo
    read -rp "  Camera NIC name (not auto-detected): " CAM_NIC
fi
echo "  Camera NIC:   $CAM_NIC"

# ── Auto-detect recording HDD ─────────────────────────────────────────────────
echo ""
echo "Detecting recording HDD (>=3 TB, not the OS disk)..."
BOOT_DISK=$(lsblk -no PKNAME "$(findmnt -n -o SOURCE /)" 2>/dev/null \
    | head -1 || echo "sda")
REC_DISK=$(lsblk -dno NAME,SIZE,TYPE \
    | awk '$3=="disk" && ($2 ~ /[3-9][0-9]*(\.[0-9]+)?T/ || $2 ~ /[0-9]{4,}G/)' \
    | grep -v "^$BOOT_DISK " \
    | head -1 | awk '{print "/dev/"$1}')
if [[ -z "$REC_DISK" ]]; then
    echo ""
    echo "  Available disks:"
    lsblk -dno NAME,SIZE,TYPE | awk '$3=="disk" {print "    /dev/"$1"  "$2}'
    read -rp "  Recording HDD device path (e.g. /dev/sdb): " REC_DISK
fi
echo "  Recording HDD: $REC_DISK"

# ── Prompts ────────────────────────────────────────────────────────────────────
echo ""

read -rp "Camera NIC static IP for this machine [10.42.0.1]: " CAMERA_NIC_IP
CAMERA_NIC_IP="${CAMERA_NIC_IP:-10.42.0.1}"

read -rp "Camera subnet CIDR [10.42.0.0/24]: " CAMERA_SUBNET
CAMERA_SUBNET="${CAMERA_SUBNET:-10.42.0.0/24}"

CAMERA_ONVIF_PASS=""
while [[ -z "$CAMERA_ONVIF_PASS" ]]; do
    read -rsp "Camera ONVIF/RTSP password (same on all cameras): " CAMERA_ONVIF_PASS
    echo ""
    [[ -z "$CAMERA_ONVIF_PASS" ]] && echo "  Password cannot be empty."
done

REPO_URL=""
while [[ -z "$REPO_URL" ]]; do
    read -rp "Git repository URL: " REPO_URL
    [[ -z "$REPO_URL" ]] && echo "  URL cannot be empty."
done

CF_DOMAIN=""
while [[ -z "$CF_DOMAIN" ]]; do
    read -rp "Cloudflare domain for this customer (e.g. site1.example.com): " CF_DOMAIN
    [[ -z "$CF_DOMAIN" ]] && echo "  Domain cannot be empty."
done

# ── Auto-generate API secret ───────────────────────────────────────────────────
API_SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null \
    || openssl rand -hex 32)

# ── Save ───────────────────────────────────────────────────────────────────────
cat > "$CONFIG_FILE" << CONF
# AuraSense NVR deploy config — $(date)
INET_NIC="$INET_NIC"
CAM_NIC="$CAM_NIC"
REC_DISK="$REC_DISK"
CAMERA_NIC_IP="$CAMERA_NIC_IP"
CAMERA_SUBNET="$CAMERA_SUBNET"
CAMERA_ONVIF_PASS="$CAMERA_ONVIF_PASS"
REPO_URL="$REPO_URL"
CF_DOMAIN="$CF_DOMAIN"
API_SECRET_KEY="$API_SECRET_KEY"
CONF
chmod 600 "$CONFIG_FILE"

echo ""
echo "Configuration saved. Re-running any script will use these saved values."
echo "(Delete $CONFIG_FILE to re-enter.)"
echo ""
