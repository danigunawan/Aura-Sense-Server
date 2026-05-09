#!/usr/bin/env bash
# AuraSense NVR — Kiosk launcher (production mode)
# Waits for the API gateway to be ready, then opens Chromium in kiosk mode.
# The API gateway serves the built React dashboard at localhost:8000.
# Run via cage Wayland compositor: cage -- /path/to/kiosk-start.sh

set -euo pipefail

URL="http://localhost:8000"

# ── 1. Wait for API gateway (up to 60 s) ──────────────────────────────────────
echo "[kiosk] Waiting for API gateway at $URL …"
for i in $(seq 1 120); do
    curl -sf "$URL/health" >/dev/null 2>&1 && break
    sleep 0.5
done
echo "[kiosk] API gateway ready."

# ── 2. Locate Chromium binary ──────────────────────────────────────────────────
if   [ -x /usr/bin/chromium-browser ];     then BROWSER=/usr/bin/chromium-browser
elif [ -x /usr/bin/chromium ];             then BROWSER=/usr/bin/chromium
elif [ -x /usr/bin/google-chrome-stable ]; then BROWSER=/usr/bin/google-chrome-stable
elif [ -x /usr/bin/google-chrome ];        then BROWSER=/usr/bin/google-chrome
elif [ -x /snap/bin/chromium ];            then BROWSER=/snap/bin/chromium
else
    echo "[kiosk] ERROR: No Chromium or Google Chrome binary found." >&2
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
    --disable-features=TranslateUI,OverscrollHistoryNavigation,VaapiVideoDecoder \
    --disable-session-crashed-bubble \
    --disable-restore-session-state \
    --disable-pinch \
    --check-for-update-interval=31536000 \
    --window-position=0,0 \
    "$URL"
