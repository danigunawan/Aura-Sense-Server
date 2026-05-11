#!/usr/bin/env bash
# Phase 01 — System calibration (no reboot, no session kick)
#
# Only what AuraSense actually needs to run reliably:
#   • Disable sleep / suspend / hibernate (server must never sleep)
#   • CPU performance governor
#   • Sysctl tuning (file descriptors, network buffers, dirty-page flush)
#   • ulimits for the aura user
#   • mq-deadline I/O scheduler for spinning disks
#   • Chrony for accurate recording timestamps
#   • Disable bluetooth / avahi / cups / ModemManager
#
# Idempotent: safe to re-run.

set -euo pipefail
SENTINEL="/var/lib/aurasense-calibrated"

echo "[01-calibrate] Starting AuraSense system calibration (no reboot)..."

apt-get update -qq

# ── Disable services that aren't needed on a headless NVR ─────────────────────
echo "[01-calibrate] Disabling unnecessary services..."
for svc in bluetooth avahi-daemon ModemManager cups cups-browsed; do
    systemctl disable --now "$svc" 2>/dev/null || true
done

# ── Mask sleep targets ────────────────────────────────────────────────────────
echo "[01-calibrate] Masking sleep / suspend / hibernate targets..."
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# ── Prevent logind from suspending on lid-close / idle ────────────────────────
# Drop-in is picked up on next login/reboot — we deliberately do NOT restart
# systemd-logind here, because that kicks the current TTY/SSH session.
mkdir -p /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/aurasense.conf << 'CONF'
[Login]
HandleSuspendKey=ignore
HandleLidSwitch=ignore
HandleLidSwitchDocked=ignore
IdleAction=ignore
CONF

# ── CPU performance governor ───────────────────────────────────────────────────
echo "[01-calibrate] Setting CPU governor to performance..."
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cpufrequtils
echo 'GOVERNOR="performance"' > /etc/default/cpufrequtils
systemctl enable --now cpufrequtils

# ── Kernel tuning (sysctl — takes effect immediately) ─────────────────────────
echo "[01-calibrate] Writing kernel parameters..."
cat > /etc/sysctl.d/99-aurasense.conf << 'SYSCTL'
# File descriptors (32 cameras x many FFmpeg fds)
fs.file-max = 524288

# Network buffers for RTSP/HLS with many streams
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
net.ipv4.tcp_rmem = 4096 1048576 16777216
net.ipv4.tcp_wmem = 4096 1048576 16777216
net.core.netdev_max_backlog = 5000

# Prefer RAM over swap; flush dirty pages conservatively for HDD recording
vm.swappiness = 10
vm.dirty_ratio = 20
vm.dirty_background_ratio = 5
vm.dirty_expire_centisecs = 3000
vm.dirty_writeback_centisecs = 500
SYSCTL
sysctl --system -q

# ── ulimits for aura user ─────────────────────────────────────────────────────
cat > /etc/security/limits.d/aura-nvr.conf << 'LIMITS'
aura soft nofile 65536
aura hard nofile 131072
aura soft nproc  4096
aura hard nproc  4096
root soft nofile 65536
root hard nofile 131072
LIMITS

# ── HDD I/O scheduler (mq-deadline for spinning disks) ────────────────────────
cat > /etc/udev/rules.d/60-aurasense-iosched.rules << 'UDEV'
ACTION=="add|change", KERNEL=="sd[a-z]", ATTR{queue/rotational}=="1", ATTR{queue/scheduler}="mq-deadline"
UDEV
udevadm control --reload-rules && udevadm trigger

# ── NTP ───────────────────────────────────────────────────────────────────────
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq chrony
systemctl enable --now chrony

# ── Mark calibrated ───────────────────────────────────────────────────────────
mkdir -p "$(dirname "$SENTINEL")"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$SENTINEL"

echo ""
echo "[01-calibrate] Done — no reboot required."
echo "[01-calibrate] Continue with phase 02 (prerequisites)."
