#!/usr/bin/env bash
# AuraSense NVR — Per-customer setup (run once on a freshly-flashed box)
#
# Turns this customer's golden image into a clean install for a new
# customer. Regenerates identity (machine-id, SSH keys, hostname),
# wipes stale state (.db files, old cloudflared cert, dnsmasq leases),
# rotates secrets in every .env, redetects NICs and rewrites netplan +
# dnsmasq, formats and mounts the recording HDD, sets up a new
# Cloudflare tunnel, then verifies all services are healthy.
#
# Run as root:
#   sudo bash deploy/firstboot.sh
#
# Flags:
#   --resume                 Skip phases that have already completed.
#   --force                  Run even if firstboot has already finished.
#   --hostname NAME          Skip the hostname prompt.
#   --domain   DOMAIN        Customer's Cloudflare domain (e.g. site1.example.com).
#   --onvif-pass PASSWORD    Camera ONVIF/RTSP password.
#   --admin-pass PASSWORD    Default web-dashboard admin password.

set -euo pipefail

# ── Paths and constants ───────────────────────────────────────────────────────
REPO_DIR="/home/aura/Documents/aurasense"
DEPLOY_DIR="$REPO_DIR/deploy"
SENTINEL_DIR="/var/lib/aurasense-firstboot"
DONE_FILE="$SENTINEL_DIR/all.done"

# ── Args ──────────────────────────────────────────────────────────────────────
RESUME=0
FORCE=0
HOSTNAME_NEW=""
CF_DOMAIN_NEW=""
ONVIF_PASS_NEW=""
ADMIN_PASS_NEW=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --resume)      RESUME=1; shift ;;
        --force)       FORCE=1; shift ;;
        --hostname)    HOSTNAME_NEW="$2"; shift 2 ;;
        --domain)      CF_DOMAIN_NEW="$2"; shift 2 ;;
        --onvif-pass)  ONVIF_PASS_NEW="$2"; shift 2 ;;
        --admin-pass)  ADMIN_PASS_NEW="$2"; shift 2 ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

# ── Pre-flight ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo "ERROR: must run as root (sudo)." >&2
    exit 1
fi

if [[ ! -d "$DEPLOY_DIR" ]]; then
    echo "ERROR: $DEPLOY_DIR not found. Is the repo at $REPO_DIR?" >&2
    exit 1
fi

if [[ -f "$DONE_FILE" && $FORCE -ne 1 && $RESUME -ne 1 ]]; then
    echo "firstboot has already completed on this machine."
    echo "Pass --force to run again, or --resume to retry incomplete phases."
    exit 0
fi

mkdir -p "$SENTINEL_DIR"

# ── Helpers ───────────────────────────────────────────────────────────────────
phase_skipped() {
    local name=$1
    [[ $RESUME -eq 1 && -f "$SENTINEL_DIR/$name.done" ]]
}

phase_done() {
    local name=$1
    touch "$SENTINEL_DIR/$name.done"
}

gen_secret() {
    python3 -c "import secrets; print(secrets.token_hex(32))"
}

prompt_default() {
    # prompt_default "label" "default" → echoes the user's answer or default
    local label=$1 default=$2 ans
    if [[ -n "$default" ]]; then
        read -rp "$label [$default]: " ans
        echo "${ans:-$default}"
    else
        read -rp "$label: " ans
        echo "$ans"
    fi
}

prompt_secret() {
    local label=$1 ans
    while [[ -z "${ans:-}" ]]; do
        read -rsp "$label: " ans
        echo ""
        [[ -z "$ans" ]] && echo "  Cannot be empty."
    done
    echo "$ans"
}

# Replace KEY=value in a file in place (no sed regex headaches).
set_env_var() {
    local file=$1 key=$2 value=$3
    if grep -qE "^${key}=" "$file"; then
        # Use a placeholder that won't appear in any real value.
        python3 -c "
import sys, re, pathlib
p, k, v = sys.argv[1], sys.argv[2], sys.argv[3]
text = pathlib.Path(p).read_text()
text = re.sub(rf'^{re.escape(k)}=.*$', f'{k}={v}', text, count=1, flags=re.M)
pathlib.Path(p).write_text(text)
" "$file" "$key" "$value"
    else
        echo "${key}=${value}" >> "$file"
    fi
}

# ── A. Collect inputs up front (no half-way prompts) ──────────────────────────
phase_collect_inputs() {
    if phase_skipped "collect_inputs"; then echo "[collect_inputs] skipped"; return; fi
    echo "==> Collecting per-customer inputs"

    [[ -z "$HOSTNAME_NEW"   ]] && HOSTNAME_NEW=$(prompt_default   "Hostname"                    "aurasense-nvr")
    [[ -z "$CF_DOMAIN_NEW"  ]] && CF_DOMAIN_NEW=$(prompt_default  "Cloudflare domain"           "")
    [[ -z "$ONVIF_PASS_NEW" ]] && ONVIF_PASS_NEW=$(prompt_secret  "Camera ONVIF/RTSP password")
    [[ -z "$ADMIN_PASS_NEW" ]] && ADMIN_PASS_NEW=$(prompt_secret  "Dashboard admin password (will be the default login)")

    if [[ -z "$CF_DOMAIN_NEW" ]]; then
        echo "ERROR: Cloudflare domain is required." >&2
        exit 1
    fi

    # Persist for --resume.
    cat > "$SENTINEL_DIR/inputs.env" <<ENV
HOSTNAME_NEW=$HOSTNAME_NEW
CF_DOMAIN_NEW=$CF_DOMAIN_NEW
ONVIF_PASS_NEW=$ONVIF_PASS_NEW
ADMIN_PASS_NEW=$ADMIN_PASS_NEW
ENV
    chmod 600 "$SENTINEL_DIR/inputs.env"
    phase_done "collect_inputs"
}

# If resuming and any required input is empty, restore from sentinel.
if [[ $RESUME -eq 1 && -f "$SENTINEL_DIR/inputs.env" ]]; then
    # shellcheck source=/dev/null
    source "$SENTINEL_DIR/inputs.env"
fi

# ── B. Stop services so they don't touch stale state during reconfig ──────────
phase_stop_services() {
    if phase_skipped "stop_services"; then echo "[stop_services] skipped"; return; fi
    echo "==> Stopping AuraSense services"
    systemctl stop aurasense.target 2>/dev/null || true
    systemctl stop cloudflared dnsmasq 2>/dev/null || true
    phase_done "stop_services"
}

# ── C. Regenerate machine identity ────────────────────────────────────────────
phase_identity() {
    if phase_skipped "identity"; then echo "[identity] skipped"; return; fi
    echo "==> Regenerating machine identity"

    # machine-id — empty file triggers regeneration on next setup call.
    : > /etc/machine-id
    rm -f /var/lib/dbus/machine-id
    systemd-machine-id-setup
    ln -sf /etc/machine-id /var/lib/dbus/machine-id

    # SSH host keys.
    rm -f /etc/ssh/ssh_host_*
    DEBIAN_FRONTEND=noninteractive dpkg-reconfigure openssh-server

    # Hostname.
    hostnamectl set-hostname "$HOSTNAME_NEW"
    # /etc/hosts — keep loopback lines, replace any other entry pointing at the old hostname.
    python3 - "$HOSTNAME_NEW" <<'PY'
import sys, pathlib, re
new = sys.argv[1]
p = pathlib.Path("/etc/hosts")
lines = p.read_text().splitlines()
out = []
seen_127_1_1_1 = False
for line in lines:
    if line.startswith("127.0.1.1"):
        out.append(f"127.0.1.1\t{new}")
        seen_127_1_1_1 = True
    else:
        out.append(line)
if not seen_127_1_1_1:
    out.append(f"127.0.1.1\t{new}")
p.write_text("\n".join(out) + "\n")
PY
    phase_done "identity"
}

# ── D. Wipe stale customer state from the cloned image ────────────────────────
phase_wipe_state() {
    if phase_skipped "wipe_state"; then echo "[wipe_state] skipped"; return; fi
    echo "==> Wiping stale state from the cloned image"

    # Camera databases — fresh on next discovery cycle.
    rm -f "$REPO_DIR/camera_discovery/cameras.db"  \
          "$REPO_DIR/camera_discovery/cameras.db-shm" \
          "$REPO_DIR/camera_discovery/cameras.db-wal" \
          "$REPO_DIR/api-gateway/cameras.db" \
          "$REPO_DIR/api-gateway/cameras.db-shm" \
          "$REPO_DIR/api-gateway/cameras.db-wal"

    # Previous customer's cloudflared tunnel and cert.
    rm -rf /etc/cloudflared
    rm -rf /root/.cloudflared

    # dnsmasq lease file (cameras and their leases will be re-learned).
    rm -f /var/lib/misc/dnsmasq.leases /var/lib/dnsmasq/dnsmasq.leases

    # Old recordings directory entry — fstab is rewritten by 04-hdd-setup.sh.
    # Don't touch the disk itself; user may have a populated drive to reuse.

    phase_done "wipe_state"
}

# ── E. Rotate secrets in every .env ───────────────────────────────────────────
phase_rotate_secrets() {
    if phase_skipped "rotate_secrets"; then echo "[rotate_secrets] skipped"; return; fi
    echo "==> Rotating .env secrets"

    local api_secret app_secret signaling_secret
    api_secret=$(gen_secret)
    app_secret=$(gen_secret)
    signaling_secret=$(gen_secret)  # must match between api-gateway and signaling-server

    local root_env="$REPO_DIR/.env"
    local api_env="$REPO_DIR/api-gateway/.env"
    local sig_env="$REPO_DIR/signaling-server/.env"

    # Root .env — start from the template so we drop any source-box leftovers.
    cp "$REPO_DIR/.env.template" "$root_env"
    set_env_var "$root_env" "CAMERA_ONVIF_PASS"    "$ONVIF_PASS_NEW"
    set_env_var "$root_env" "CAMERA_RTSP_PASS"     "$ONVIF_PASS_NEW"
    set_env_var "$root_env" "API_SECRET_KEY"       "$api_secret"

    # api-gateway .env — start from example so secrets and placeholders are correct.
    cp "$REPO_DIR/api-gateway/.env.example" "$api_env"
    set_env_var "$api_env" "APP_SECRET"            "$app_secret"
    set_env_var "$api_env" "SIGNALING_JWT_SECRET"  "$signaling_secret"
    set_env_var "$api_env" "DEFAULT_ADMIN_PASSWORD" "$ADMIN_PASS_NEW"
    set_env_var "$api_env" "MEDIAMTX_HLS_URL"      "https://stream.${CF_DOMAIN_NEW}"
    set_env_var "$api_env" "MEDIAMTX_URL"          "https://webrtc.${CF_DOMAIN_NEW}"

    # NVR_DEVICE_ID — use the camera-NIC MAC; falls back to a random token.
    local cam_mac
    cam_mac=$(ip -o link show \
        | awk -F': ' '{print $2}' \
        | grep -v -E '^lo$|^docker|^veth|^virbr' \
        | head -1)
    if [[ -n "$cam_mac" ]]; then
        cam_mac=$(cat "/sys/class/net/$cam_mac/address" 2>/dev/null | tr -d ':')
    fi
    [[ -z "${cam_mac:-}" ]] && cam_mac=$(python3 -c "import secrets; print(secrets.token_hex(6))")
    set_env_var "$api_env" "NVR_DEVICE_ID"         "$cam_mac"

    # signaling-server .env — JWT_SECRET must match api-gateway's SIGNALING_JWT_SECRET.
    cp "$REPO_DIR/signaling-server/.env.example" "$sig_env"
    set_env_var "$sig_env" "JWT_SECRET"            "$signaling_secret"

    chown aura:aura "$root_env" "$api_env" "$sig_env" 2>/dev/null || true
    chmod 600 "$root_env" "$api_env" "$sig_env"

    phase_done "rotate_secrets"
}

# ── F1. Detect hardware and write deploy/.config so existing scripts skip prompts.
# config.sh sources .config if present and returns early, bypassing its
# interactive prompts. We replicate its auto-detection here and write a
# complete file so 00-netplan.sh / 00b-camera-dhcp.sh / 04-hdd-setup.sh /
# 07-cloudflare.sh all run unattended.
phase_write_config() {
    if phase_skipped "write_config"; then echo "[write_config] skipped"; return; fi
    echo "==> Detecting NICs / HDD and writing deploy/.config"

    local inet_nic cam_nic boot_disk rec_disk
    inet_nic=$(ip route get 8.8.8.8 2>/dev/null \
        | awk '/dev/{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' \
        | head -1)
    if [[ -z "$inet_nic" ]]; then
        echo "ERROR: no internet route — connect the WAN cable and re-run." >&2
        exit 1
    fi

    cam_nic=$(ip -o link show \
        | awk -F': ' '{print $2}' \
        | grep -v -E '^lo$|^docker|^veth|^virbr' \
        | grep -v "^$inet_nic$" \
        | head -1)
    if [[ -z "$cam_nic" ]]; then
        echo "ERROR: no second NIC detected for camera segment." >&2
        exit 1
    fi

    boot_disk=$(lsblk -no PKNAME "$(findmnt -n -o SOURCE /)" 2>/dev/null | head -1 || echo "sda")
    rec_disk=$(lsblk -dno NAME,TYPE \
        | awk '$2=="disk"' \
        | grep -v "^$boot_disk $" \
        | head -1 \
        | awk '{print "/dev/"$1}')

    echo "  Internet NIC: $inet_nic"
    echo "  Camera NIC:   $cam_nic"
    echo "  Recording HDD: ${rec_disk:-<none detected>}"

    cat > "$DEPLOY_DIR/.config" <<CONF
# AuraSense NVR deploy config — written by firstboot.sh $(date)
INET_NIC="$inet_nic"
CAM_NIC="$cam_nic"
REC_DISK="${rec_disk:-}"
CAMERA_NIC_IP="10.42.0.1"
CAMERA_SUBNET="10.42.0.0/24"
CAMERA_ONVIF_PASS="$ONVIF_PASS_NEW"
REPO_URL="(already-cloned)"
CF_DOMAIN="$CF_DOMAIN_NEW"
API_SECRET_KEY="$(gen_secret)"
CONF
    chmod 600 "$DEPLOY_DIR/.config"
    phase_done "write_config"
}

# ── F2. Re-detect NICs and rewrite netplan + dnsmasq via existing scripts ─────
phase_hardware() {
    if phase_skipped "hardware"; then echo "[hardware] skipped"; return; fi
    echo "==> Running 00-netplan.sh and 00b-camera-dhcp.sh"
    bash "$DEPLOY_DIR/00-netplan.sh"
    bash "$DEPLOY_DIR/00b-camera-dhcp.sh"
    phase_done "hardware"
}

# ── G. Recording disk ─────────────────────────────────────────────────────────
phase_recording_disk() {
    if phase_skipped "recording_disk"; then echo "[recording_disk] skipped"; return; fi
    echo "==> Configuring recording HDD"

    # Read REC_DISK from the .config we just wrote.
    local rec_disk
    rec_disk=$(awk -F'"' '/^REC_DISK=/ {print $2}' "$DEPLOY_DIR/.config" || true)

    if [[ -z "$rec_disk" ]]; then
        echo "  No recording HDD detected. Skipping format."
        echo "  Plug a disk in and re-run: sudo bash $0 --resume"
        return  # do NOT mark done so --resume will retry
    fi

    echo "  Recording HDD: $rec_disk"
    # 04-hdd-setup.sh has an interactive "Type YES to confirm" prompt;
    # feed it the answer so the script runs unattended.
    echo "YES" | bash "$DEPLOY_DIR/04-hdd-setup.sh"
    phase_done "recording_disk"
}

# ── H. Cloudflare tunnel ──────────────────────────────────────────────────────
phase_cloudflare() {
    if phase_skipped "cloudflare"; then echo "[cloudflare] skipped"; return; fi
    echo "==> Setting up Cloudflare tunnel (interactive — browser login required)"
    bash "$DEPLOY_DIR/07-cloudflare.sh"
    phase_done "cloudflare"
}

# ── I. Start services and verify ──────────────────────────────────────────────
phase_start_and_verify() {
    if phase_skipped "start_and_verify"; then echo "[start_and_verify] skipped"; return; fi
    echo "==> Starting services and verifying"
    systemctl daemon-reload
    systemctl start aurasense.target cloudflared dnsmasq
    sleep 3
    bash "$DEPLOY_DIR/08-verify.sh"
    phase_done "start_and_verify"
}

# ── Run all phases ────────────────────────────────────────────────────────────
phase_collect_inputs
phase_stop_services
phase_identity
phase_wipe_state
phase_rotate_secrets
phase_write_config
phase_hardware
phase_recording_disk
phase_cloudflare
phase_start_and_verify

touch "$DONE_FILE"

echo ""
echo "========================================"
echo "  AuraSense firstboot complete"
echo "========================================"
echo "  Hostname:      $HOSTNAME_NEW"
echo "  Tunnel domain: https://api.${CF_DOMAIN_NEW}"
echo "  Admin login:   admin / <the password you just set>"
echo ""
echo "Verify in a browser. To re-run any failed phase: sudo bash $0 --resume"
