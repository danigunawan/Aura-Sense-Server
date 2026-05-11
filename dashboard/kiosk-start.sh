#!/usr/bin/env bash
# AuraSense NVR — Kiosk launcher (production mode)
# Waits for the API gateway to be ready, then opens Chromium in kiosk mode.
# The API gateway serves the built React dashboard at localhost:8000.
# Run via cage Wayland compositor: cage -- /path/to/kiosk-start.sh

set -euo pipefail

URL="http://localhost:8000"

# ── 1. Wait for Wayland session socket ───────────────────────────────────────
# On boot this service can win the race against GDM creating the user-1000
# GNOME Wayland session — Chromium then fails with "Failed to connect to
# Wayland display" and systemd has to restart us. Block until the socket is
# there so the first launch attempt sticks.
WAYLAND_SOCK="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/${WAYLAND_DISPLAY:-wayland-0}"
echo "[kiosk] Waiting for Wayland socket at $WAYLAND_SOCK …"
for i in $(seq 1 120); do
    [ -S "$WAYLAND_SOCK" ] && break
    sleep 0.5
done
if [ ! -S "$WAYLAND_SOCK" ]; then
    echo "[kiosk] ERROR: Wayland socket not present after 60 s." >&2
    exit 1
fi
echo "[kiosk] Wayland socket ready."

# ── 2. Wait for API gateway (up to 180 s on cold boot) ───────────────────────
# Cold boot path: aurasense-api may still be importing Python deps / running
# DB + Redis init when systemd already considers it "active". If we launch
# Chrome before uvicorn is listening, it lands on the chrome-error page (looks
# white on a kiosk). Fail hard if the API never comes up so Restart=on-failure
# in the unit file actually re-tries us.
echo "[kiosk] Waiting for API gateway at $URL …"
api_ready=0
for i in $(seq 1 360); do
    if curl -sf "$URL/health" >/dev/null 2>&1; then
        api_ready=1
        break
    fi
    sleep 0.5
done
if [ "$api_ready" -ne 1 ]; then
    echo "[kiosk] ERROR: API gateway did not respond at $URL/health after 180 s." >&2
    exit 1
fi
echo "[kiosk] API gateway ready."

# ── 3. Locate Chromium binary ──────────────────────────────────────────────────
# Native Google Chrome is preferred — snap-packaged Chromium can't bind VAAPI
# to /dev/dri reliably, so HW video decode silently falls back to software.
if   [ -x /usr/bin/google-chrome-stable ]; then BROWSER=/usr/bin/google-chrome-stable
elif [ -x /usr/bin/google-chrome ];        then BROWSER=/usr/bin/google-chrome
elif [ -x /usr/bin/chromium-browser ];     then BROWSER=/usr/bin/chromium-browser
elif [ -x /usr/bin/chromium ];             then BROWSER=/usr/bin/chromium
elif [ -x /snap/bin/chromium ];            then BROWSER=/snap/bin/chromium
else
    echo "[kiosk] ERROR: No Chromium or Google Chrome binary found." >&2
    exit 1
fi

echo "[kiosk] Launching: $BROWSER --kiosk $URL"

# ── 4. Launch kiosk (Wayland-native via ozone) ────────────────────────────────
exec "$BROWSER" \
    --kiosk \
    --ozone-platform=wayland \
    --noerrdialogs \
    --no-first-run \
    --disable-infobars \
    --disable-translate \
    --password-store=basic \
    --use-mock-keychain \
    --enable-features=UseOzonePlatform \
    --disable-features=Vulkan,TranslateUI,OverscrollHistoryNavigation,UseChromeOSDirectVideoDecoder \
    --use-angle=gl \
    --disable-session-crashed-bubble \
    --disable-restore-session-state \
    --disable-pinch \
    --check-for-update-interval=31536000 \
    --window-position=0,0 \
    "$URL"
