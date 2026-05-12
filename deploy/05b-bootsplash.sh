#!/usr/bin/env bash
# Phase 05b — Install the AuraSense breathing-logo Plymouth boot splash.
#
# Idempotent / re-runnable. Snapshots the current initrd before rebuilding so
# a verify failure auto-reverts. Leaves the bgrt theme intact for rollback.
#
# Rollback (any time):
#   sudo update-alternatives --set default.plymouth \
#       /usr/share/plymouth/themes/bgrt/bgrt.plymouth
#   sudo update-initramfs -u

set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"

SRC="$DEPLOY_DIR/plymouth/aurasense"
DST="/usr/share/plymouth/themes/aurasense"
KVER="$(uname -r)"
INITRD="/boot/initrd.img-${KVER}"
BACKUP="${INITRD}.preauratheme"
BGRT="/usr/share/plymouth/themes/bgrt/bgrt.plymouth"

[[ $EUID -eq 0 ]] || { echo "[05b] must run as root (sudo bash $0)" >&2; exit 1; }

for f in logo.png aurasense.plymouth aurasense.script; do
    [[ -f "$SRC/$f" ]] || { echo "[05b] missing $SRC/$f" >&2; exit 1; }
done
[[ -f "$INITRD" ]] || { echo "[05b] no $INITRD" >&2; exit 1; }
[[ -f "$BGRT" ]]   || { echo "[05b] bgrt theme missing — refusing to install without a rollback path" >&2; exit 1; }

# Need a few hundred MB free in /boot for the rebuild + snapshot.
FREE_KB="$(df -P /boot | awk 'NR==2{print $4}')"
(( FREE_KB > 300000 )) || { echo "[05b] /boot low on space: ${FREE_KB} KB free" >&2; exit 1; }

echo "[05b] install theme files -> $DST"
install -d -m 755 "$DST"
install -m 644 "$SRC/logo.png"           "$DST/logo.png"
install -m 644 "$SRC/aurasense.plymouth" "$DST/aurasense.plymouth"
install -m 644 "$SRC/aurasense.script"   "$DST/aurasense.script"

echo "[05b] register theme via update-alternatives"
update-alternatives --install \
    /usr/share/plymouth/themes/default.plymouth \
    default.plymouth \
    "$DST/aurasense.plymouth" 200 >/dev/null
update-alternatives --set default.plymouth "$DST/aurasense.plymouth"

echo "[05b] snapshot current initrd -> $BACKUP"
cp -a --reflink=auto "$INITRD" "$BACKUP"

revert() {
    echo "[05b] reverting: restore initrd snapshot + point alternative back at bgrt" >&2
    cp -a --reflink=auto "$BACKUP" "$INITRD" || true
    update-alternatives --set default.plymouth "$BGRT" || true
}

echo "[05b] rebuild initramfs for $KVER"
if ! update-initramfs -u -k "$KVER"; then
    revert
    exit 1
fi

echo "[05b] verify theme files are inside the new initrd"
# Plymouth's initramfs hook copies the active theme dir into the image.
# A loose basename match is enough — lsinitramfs prints paths without leading '/'.
if ! lsinitramfs "$INITRD" | grep -Eq '(^|/)aurasense\.plymouth$'; then
    echo "[05b] aurasense.plymouth NOT found in new initrd" >&2
    revert
    exit 1
fi

echo
echo "[05b] active default.plymouth -> $(readlink -f /etc/alternatives/default.plymouth)"
echo "[05b] OK. Reboot to see the breathing logo."
echo "[05b] Snapshot of pre-change initrd is at: $BACKUP"
