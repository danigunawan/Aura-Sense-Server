#!/usr/bin/env bash
# AuraSense NVR — Golden image builder
#
# Captures the source SSD as a compact, restorable bundle:
#   <out>.img.zst       — ext4 root, used blocks only (partclone + zstd -19)
#   <out>.partlayout    — GPT partition table backup (sgdisk)
#   <out>.bios.bin      — 1 MB BIOS-boot partition (sda1)
#   <out>.efi.bin       — EFI System Partition (sda2)
#
# MUST be run from a live USB session. The root filesystem cannot be
# imaged while mounted — partclone refuses, and even if it didn't, the
# image would capture in-flight sqlite writes.
#
# Usage:
#   sudo bash make-image.sh [--disk /dev/sda] [--out PATH] [--yes]

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
SRC_DISK="/dev/sda"
OUT_BASE=""
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
    case $1 in
        --disk)  SRC_DISK="$2"; shift 2 ;;
        --out)   OUT_BASE="$2"; shift 2 ;;
        --yes)   ASSUME_YES=1; shift ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

[[ -z "$OUT_BASE" ]] && OUT_BASE="./aurasense-base-$(date +%Y%m%d)"
# Strip a trailing .img.zst so other artifacts share the same base name.
OUT_BASE="${OUT_BASE%.img.zst}"

ROOT_PART="${SRC_DISK}3"
EFI_PART="${SRC_DISK}2"
BIOS_PART="${SRC_DISK}1"

# ── Pre-flight ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo "ERROR: must run as root (sudo)." >&2
    exit 1
fi

for cmd in partclone.ext4 zstd sgdisk dd e2fsck blockdev; do
    command -v "$cmd" >/dev/null 2>&1 || {
        echo "ERROR: missing required tool: $cmd" >&2
        echo "Hint: apt-get install -y partclone zstd gdisk e2fsprogs" >&2
        exit 1
    }
done

if [[ ! -b "$SRC_DISK" ]]; then
    echo "ERROR: source disk $SRC_DISK is not a block device." >&2
    exit 1
fi

# Refuse if any of the source partitions are mounted. We must be on a live USB.
if findmnt --source "$ROOT_PART" >/dev/null 2>&1 \
   || findmnt --source "$EFI_PART"  >/dev/null 2>&1; then
    echo "ERROR: $SRC_DISK partitions are mounted." >&2
    echo "Boot from an Ubuntu live USB and re-run this script." >&2
    exit 1
fi

# Sanity-check the partition layout matches what we expect.
for p in "$BIOS_PART" "$EFI_PART" "$ROOT_PART"; do
    [[ -b "$p" ]] || { echo "ERROR: $p not found." >&2; exit 1; }
done

ROOT_FS=$(blkid -o value -s TYPE "$ROOT_PART" || true)
if [[ "$ROOT_FS" != "ext4" ]]; then
    echo "ERROR: $ROOT_PART is type '$ROOT_FS', expected 'ext4'." >&2
    exit 1
fi

SRC_SIZE_BYTES=$(blockdev --getsize64 "$SRC_DISK")
SRC_SIZE_GB=$(( SRC_SIZE_BYTES / 1024 / 1024 / 1024 ))

echo ""
echo "========================================"
echo "  AuraSense — Golden image builder"
echo "========================================"
echo "  Source disk:     $SRC_DISK (${SRC_SIZE_GB} GB)"
echo "  Root partition:  $ROOT_PART (ext4)"
echo "  Output prefix:   $OUT_BASE"
echo "  Output files:"
echo "    ${OUT_BASE}.img.zst       (ext4 root, used blocks only)"
echo "    ${OUT_BASE}.partlayout    (GPT table backup)"
echo "    ${OUT_BASE}.bios.bin      (BIOS-boot partition)"
echo "    ${OUT_BASE}.efi.bin       (EFI System Partition)"
echo ""

if [[ $ASSUME_YES -ne 1 ]]; then
    read -rp "Proceed? (yes/no) " ans
    [[ "$ans" == "yes" ]] || { echo "Aborted."; exit 1; }
fi

# Ensure output directory exists.
OUT_DIR=$(dirname "$OUT_BASE")
mkdir -p "$OUT_DIR"

# ── 1. fsck the source root ───────────────────────────────────────────────────
echo "[1/5] e2fsck -fy $ROOT_PART"
e2fsck -fy "$ROOT_PART"

# ── 2. Save the GPT partition table ───────────────────────────────────────────
echo "[2/5] sgdisk --backup=${OUT_BASE}.partlayout $SRC_DISK"
sgdisk --backup="${OUT_BASE}.partlayout" "$SRC_DISK"

# ── 3. Capture the BIOS-boot partition (1 MB, may be empty on UEFI-only) ──────
echo "[3/5] dd if=$BIOS_PART of=${OUT_BASE}.bios.bin"
dd if="$BIOS_PART" of="${OUT_BASE}.bios.bin" bs=1M status=none

# ── 4. Capture the EFI System Partition ───────────────────────────────────────
echo "[4/5] dd if=$EFI_PART of=${OUT_BASE}.efi.bin"
dd if="$EFI_PART" of="${OUT_BASE}.efi.bin" bs=1M status=none

# ── 5. partclone + zstd the ext4 root (used blocks only) ──────────────────────
echo "[5/5] partclone.ext4 $ROOT_PART | zstd -T0 -19 → ${OUT_BASE}.img.zst"
partclone.ext4 -c -s "$ROOT_PART" -o - \
    | zstd -T0 -19 -o "${OUT_BASE}.img.zst"

echo ""
echo "==> Done. Artifact sizes:"
ls -lh "${OUT_BASE}.img.zst" "${OUT_BASE}.partlayout" \
       "${OUT_BASE}.bios.bin" "${OUT_BASE}.efi.bin"
echo ""
echo "Copy all four files to a USB stick. On the new box, boot from an"
echo "Ubuntu live USB and run:"
echo "  sudo bash restore-image.sh /dev/sda ${OUT_BASE}"
