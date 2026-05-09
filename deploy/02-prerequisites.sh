#!/usr/bin/env bash
# Phase 02 — Install all dependencies
# Python 3.11, Node.js 20, Redis, FFmpeg, cage (Wayland kiosk), Chromium, build tools.

set -euo pipefail

echo "[02-prerequisites] Installing dependencies..."

# ── Python 3.11 via deadsnakes PPA ────────────────────────────────────────────
echo "[02-prerequisites] Adding deadsnakes PPA for Python 3.11..."
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq software-properties-common
add-apt-repository -y ppa:deadsnakes/ppa
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    python3.11 python3.11-venv python3.11-dev

# ── Node.js 20 LTS ────────────────────────────────────────────────────────────
echo "[02-prerequisites] Installing Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs

# ── Core tools ────────────────────────────────────────────────────────────────
echo "[02-prerequisites] Installing core packages..."
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    ffmpeg git curl wget sqlite3 \
    build-essential python3-dev net-tools

# ── Redis ─────────────────────────────────────────────────────────────────────
echo "[02-prerequisites] Installing + hardening Redis..."
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq redis-server
# Bind Redis to localhost only
sed -i 's/^bind .*/bind 127.0.0.1 ::1/' /etc/redis/redis.conf
sed -i 's/^# protected-mode/protected-mode/' /etc/redis/redis.conf
systemctl enable --now redis-server
redis-cli ping | grep -q PONG && echo "[02-prerequisites] Redis: OK"

# ── Kiosk stack ───────────────────────────────────────────────────────────────
echo "[02-prerequisites] Installing kiosk stack (cage + Chromium)..."
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    cage wlr-randr \
    chromium-browser \
    unclutter-xfixes \
    dbus-user-session

# ── Verify ────────────────────────────────────────────────────────────────────
echo ""
echo "[02-prerequisites] Verification:"
python3.11 --version
node --version
npm --version
ffmpeg -version 2>&1 | head -1
redis-cli ping
cage --version 2>/dev/null || echo "cage installed"
chromium-browser --version 2>/dev/null || echo "chromium-browser installed"
echo ""
echo "[02-prerequisites] Done."
