#!/usr/bin/env bash
# AuraSense — Format recording HDD
# Usage: sudo /usr/local/bin/aurasense-format-hdd.sh /dev/sdX
# Installed to /usr/local/bin/ by systemd/install.sh
# Sudoers rule at /etc/sudoers.d/aurasense-storage allows aura to run this without password.

set -euo pipefail

MOUNT=/media/aura/recordaura
DB_PATH=/home/aura/Documents/aurasense/camera_discovery/cameras.db
RECORDINGS_DIR="${MOUNT}/recordings"
OWNER=aura
FSTAB_TAG="# aurasense-recording-disk"

log() { echo "[aurasense-format] $*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# ── 0. Validate argument ──────────────────────────────────────────────────────
DISK="${1:-}"
[ -n "${DISK}" ] || die "missing device argument (e.g. /dev/sdc)"

# Whole-disk path only — refuse partitions and weird shapes.
if ! [[ "${DISK}" =~ ^/dev/(sd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$ ]]; then
    die "invalid device path: ${DISK}"
fi
[ -b "${DISK}" ] || die "${DISK} is not a block device"

# Refuse if any partition of this disk is currently a system mount.
OS_SOURCE="$(findmnt -n -o SOURCE / 2>/dev/null || true)"
OS_DISK="$(lsblk -no PKNAME "${OS_SOURCE}" 2>/dev/null || true)"
[ -n "${OS_DISK}" ] && OS_DISK="/dev/${OS_DISK}"
if [ "${DISK}" = "${OS_DISK}" ]; then
    die "refusing to format ${DISK} — it holds the OS root filesystem"
fi

# Sweep every mountpoint of every partition on this disk; reject if any
# is /, /boot, /home, /usr, /var, etc.
while IFS= read -r mp; do
    case "${mp}" in
        /|/boot|/boot/efi|/home|/usr|/var|/var/log)
            die "refusing to format ${DISK} — partition is mounted at ${mp}"
            ;;
    esac
done < <(lsblk -nrpo MOUNTPOINT "${DISK}" 2>/dev/null | sed '/^$/d')

# Partition name we'll create. NVMe / mmcblk use a "p" suffix.
case "${DISK}" in
    /dev/nvme*|/dev/mmcblk*) PART="${DISK}p1" ;;
    *)                       PART="${DISK}1"  ;;
esac

# ── 1. Stop recording service ─────────────────────────────────────────────────
log "Stopping recording service…"
systemctl stop aurasense-recording || true
sleep 2

# ── 2. Clear clips index ──────────────────────────────────────────────────────
log "Clearing clips table…"
sqlite3 "${DB_PATH}" "DELETE FROM clips;" 2>/dev/null || true

# ── 3. Unmount anything currently at the recording mount point ────────────────
if mountpoint -q "${MOUNT}"; then
    log "Unmounting current recording disk at ${MOUNT}…"
    umount "${MOUNT}" || die "could not unmount ${MOUNT}"
fi

# ── 4. Unmount any existing partitions on the target disk ────────────────────
# Unmount by device path, not mountpoint: `lsblk -r` escapes spaces as `\x20`,
# so mountpoints like `/media/aura/Ubuntu 22.04.5 LTS amd64` come back unusable.
while IFS= read -r part; do
    [ -z "${part}" ] && continue
    [ "${part}" = "${DISK}" ] && continue
    mp="$(findmnt -n -o TARGET --source "${part}" 2>/dev/null || true)"
    [ -z "${mp}" ] && continue
    log "Unmounting ${part} (at ${mp})…"
    umount "${part}" || die "could not unmount ${part}"
done < <(lsblk -nlpo NAME "${DISK}" 2>/dev/null)

# ── 5. Wipe + partition (GPT, single ext4 partition spanning the disk) ────────
log "Wiping signatures on ${DISK}…"
wipefs -a "${DISK}"

log "Creating GPT + single partition on ${DISK}…"
parted -s "${DISK}" mklabel gpt mkpart primary ext4 0% 100%

# parted can return before the kernel re-reads the partition table.
partprobe "${DISK}" || true
udevadm settle || true
for _ in 1 2 3 4 5; do
    [ -b "${PART}" ] && break
    sleep 1
done
[ -b "${PART}" ] || die "partition ${PART} did not appear after partprobe"

# ── 6. Format ─────────────────────────────────────────────────────────────────
log "Formatting ${PART} as ext4…"
mkfs.ext4 -F -L recordaura "${PART}"

# ── 7. Mount ──────────────────────────────────────────────────────────────────
log "Mounting ${PART} at ${MOUNT}…"
mkdir -p "${MOUNT}"
mount "${PART}" "${MOUNT}"

# ── 8. Recreate directory layout ──────────────────────────────────────────────
log "Creating recordings directory…"
mkdir -p "${RECORDINGS_DIR}"
chown -R "${OWNER}:${OWNER}" "${MOUNT}"

# ── 9. Refresh /etc/fstab so the disk auto-mounts on the next boot ────────────
UUID="$(blkid -s UUID -o value "${PART}" || true)"
if [ -n "${UUID}" ]; then
    log "Updating /etc/fstab (UUID=${UUID})…"
    # Remove any previous aurasense entry, plus any entry that targets our mount.
    if [ -f /etc/fstab ]; then
        sed -i.bak \
            -e "/${FSTAB_TAG}/d" \
            -e "\#[[:space:]]${MOUNT}[[:space:]]#d" \
            /etc/fstab
    fi
    printf '%s\nUUID=%s  %s  ext4  defaults,nofail,x-systemd.device-timeout=10  0  2\n' \
        "${FSTAB_TAG}" "${UUID}" "${MOUNT}" >> /etc/fstab
else
    log "WARN: could not read UUID for ${PART}; fstab not updated"
fi

# ── 10. Restart recording service ─────────────────────────────────────────────
log "Restarting recording service…"
systemctl start aurasense-recording

log "Format complete: ${DISK} → ${PART} → ${MOUNT}"
