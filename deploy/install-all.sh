#!/usr/bin/env bash
# AuraSense NVR — Master deployment script
# Runs all phases in order. Prompts for config once at the start.
# Each phase can be skipped individually (press S).
#
# Usage: sudo bash install-all.sh
#
# After completion: sudo reboot, then run: sudo bash deploy/08-verify.sh

set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"

# Must run as root
if [[ $EUID -ne 0 ]]; then
    echo "Run as root: sudo bash $0"
    exit 1
fi

echo ""
echo "=========================================="
echo "  AuraSense NVR — Customer Setup"
echo "  $(date)"
echo "=========================================="

# ── Collect config upfront ────────────────────────────────────────────────────
source "$DEPLOY_DIR/config.sh"

echo ""
echo "Configuration summary:"
echo "  Internet NIC:  $INET_NIC"
echo "  Camera NIC:    $CAM_NIC  ($CAMERA_NIC_IP)"
echo "  Recording HDD: $REC_DISK"
echo "  Cloudflare:    $CF_DOMAIN"
echo ""
read -rp "Proceed with installation? [Y/n]: " GO
if [[ "${GO,,}" == "n" ]]; then
    echo "Aborted."
    exit 0
fi

# ── Phase runner ─────────────────────────────────────────────────────────────
PHASES=(
    "00-netplan.sh    | Dual-NIC network configuration"
    "01-calibrate.sh  | System calibration (microcode, governor, tuning) — REBOOTS"
    "02-prerequisites.sh | Install Python 3.11, Node.js 20, Redis, cage, Chromium"
    "03-deploy.sh     | Clone repo, build venvs, configure .env, install services"
    "04-hdd-setup.sh  | Format + mount 4 TB recording HDD"
    "05-kiosk.sh      | Configure TTY1 autologin + cage kiosk service"
    "06-firewall.sh   | UFW firewall rules"
    "07-cloudflare.sh | Cloudflare tunnel setup"
    "08-verify.sh     | Verify all services"
)

for entry in "${PHASES[@]}"; do
    SCRIPT=$(echo "$entry" | cut -d'|' -f1 | xargs)
    DESC=$(echo "$entry" | cut -d'|' -f2 | xargs)
    echo ""
    echo "┌─────────────────────────────────────────────────"
    echo "│  Phase: $SCRIPT"
    echo "│  $DESC"
    echo "└─────────────────────────────────────────────────"
    read -rp "  Run this phase? [Y/n/q(quit)]: " CHOICE
    case "${CHOICE,,}" in
        n) echo "  Skipped." ; continue ;;
        q) echo "  Installation paused. Re-run install-all.sh to continue." ; exit 0 ;;
        *) ;;
    esac

    echo ""
    bash "$DEPLOY_DIR/$SCRIPT"
    EXIT_CODE=$?

    if [[ $EXIT_CODE -ne 0 ]]; then
        echo ""
        echo "ERROR: $SCRIPT failed with exit code $EXIT_CODE."
        read -rp "Continue anyway? [y/N]: " CONT
        [[ "${CONT,,}" == "y" ]] || exit 1
    fi

    # 01-calibrate.sh reboots the machine — pause here and tell user to re-run
    if [[ "$SCRIPT" == "01-calibrate.sh" ]]; then
        echo ""
        echo "=========================================="
        echo "  System is rebooting for microcode update."
        echo "  SSH back in and re-run this script."
        echo "  The script will skip already-run phases"
        echo "  if you press S to skip phase 01."
        echo "=========================================="
        exit 0
    fi
done

echo ""
echo "=========================================="
echo "  Installation complete!"
echo ""
echo "  NEXT STEPS:"
echo "  1. sudo reboot"
echo "  2. SSH back in"
echo "  3. sudo bash deploy/08-verify.sh"
echo "  4. Connect cameras to the $CAM_NIC port"
echo "  5. Wait ~60 s — cameras appear automatically"
echo "=========================================="
