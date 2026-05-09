#!/usr/bin/env python3
"""
AuraSense NVR watchdog.

Every POLL_INTERVAL seconds:
  1. Check mediamtx API — log any path that is not ready.
  2. Check the API gateway /health endpoint — log if unreachable.
  3. Write /run/aurasense/health.json so the dashboard can surface it.

Camera paths are discovered dynamically from the mediamtx API — no hardcoded
list. Sub-streams (slug ending in -sub) are on-demand and are not monitored.

All output goes to stdout; systemd routes it to journald automatically.
Run with: journalctl -u aurasense-watchdog -f
"""

import json
import logging
import os
import signal
import sys
import time
import urllib.request
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────

POLL_INTERVAL  = 30          # seconds between health checks
MEDIAMTX_API   = "http://127.0.0.1:9997"
API_HEALTH_URL = "http://127.0.0.1:8000/health"
HEALTH_FILE    = "/run/aurasense/health.json"

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("watchdog")

# ── Helpers ───────────────────────────────────────────────────────────────────

def http_get(url: str, timeout: int = 5) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read())


def write_health(data: dict) -> None:
    os.makedirs(os.path.dirname(HEALTH_FILE), exist_ok=True)
    tmp = HEALTH_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, HEALTH_FILE)   # atomic write

# ── Checks ────────────────────────────────────────────────────────────────────

def check_mediamtx(health: dict) -> list[str]:
    """Return list of problem strings; empty means all good."""
    issues = []
    try:
        data = http_get(f"{MEDIAMTX_API}/v3/paths/list")
    except Exception as exc:
        msg = f"mediamtx API unreachable: {exc}"
        log.error(msg)
        health["mediamtx"] = "unreachable"
        return [msg]

    path_map = {p["name"]: p for p in data.get("items", [])}
    health["mediamtx"] = "ok"
    health["paths"] = {}

    # Derive monitored paths dynamically — main streams only (skip -sub and placeholder ~)
    main_paths = [n for n in path_map if not n.endswith("-sub") and n != "~"]

    if not main_paths:
        health["paths"]["_note"] = "no cameras registered yet"
        return issues

    for name in main_paths:
        ready = path_map[name].get("ready", False)
        health["paths"][name] = "ready" if ready else "not_ready"
        if not ready:
            issues.append(f"path '{name}' not ready — source may be reconnecting")

    return issues


def check_api_gateway(health: dict) -> bool:
    try:
        http_get(API_HEALTH_URL, timeout=5)
        health["api_gateway"] = "ok"
        return True
    except Exception as exc:
        log.error("api-gateway health check failed: %s", exc)
        health["api_gateway"] = "unreachable"
        return False

# ── Main loop ─────────────────────────────────────────────────────────────────

_running = True

def _handle_signal(sig, _frame):
    global _running
    log.info("received signal %d, shutting down", sig)
    _running = False

signal.signal(signal.SIGTERM, _handle_signal)
signal.signal(signal.SIGINT,  _handle_signal)


def main() -> None:
    log.info("watchdog started (poll every %ds)", POLL_INTERVAL)

    while _running:
        health: dict = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "paths": {},
        }

        # 1. mediamtx path health
        issues = check_mediamtx(health)
        for issue in issues:
            log.warning("stream issue: %s", issue)

        # 2. API gateway
        api_ok = check_api_gateway(health)

        # 3. Write health snapshot
        health["issues"] = issues
        try:
            write_health(health)
        except Exception as exc:
            log.warning("could not write health file: %s", exc)

        if not issues and api_ok:
            log.info("all streams healthy")

        time.sleep(POLL_INTERVAL)

    log.info("watchdog stopped")


if __name__ == "__main__":
    main()
