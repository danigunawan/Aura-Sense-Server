#!/usr/bin/env bash
# AuraSense NVR — Full-screen kiosk launcher
# Starts the Vite dev server if not already running, then opens Chromium in kiosk mode.
# Run at boot via systemd or autostart. See QUICKSTART.md for setup instructions.

set -euo pipefail

DASHBOARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=5173
URL="http://localhost:${PORT}"

# ── 1. Start Vite dev server if not listening ──────────────────────────────────
if ! ss -tlnp 2>/dev/null | grep -q ":${PORT}"; then
  echo "[kiosk] Starting Vite dev server on port ${PORT}…"
  cd "$DASHBOARD_DIR"
  /usr/bin/npm run dev -- --port "$PORT" --host >/tmp/aurasense-vite.log 2>&1 &
  # Wait up to 15 s for Vite to bind
  for i in $(seq 1 30); do
    ss -tlnp 2>/dev/null | grep -q ":${PORT}" && break
    sleep 0.5
  done
fi

# ── 2. Locate Chromium binary (prefer snap, avoid shell wrappers) ──────────────
if [ -x /snap/bin/chromium ]; then
  BROWSER=/snap/bin/chromium
elif [ -x /usr/bin/google-chrome-stable ]; then
  BROWSER=/usr/bin/google-chrome-stable
elif [ -x /usr/bin/google-chrome ]; then
  BROWSER=/usr/bin/google-chrome
else
  echo "[kiosk] ERROR: No Chromium or Google Chrome binary found." >&2
  echo "[kiosk] Install with: snap install chromium" >&2
  exit 1
fi

echo "[kiosk] Launching: $BROWSER --kiosk $URL"

# ── 3. Launch kiosk (Wayland-native via ozone) ────────────────────────────────
exec "$BROWSER" \
  --kiosk \
  --ozone-platform=wayland \
  --enable-features=UseOzonePlatform \
  --noerrdialogs \
  --no-first-run \
  --disable-infobars \
  --disable-translate \
  --disable-features=TranslateUI,OverscrollHistoryNavigation \
  --disable-session-crashed-bubble \
  --disable-restore-session-state \
  --disable-pinch \
  --check-for-update-interval=31536000 \
  --window-position=0,0 \
  "$URL"
