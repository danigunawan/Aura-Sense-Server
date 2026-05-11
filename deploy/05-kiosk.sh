#!/usr/bin/env bash
# Phase 05 — Configure kiosk: TTY1 autologin + cage Wayland kiosk service.

set -euo pipefail

PROJECT_DIR="/home/aura/Documents/aurasense"

echo "[05-kiosk] Configuring kiosk..."

# ── TTY1 autologin for aura ───────────────────────────────────────────────────
echo "[05-kiosk] Setting up TTY1 autologin for user aura..."
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/autologin.conf << 'CONF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin aura --noclear %I $TERM
CONF

# ── Ensure XDG_RUNTIME_DIR is created on autologin ───────────────────────────
# cage needs /run/user/1000 to exist (normally created by systemd-logind on login)
cat > /etc/systemd/system/create-xdg-runtime.service << 'SVC'
[Unit]
Description=Create XDG_RUNTIME_DIR for aura kiosk session
Before=aurasense-kiosk.service
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash -c 'mkdir -p /run/user/1000 && chown aura:aura /run/user/1000 && chmod 700 /run/user/1000'

[Install]
WantedBy=multi-user.target
SVC
systemctl enable create-xdg-runtime.service

# ── Write cage-based kiosk service ────────────────────────────────────────────
# Overwrites whatever install.sh copied — cage is the correct Wayland compositor
# for headless single-app kiosk on Ubuntu 24.04 Server.
echo "[05-kiosk] Writing aurasense-kiosk.service (cage wrapper)..."
cat > /etc/systemd/system/aurasense-kiosk.service << 'SVC'
[Unit]
Description=AuraSense NVR Kiosk (cage + Chromium)
After=aurasense-api.service create-xdg-runtime.service
Wants=graphical.target create-xdg-runtime.service
PartOf=aurasense.target

[Service]
Type=simple
User=aura
Environment=XDG_RUNTIME_DIR=/run/user/1000
ExecStart=/usr/bin/cage -- /home/aura/Documents/aurasense/dashboard/kiosk-start.sh
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=0
TimeoutStopSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=aurasense-kiosk

[Install]
WantedBy=aurasense.target
SVC

# ── Make kiosk-start.sh executable ───────────────────────────────────────────
chmod +x "$PROJECT_DIR/dashboard/kiosk-start.sh"

# ── Disable GNOME screen blanking / lock (system-wide dconf default) ─────────
# cage doesn't blank, but if a tech ever logs in graphically the kiosk gets
# attached to GNOME's wayland-0 — and GNOME blanks at 5 min and locks. Setting
# system-wide dconf defaults protects every user profile, present or future.
echo "[05-kiosk] Installing dconf defaults to disable screen blanking/lock..."
mkdir -p /etc/dconf/profile /etc/dconf/db/local.d
if [ ! -f /etc/dconf/profile/user ]; then
    cat > /etc/dconf/profile/user << 'PROFILE'
user-db:user
system-db:local
PROFILE
fi
cat > /etc/dconf/db/local.d/00-aurasense-kiosk << 'DCONF'
[org/gnome/desktop/session]
idle-delay=uint32 0

[org/gnome/desktop/screensaver]
lock-enabled=false
idle-activation-enabled=false

[org/gnome/settings-daemon/plugins/power]
sleep-inactive-ac-type='nothing'
sleep-inactive-battery-type='nothing'

[org/gnome/desktop/media-handling]
automount=false
automount-open=false
autorun-never=true
DCONF
dconf update

# ── Polkit: let aura mount/unmount/eject without password ────────────────────
# Plugging in a USB or unmounting a drive from the kiosk session triggers
# udisks2 → polkit. For a disk with an ESP partition (e.g. a bootable installer
# USB being repurposed for recording) udisks2 raises filesystem-mount-system,
# which prompts for an admin password — unacceptable on a kiosk.
echo "[05-kiosk] Installing polkit rule for aurasense storage actions..."
cat > /etc/polkit-1/localauthority/50-local.d/50-aurasense-storage.pkla << 'PKLA'
[aurasense storage actions for aura]
Identity=unix-user:aura
Action=org.freedesktop.udisks2.filesystem-mount;org.freedesktop.udisks2.filesystem-mount-system;org.freedesktop.udisks2.filesystem-unmount-others;org.freedesktop.udisks2.eject-media;org.freedesktop.udisks2.power-off-drive;org.freedesktop.udisks2.modify-device
ResultAny=yes
ResultInactive=yes
ResultActive=yes
PKLA

# Apply live to the aura session if it's already up (re-runs of this script)
if [ -S /run/user/1000/bus ]; then
    sudo -u aura DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
        gsettings set org.gnome.desktop.session idle-delay 0 || true
    sudo -u aura DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
        gsettings set org.gnome.desktop.screensaver lock-enabled false || true
    sudo -u aura DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
        gsettings set org.gnome.desktop.screensaver idle-activation-enabled false || true
    sudo -u aura DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
        gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing' || true
    sudo -u aura DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
        gsettings set org.gnome.desktop.media-handling automount false || true
    sudo -u aura DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
        gsettings set org.gnome.desktop.media-handling automount-open false || true
fi

# ── Reload systemd ────────────────────────────────────────────────────────────
systemctl daemon-reload

echo ""
echo "[05-kiosk] Done."
echo "  Kiosk will auto-start on next boot (cage → Chromium → localhost:8000)."
