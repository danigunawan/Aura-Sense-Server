#!/usr/bin/env bash
# Phase 08 — Verify all AuraSense services are healthy.
# Run after first boot and after every reboot to confirm auto-start works.

set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DEPLOY_DIR/config.sh"

PASS=0
FAIL=0

ok()   { echo "  [OK]   $1"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
warn() { echo "  [WARN] $1"; }

echo ""
echo "========================================"
echo "  AuraSense NVR — Verification"
echo "========================================"

# ── Services ──────────────────────────────────────────────────────────────────
echo ""
echo "--- Services ---"
for svc in mediamtx api discovery recording watchdog; do
    if systemctl is-active --quiet "aurasense-$svc"; then
        ok "aurasense-$svc"
    else
        fail "aurasense-$svc ($(systemctl is-active aurasense-$svc))"
        systemctl status "aurasense-$svc" --no-pager -l 2>/dev/null | tail -5 | sed 's/^/    /'
    fi
done

if systemctl is-active --quiet redis-server; then
    ok "redis-server"
else
    fail "redis-server"
fi

if systemctl is-active --quiet cloudflared; then
    ok "cloudflared"
else
    warn "cloudflared not running (run 07-cloudflare.sh to configure)"
fi

if systemctl is-active --quiet aurasense-kiosk; then
    ok "aurasense-kiosk"
else
    warn "aurasense-kiosk not running (normal if no monitor connected)"
fi

# ── API gateway ───────────────────────────────────────────────────────────────
echo ""
echo "--- API Gateway ---"
if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
    ok "API gateway responding at localhost:8000"
else
    fail "API gateway not responding at localhost:8000"
fi

# ── Dashboard served from API gateway ─────────────────────────────────────────
if curl -sf http://localhost:8000/ | grep -qi "html"; then
    ok "Dashboard served at localhost:8000"
else
    warn "Dashboard not served from localhost:8000 (check dashboard/dist/ exists)"
fi

# ── mediamtx API ──────────────────────────────────────────────────────────────
echo ""
echo "--- mediamtx ---"
if curl -sf http://127.0.0.1:9997/v3/paths/list >/dev/null 2>&1; then
    ok "mediamtx API responding at 127.0.0.1:9997"
    PATH_COUNT=$(curl -s http://127.0.0.1:9997/v3/paths/list \
        | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('items',[])))" 2>/dev/null || echo 0)
    echo "  Registered paths: $PATH_COUNT"
else
    fail "mediamtx API not responding"
fi

# ── Health file ───────────────────────────────────────────────────────────────
echo ""
echo "--- Watchdog Health ---"
if [[ -f /run/aurasense/health.json ]]; then
    ok "Health file exists: /run/aurasense/health.json"
    python3 -m json.tool /run/aurasense/health.json 2>/dev/null | sed 's/^/    /' || true
else
    fail "Health file missing (watchdog not running?)"
fi

# ── Recording HDD ─────────────────────────────────────────────────────────────
echo ""
echo "--- Recording HDD ---"
if mountpoint -q /media/aura/recordaura; then
    ok "Recording HDD mounted at /media/aura/recordaura"
    df -h /media/aura/recordaura | tail -1 | sed 's/^/  /'
    CLIP_COUNT=$(find /media/aura/recordaura/recordings -name "*.mp4" 2>/dev/null | wc -l)
    echo "  Recording files: $CLIP_COUNT MP4 segments"
else
    fail "Recording HDD not mounted at /media/aura/recordaura"
fi

# ── Network ───────────────────────────────────────────────────────────────────
echo ""
echo "--- Network ---"
INET_IP=$(ip -4 addr show "$INET_NIC" 2>/dev/null | awk '/inet /{print $2}' | head -1)
CAM_IP=$(ip -4 addr show "$CAM_NIC" 2>/dev/null | awk '/inet /{print $2}' | head -1)
if [[ -n "$INET_IP" ]]; then
    ok "Internet NIC $INET_NIC: $INET_IP"
else
    fail "Internet NIC $INET_NIC: no IP (check DHCP / cable)"
fi
if [[ -n "$CAM_IP" ]]; then
    ok "Camera NIC $CAM_NIC: $CAM_IP"
else
    warn "Camera NIC $CAM_NIC: no IP (normal if no camera cable connected yet)"
fi

# ── Redis ─────────────────────────────────────────────────────────────────────
echo ""
echo "--- Redis ---"
if redis-cli ping 2>/dev/null | grep -q PONG; then
    ok "Redis responding"
else
    fail "Redis not responding"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================"
if [[ $FAIL -eq 0 ]]; then
    echo ""
    echo "  All checks passed. System is ready."
    echo ""
    echo "  Next steps:"
    echo "    1. Connect cameras to $CAM_NIC port"
    echo "    2. Wait ~60s for camera discovery"
    echo "    3. Check: curl -s http://127.0.0.1:9997/v3/paths/list | python3 -m json.tool"
    echo "    4. Run: sudo reboot — then re-run this script to confirm auto-start"
else
    echo ""
    echo "  $FAIL check(s) failed. Review errors above."
    echo "  Logs: journalctl -u aurasense-<service> -n 50"
    exit 1
fi
