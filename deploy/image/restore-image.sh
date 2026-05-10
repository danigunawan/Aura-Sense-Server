#!/usr/bin/env bash
# AuraSense NVR — Golden image restorer
#
# Writes a golden-image bundle (produced by make-image.sh) onto the new
# box's SSD. Recreates the GPT partition table, sized to fill the target
# disk; restores BIOS-boot + EFI bytes verbatim; restores the ext4 root
# via partclone; expands the filesystem to fill the new partition.
#
# MUST be run from a live USB session. The target disk will be wiped.
#
# Usage:
#   sudo bash restore-image.sh /dev/sda /path/to/aurasense-base-20260511

set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <target_disk> <image_basename>" >&2
    echo "  e.g. $0 /dev/sda /mnt/usb/aurasense-base-20260511" >&2
    exit 2
fi

TGT_DISK="$1"
IMG_BASE="${2%.img.zst}"  # tolerate users passing the .img.zst path directly

IMG_ZST="${IMG_BASE}.img.zst"
PART_LAYOUT="${IMG_BASE}.partlayout"
BIOS_BIN="${IMG_BASE}.bios.bin"
EFI_BIN="${IMG_BASE}.efi.bin"

# ── Pre-flight ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo "ERROR: must run as root (sudo)." >&2
    exit 1
fi

for cmd in partclone.ext4 zstd sgdisk dd e2fsck resize2fs blockdev partprobe; do
    command -v "$cmd" >/dev/null 2>&1 || {
        echo "ERROR: missing required tool: $cmd" >&2
        echo "Hint: apt-get install -y partclone zstd gdisk e2fsprogs parted" >&2
        exit 1
    }
done

[[ -b "$TGT_DISK" ]] || { echo "ERROR: $TGT_DISK is not a block device." >&2; exit 1; }

for f in "$IMG_ZST" "$PART_LAYOUT" "$BIOS_BIN" "$EFI_BIN"; do
    [[ -r "$f" ]] || { echo "ERROR: cannot read $f" >&2; exit 1; }
done

# Refuse to touch a disk that's currently mounted or holds the running root.
if findmnt --source "${TGT_DISK}"* >/dev/null 2>&1; then
    echo "ERROR: $TGT_DISK has mounted partitions. Boot from a live USB and re-run." >&2
    exit 1
fi
ROOT_SOURCE=$(findmnt -n -o SOURCE / || true)
if [[ "$ROOT_SOURCE" == "${TGT_DISK}"* ]]; then
    echo "ERROR: $TGT_DISK holds the currently-running root. Refusing to overwrite." >&2
    exit 1
fi

TGT_SIZE_BYTES=$(blockdev --getsize64 "$TGT_DISK")
TGT_SIZE_GB=$(( TGT_SIZE_BYTES / 1024 / 1024 / 1024 ))
TGT_MODEL=$(lsblk -ndo MODEL "$TGT_DISK" 2>/dev/null || echo "unknown")

# Look at the image basename to gauge minimum target size: the compressed
# image is small, but the uncompressed ext4 must fit. We accept any disk
# that's at least 32 GB to be safe (typical baseline OS+venvs is ~14 GB).
MIN_TARGET_GB=32

echo ""
echo "========================================"
echo "  AuraSense — Golden image restore"
echo "========================================"
echo "  Target disk:    $TGT_DISK"
echo "  Target model:   $TGT_MODEL"
echo "  Target size:    ${TGT_SIZE_GB} GB"
echo "  Image bundle:   $IMG_BASE"
echo ""

if (( TGT_SIZE_GB < MIN_TARGET_GB )); then
    echo "ERROR: target disk is ${TGT_SIZE_GB} GB; need at least ${MIN_TARGET_GB} GB." >&2
    exit 1
fi

echo "*** ALL DATA ON $TGT_DISK WILL BE DESTROYED. ***"
read -rp "Type the target disk path again to confirm: " confirm
[[ "$confirm" == "$TGT_DISK" ]] || { echo "Aborted."; exit 1; }

# ── 1. Recreate the partition table, root partition extended to disk end ──────
echo "[1/6] sgdisk --zap-all $TGT_DISK && --load-backup"
sgdisk --zap-all "$TGT_DISK" >/dev/null
sgdisk --load-backup="$PART_LAYOUT" "$TGT_DISK"

# Move secondary GPT header to the end of the (possibly larger) disk.
sgdisk --move-second-header "$TGT_DISK" >/dev/null

# Read partition 3's start sector, delete it, recreate it filling the disk.
P3_START=$(sgdisk -i 3 "$TGT_DISK" \
    | awk '/First sector:/ {print $3}')
P3_TYPE=$(sgdisk -i 3 "$TGT_DISK" \
    | awk -F'[ ,]+' '/Partition GUID code/ {print $5}')
[[ -n "$P3_START" ]] || { echo "ERROR: could not read partition 3 start." >&2; exit 1; }
[[ -n "$P3_TYPE"  ]] || P3_TYPE=8300  # Linux filesystem default

echo "      partition 3 starts at sector $P3_START; resizing to end of disk."
sgdisk -d 3 "$TGT_DISK" >/dev/null
sgdisk -n "3:${P3_START}:0" -t "3:${P3_TYPE}" -c 3:"AuraSense root" "$TGT_DISK" >/dev/null

partprobe "$TGT_DISK"
sleep 1

# ── 2. Restore BIOS-boot partition ────────────────────────────────────────────
echo "[2/6] dd $BIOS_BIN → ${TGT_DISK}1"
dd if="$BIOS_BIN" of="${TGT_DISK}1" bs=1M conv=fsync status=none

# ── 3. Restore EFI System Partition ───────────────────────────────────────────
echo "[3/6] dd $EFI_BIN → ${TGT_DISK}2"
dd if="$EFI_BIN" of="${TGT_DISK}2" bs=1M conv=fsync status=none

# ── 4. Restore the ext4 root via partclone ────────────────────────────────────
echo "[4/6] zstd -dc $IMG_ZST | partclone.ext4 -r → ${TGT_DISK}3"
zstd -dc "$IMG_ZST" | partclone.ext4 -r -s - -o "${TGT_DISK}3"

# ── 5. fsck and expand the root filesystem to fill the new partition ──────────
echo "[5/6] e2fsck -fy ${TGT_DISK}3"
e2fsck -fy "${TGT_DISK}3"

echo "[6/6] resize2fs ${TGT_DISK}3 (fill new partition)"
resize2fs "${TGT_DISK}3"

# Final sanity: fsck clean after resize.
e2fsck -fy "${TGT_DISK}3"

echo ""
echo "==> Restore complete."
lsblk "$TGT_DISK"
echo ""
echo "Next steps:"
echo "  1. Remove the live USB and reboot into the new system."
echo "  2. Log in as 'aura' (use the source box's password)."
echo "  3. Run: sudo bash /home/aura/Documents/aurasense/deploy/firstboot.sh"
