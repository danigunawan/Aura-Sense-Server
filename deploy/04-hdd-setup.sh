#!/usr/bin/env bash
# Phase 04 — Format + mount 4 TB recording HDD, configure fstab.

set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DEPLOY_DIR/config.sh"

MOUNT_POINT="/media/aura/recordaura"

echo "[04-hdd-setup] Recording HDD: $REC_DISK"
echo ""

# ── Safety confirmation ───────────────────────────────────────────────────────
echo "  WARNING: This will WIPE all data on $REC_DISK."
lsblk "$REC_DISK"
echo ""
read -rp "  Type YES to confirm formatting $REC_DISK: " CONFIRM
if [[ "$CONFIRM" != "YES" ]]; then
    echo "[04-hdd-setup] Aborted."
    exit 1
fi

# ── Stop recording service if running ─────────────────────────────────────────
systemctl stop aurasense-recording.service 2>/dev/null || true

# ── Partition ─────────────────────────────────────────────────────────────────
echo "[04-hdd-setup] Partitioning $REC_DISK..."
parted "$REC_DISK" --script mklabel gpt
parted "$REC_DISK" --script mkpart primary ext4 0% 100%
partprobe "$REC_DISK"
sleep 2

PART="${REC_DISK}1"
# Handle devices like /dev/nvme0n1 → /dev/nvme0n1p1
if [[ "$REC_DISK" =~ [0-9]$ ]]; then
    PART="${REC_DISK}p1"
fi

# ── Format ────────────────────────────────────────────────────────────────────
echo "[04-hdd-setup] Formatting ${PART} as ext4 (label: recordaura)..."
mkfs.ext4 -F -L recordaura "$PART"

# ── Mount ─────────────────────────────────────────────────────────────────────
mkdir -p "$MOUNT_POINT/recordings"
mount "$PART" "$MOUNT_POINT"
chown -R aura:aura "$MOUNT_POINT"
echo "[04-hdd-setup] Mounted at $MOUNT_POINT"

# ── fstab entry (nofail = boot succeeds even if HDD is absent) ────────────────
UUID=$(blkid -s UUID -o value "$PART")
FSTAB_ENTRY="UUID=$UUID $MOUNT_POINT ext4 defaults,noatime,nofail 0 2"

if grep -q "$MOUNT_POINT" /etc/fstab; then
    # Update existing entry
    sed -i "\|$MOUNT_POINT|c\\$FSTAB_ENTRY" /etc/fstab
else
    echo "$FSTAB_ENTRY" >> /etc/fstab
fi
echo "[04-hdd-setup] fstab updated (UUID=$UUID)"

# ── Verify ────────────────────────────────────────────────────────────────────
mount -a
mountpoint "$MOUNT_POINT" && echo "[04-hdd-setup] Mount verified OK"
df -h "$MOUNT_POINT"

# ── Start recording service if installed ──────────────────────────────────────
systemctl start aurasense-recording.service 2>/dev/null || true

echo ""
echo "[04-hdd-setup] Done."
