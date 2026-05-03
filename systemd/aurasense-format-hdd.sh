#!/usr/bin/env bash
# AuraSense — Format recording HDD
# Called by: sudo /usr/local/bin/aurasense-format-hdd.sh
# Installed to /usr/local/bin/ by systemd/install.sh
# Sudoers rule at /etc/sudoers.d/aurasense-storage allows aura to run this without password.

set -euo pipefail

DEVICE=/dev/sdb1
MOUNT=/media/aura/recordaura
DB_PATH=/home/aura/Documents/aurasense/camera_discovery/cameras.db
RECORDINGS_DIR="${MOUNT}/recordings"
OWNER=aura

log() { echo "[aurasense-format] $*" >&2; }

# ── 1. Stop recording service ─────────────��───────────────────────────────────
log "Stopping recording service…"
systemctl stop aurasense-recording || true
sleep 2

# ── 2. Clear clips index ──────────────────────────────────────────────────────
log "Clearing clips table…"
sqlite3 "${DB_PATH}" "DELETE FROM clips;" 2>/dev/null || true

# ── 3. Unmount ────────────────────────────────────────────────────────────���───
log "Unmounting ${MOUNT}…"
if mountpoint -q "${MOUNT}"; then
    umount "${MOUNT}"
fi

# ── 4. Format ────────────────────────────────────────────────────────────��────
if [ ! -b "${DEVICE}" ]; then
    log "ERROR: ${DEVICE} not found — aborting"
    exit 1
fi

log "Formatting ${DEVICE} as ext4…"
mkfs.ext4 -F -L "recordaura" "${DEVICE}"

# ── 5. Mount ───────────────────────────────────────────────────────��──────────
log "Mounting ${DEVICE} at ${MOUNT}…"
mkdir -p "${MOUNT}"
mount "${DEVICE}" "${MOUNT}"

# ── 6. Recreate directory structure ────────────────────���─────────────────────
log "Creating recordings directory…"
mkdir -p "${RECORDINGS_DIR}"
chown -R "${OWNER}:${OWNER}" "${MOUNT}"

# ── 7. Restart recording service ──────────────────────────────���──────────────
log "Restarting recording service…"
systemctl start aurasense-recording

log "Format complete."
