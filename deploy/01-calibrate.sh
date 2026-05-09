#!/usr/bin/env bash
# Phase 01 — System calibration
# Intel microcode, governor, disable sleep, kernel tuning, ulimits, NTP, auto-updates.
# Ends with a reboot (required for microcode).

set -euo pipefail

echo "[01-calibrate] Starting system calibration..."

# ── Update + Intel microcode ───────────────────────────────────────────────────
echo "[01-calibrate] Updating packages + installing Intel microcode..."
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get full-upgrade -y -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq intel-microcode iucode-tool
update-grub -q

# ── Disable unnecessary services ──────────────────────────────────────────────
echo "[01-calibrate] Disabling unnecessary services..."
for svc in bluetooth avahi-daemon ModemManager cups cups-browsed; do
    systemctl disable --now "$svc" 2>/dev/null || true
done

# ── Mask sleep targets ────────────────────────────────────────────────────────
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# ── Prevent logind from suspending ────────────────────────────────────────────
mkdir -p /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/aurasense.conf << 'CONF'
[Login]
HandleSuspendKey=ignore
HandleLidSwitch=ignore
HandleLidSwitchDocked=ignore
IdleAction=ignore
CONF
systemctl restart systemd-logind

# ── Purge snapd ───────────────────────────────────────────────────────────────
echo "[01-calibrate] Removing snapd..."
DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq snapd 2>/dev/null || true
apt-mark hold snapd 2>/dev/null || true
rm -rf /snap /var/snap /var/lib/snapd /var/cache/snapd

# ── CPU performance governor ───────────────────────────────────────────────────
echo "[01-calibrate] Setting CPU governor to performance..."
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cpufrequtils
echo 'GOVERNOR="performance"' > /etc/default/cpufrequtils
systemctl enable --now cpufrequtils

# ── Kernel tuning ─────────────────────────────────────────────────────────────
echo "[01-calibrate] Writing kernel parameters..."
cat > /etc/sysctl.d/99-aurasense.conf << 'SYSCTL'
# File descriptors (32 cameras x many FFmpeg fds)
fs.file-max = 524288
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 512

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

# ── ulimits for aura user ──────────────────────────────────────────────────────
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

# ── noatime on all ext4 mounts ────────────────────────────────────────────────
echo "[01-calibrate] Adding noatime to fstab ext4 entries..."
# Only add noatime if not already present
sed -i '/ext4/ { /noatime/! s/defaults/defaults,noatime/ }' /etc/fstab
mount -o remount,noatime / 2>/dev/null || true
mount -o remount,noatime /var 2>/dev/null || true
mount -o remount,noatime /home 2>/dev/null || true

# ── NTP ───────────────────────────────────────────────────────────────────────
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq chrony
systemctl enable --now chrony

# ── Unattended security upgrades (no auto-reboot) ─────────────────────────────
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades
# Configure: security updates only, no auto-reboot
cat > /etc/apt/apt.conf.d/52aurasense-upgrades << 'APT'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::MinimalSteps "true";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "false";
Unattended-Upgrade::Automatic-Reboot "false";
APT
systemctl enable --now unattended-upgrades

echo ""
echo "[01-calibrate] Done. Rebooting in 5 seconds to apply microcode + governor..."
sleep 5
reboot
