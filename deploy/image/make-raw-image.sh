#!/usr/bin/env bash
# Capture an Etcher-flashable raw disk image of the source NVR.
#
# Run from a LIVE USB session — never from the installed OS.
# Output is a single .img.xz that Etcher / Rufus / dd will flash
# byte-for-byte onto a fresh disk.
#
# Every clone produced this way is byte-identical to the source:
#   - same machine-id, same SSH host keys, same hostname
#   - same .env secrets, same Cloudflare cert, same cameras.db
#   - target disk size must be >= source disk size
#
# If you need per-customer customization on first boot of the clone,
# use make-image.sh + firstboot.sh instead.

set -euo pipefail

SRC_DISK="/dev/sda"
OUT_PATH=""
ZERO_FREE=1
COMPRESS_LEVEL=6
APT_OK=1

usage() {
    cat <<'USAGE'
Usage: sudo bash make-raw-image.sh --out <path> [options]

  --out      <file>    Output .img.xz path (REQUIRED, must be on external storage)
  --source   <disk>    Source disk to image (default: /dev/sda)
  --level    <0-9>     xz compression level 0..9 (default: 6)
  --no-zero            Skip the zerofree pre-pass (faster, but image is bigger)
  --no-apt             Don't auto-install missing tools, just fail
  -h, --help

Example:
  sudo bash make-raw-image.sh \
       --source /dev/sda \
       --out    /mnt/usb/aurasense-$(date +%Y%m%d).img.xz
USAGE
}

while (( $# )); do
    case "$1" in
        --source)   SRC_DISK="$2"; shift 2 ;;
        --out)      OUT_PATH="$2"; shift 2 ;;
        --level)    COMPRESS_LEVEL="$2"; shift 2 ;;
        --no-zero)  ZERO_FREE=0; shift ;;
        --no-apt)   APT_OK=0; shift ;;
        -h|--help)  usage; exit 0 ;;
        *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
    esac
done

[[ $EUID -eq 0 ]] || { echo "must run as root (sudo)" >&2; exit 1; }
[[ -n "$OUT_PATH" ]] || { usage >&2; exit 2; }
[[ -b "$SRC_DISK" ]] || { echo "$SRC_DISK is not a block device" >&2; exit 1; }

# ── refuse to image a disk that has any mounted partition ────────────────────
# This catches the most likely operator error: running on the installed OS
# instead of from a live USB. dd'ing a mounted, actively-written disk would
# produce a corrupt image.
MOUNTED="$(lsblk -nro MOUNTPOINT "$SRC_DISK" | grep -vE '^[[:space:]]*$' || true)"
if [[ -n "$MOUNTED" ]]; then
    echo "ERROR: $SRC_DISK has mounted partition(s):" >&2
    lsblk "$SRC_DISK" >&2
    echo "Boot from an Ubuntu live USB and re-run this script there." >&2
    exit 1
fi

# ── refuse to write the image onto the source itself ─────────────────────────
OUT_REAL="$(readlink -f "$OUT_PATH" 2>/dev/null || echo "$OUT_PATH")"
OUT_DEV="$(df -P "$(dirname "$OUT_PATH")" | awk 'NR==2{print $1}')"
SRC_PARTS="$(lsblk -nlpo NAME "$SRC_DISK")"
for p in $SRC_PARTS; do
    if [[ "$OUT_DEV" == "$p" ]]; then
        echo "ERROR: output path $OUT_PATH is on $OUT_DEV which is part of source $SRC_DISK." >&2
        echo "Plug in a separate USB drive for the output." >&2
        exit 1
    fi
done

# ── ensure tools ─────────────────────────────────────────────────────────────
MISSING=()
for cmd in xz pv blockdev sha256sum lsblk; do
    command -v "$cmd" >/dev/null || MISSING+=("$cmd")
done
(( ZERO_FREE )) && ! command -v zerofree >/dev/null && MISSING+=("zerofree")

if (( ${#MISSING[@]} )); then
    if (( APT_OK )); then
        echo "installing: ${MISSING[*]}"
        apt-get update -qq
        # zerofree is in package 'zerofree'; xz in 'xz-utils'; pv in 'pv'
        apt-get install -y -qq xz-utils pv zerofree util-linux coreutils
    else
        echo "missing tools (and --no-apt): ${MISSING[*]}" >&2
        exit 1
    fi
fi

# ── space sanity ─────────────────────────────────────────────────────────────
SRC_BYTES=$(blockdev --getsize64 "$SRC_DISK")
SRC_GB=$(( SRC_BYTES / 1024 / 1024 / 1024 ))
OUT_DIR="$(dirname "$OUT_PATH")"
mkdir -p "$OUT_DIR"
AVAIL_BYTES=$(df -B1 --output=avail "$OUT_DIR" | tail -1)
AVAIL_GB=$(( AVAIL_BYTES / 1024 / 1024 / 1024 ))

# After zerofree + xz, expect 5-15% of source size for a typical aurasense
# NVR (~16 GB used on a 425 GB partition).  Demand ~20% headroom.
NEED_GB=$(( SRC_GB / 5 + 2 ))

echo "------------------------------------------------------------"
echo "  source:      $SRC_DISK   ($SRC_GB GB)"
echo "  output:      $OUT_PATH"
echo "  output free: ${AVAIL_GB} GB   (rough need: ${NEED_GB} GB)"
echo "  xz level:    $COMPRESS_LEVEL"
echo "  zerofree:    $( ((ZERO_FREE)) && echo yes || echo no )"
echo "------------------------------------------------------------"

if (( AVAIL_GB < NEED_GB )); then
    echo "WARNING: output drive only has ${AVAIL_GB} GB free." >&2
    read -rp "Continue anyway? [y/N] " a
    [[ "${a,,}" == "y" ]] || exit 1
fi

read -rp "Proceed? [y/N] " a
[[ "${a,,}" == "y" ]] || { echo "aborted"; exit 0; }

# ── zero free space so xz compresses well ────────────────────────────────────
# zerofree walks the ext4 free-block bitmap and writes zeros over every
# unallocated block.  Without this, xz has to compress whatever random
# garbage was left from deleted files — usually 10x worse compression.
if (( ZERO_FREE )); then
    while read -r name fstype; do
        [[ "$fstype" == "ext4" ]] || continue
        p="/dev/$name"
        echo "[zerofree] $p"
        zerofree -v "$p" || echo "WARN: zerofree on $p failed; continuing"
    done < <(lsblk -nro NAME,FSTYPE "$SRC_DISK" | awk 'NR>1 && $2!=""')
fi

# ── do it ────────────────────────────────────────────────────────────────────
echo
echo "imaging $SRC_DISK -> $OUT_PATH"
echo "this will take a long time (disk-bound; ~SRC_BYTES / disk read rate)"
START=$(date +%s)

# dd reads the disk; pv shows progress; xz compresses with all cores.
# bs=4M is a good balance for spinning disks AND SSDs.
# We use status=none on dd since pv handles progress.
dd if="$SRC_DISK" bs=4M status=none | \
    pv -s "$SRC_BYTES" -p -t -e -r -b | \
    xz -T0 -"${COMPRESS_LEVEL}" -c > "$OUT_PATH"

DURATION=$(( $(date +%s) - START ))
OUT_BYTES=$(stat -c %s "$OUT_PATH")
OUT_MB=$(( OUT_BYTES / 1024 / 1024 ))

echo
echo "done in $((DURATION/60))m $((DURATION%60))s   |   compressed size: ${OUT_MB} MB"

# ── checksum sidecar ─────────────────────────────────────────────────────────
echo "computing sha256..."
( cd "$OUT_DIR" && sha256sum "$(basename "$OUT_PATH")" > "$(basename "$OUT_PATH").sha256" )

cat <<DONE

------------------------------------------------------------
  Done. Bundle contents:
    $OUT_PATH
    ${OUT_PATH}.sha256
------------------------------------------------------------

  Flash with Etcher / Rufus / dd:
    1.  Open balenaEtcher (or Rufus, or 'sudo dd if=$OUT_PATH | xz -d | dd of=/dev/sdX bs=4M').
    2.  Select '$OUT_PATH' as the source.
    3.  Select the target disk (must be >= ${SRC_GB} GB).
    4.  Flash.  Power off, drop the flashed disk into the target box, boot.

  WARNING: every clone shares the source's SSH host keys, machine-id,
  /etc/.env secrets, and Cloudflare tunnel cert.  Use for short-lived
  clones or rotate secrets manually after first boot.
DONE
