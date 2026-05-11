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

# ── 4. Ephemeral Chrome profile on tmpfs ───────────────────────────────────────
# A persistent profile accumulates encrypted state (Account Web Data, Login Data
# For Account, Cookies) under whatever password store was in effect when it was
# written. We run with --password-store=basic + --use-mock-keychain, so any
# state written under the real keyring becomes undecryptable on the next boot.
# The network service hits one of those decrypt failures during init and exits;
# Chrome restarts the network service but the renderer's in-flight JS bundle
# fetch is silently dropped, leaving an empty <div id="root"> — i.e. a white
# screen with no recovery. Wiping the profile each boot eliminates the trigger.
PROFILE_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/aurasense-kiosk-profile"
rm -rf "$PROFILE_DIR"
mkdir -p "$PROFILE_DIR"

# ── 5. Force libva to skip the failing iHD probe ──────────────────────────────
# Haswell systems have intel-media-va-driver installed but the iHD driver needs
# VAAPI 1.17; jammy ships 1.14 → libva logs an init failure then falls back to
# i965. The fallback works, but the error is noise that confuses triage. Force
# i965 directly so the GPU-process journal stays clean.
export LIBVA_DRIVER_NAME=i965

# ── 6. White-screen watchdog ──────────────────────────────────────────────────
# Belt-and-braces: even with an ephemeral profile, any future Chrome regression
# that drops the network service during initial asset fetch produces the same
# unrecoverable white screen. Detect it by watching for a Chrome → :8000 TCP
# connection. In a healthy boot Chrome opens one within a couple of seconds; if
# no connection appears within ~40 s the page did not load — kill Chrome so
# Restart=on-failure respawns us with a fresh profile.
(
    sleep 8
    start=$SECONDS
    while [ $((SECONDS - start)) -lt 32 ]; do
        if ss -tnp 2>/dev/null | grep '"chrome"' | grep -qE '127\.0\.0\.1:8000|\[::1\]:8000'; then
            exit 0
        fi
        sleep 3
    done
    echo "[kiosk-watchdog] Chrome did not connect to API within 40 s — restarting kiosk." >&2
    pkill -TERM -f 'google-chrome.*--kiosk' || true
) &

echo "[kiosk] Launching: $BROWSER --kiosk $URL"

# ── 7. Launch kiosk (Wayland-native via ozone) ────────────────────────────────
exec "$BROWSER" \
    --kiosk \
    --ozone-platform=wayland \
    --noerrdialogs \
    --no-first-run \
    --disable-infobars \
    --disable-translate \
    --user-data-dir="$PROFILE_DIR" \
    --password-store=basic \
    --use-mock-keychain \
    --disable-sync \
    --enable-features=UseOzonePlatform \
    --disable-features=Vulkan,TranslateUI,OverscrollHistoryNavigation,UseChromeOSDirectVideoDecoder \
    --use-angle=gl \
    --disable-session-crashed-bubble \
    --disable-restore-session-state \
    --disable-pinch \
    --check-for-update-interval=31536000 \
    --window-position=0,0 \
    "$URL"
