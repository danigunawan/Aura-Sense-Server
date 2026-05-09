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
mkdir -p /etc/systemd/system/create-xdg-runtime.service
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
After=graphical.target aurasense-api.service create-xdg-runtime.service
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

# ── Reload systemd ────────────────────────────────────────────────────────────
systemctl daemon-reload

echo ""
echo "[05-kiosk] Done."
echo "  Kiosk will auto-start on next boot (cage → Chromium → localhost:8000)."
