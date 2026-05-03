"""
Camera discovery trigger endpoint.

POST /discovery/scan   — kick off a one-shot scan in the background
GET  /discovery/status — return current scan state from Redis
"""

import asyncio
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, status
from redis.asyncio import Redis

from deps import Admin
from models import MessageResponse, ScanStatusResponse

router = APIRouter(prefix="/discovery", tags=["discovery"])

_redis: Redis | None = None
DISCOVERY_DIR  = Path(__file__).parents[2] / "camera_discovery"
DISCOVERY_PYTHON = DISCOVERY_DIR / ".venv" / "bin" / "python3"

_STATE_KEY = "nvr:scan:state"
_AT_KEY    = "nvr:scan:last_at"
_COUNT_KEY = "nvr:scan:last_count"


def set_redis(r: Redis) -> None:
    global _redis
    _redis = r


@router.get("/status", response_model=ScanStatusResponse)
async def scan_status(_admin: Admin):
    if _redis is None:
        return ScanStatusResponse(state="idle", last_scan=None, last_found=0)

    state = await _redis.get(_STATE_KEY) or "idle"
    last_at_raw = await _redis.get(_AT_KEY)
    last_found = int(await _redis.get(_COUNT_KEY) or 0)

    last_scan = datetime.fromisoformat(last_at_raw) if last_at_raw else None
    return ScanStatusResponse(state=state, last_scan=last_scan, last_found=last_found)


@router.post("/scan", response_model=MessageResponse, status_code=status.HTTP_202_ACCEPTED)
async def trigger_scan(background_tasks: BackgroundTasks, _admin: Admin):
    if _redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Redis unavailable")

    state = await _redis.get(_STATE_KEY)
    if state == "running":
        raise HTTPException(status.HTTP_409_CONFLICT, "Scan already in progress")

    await _redis.set(_STATE_KEY, "running", ex=180)
    background_tasks.add_task(_run_scan)
    return MessageResponse(message="Network scan started")


async def _run_scan() -> None:
    """Run camera_discovery main.py --once as a subprocess."""
    if _redis is None:
        return
    try:
        proc = await asyncio.create_subprocess_exec(
            str(DISCOVERY_PYTHON), "main.py", "--once",
            cwd=str(DISCOVERY_DIR),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        output = stdout.decode()

        if proc.returncode != 0:
            import logging
            logging.getLogger("discovery").error(
                "discovery subprocess failed (rc=%d): %s", proc.returncode, stderr.decode()[-500:]
            )
            await _redis.set(_STATE_KEY, "error", ex=3600)
            return

        # Parse "Scan complete — N new camera(s) added."
        m = re.search(r"(\d+) new camera", output)
        found = int(m.group(1)) if m else 0

        await _redis.set(_STATE_KEY, "done", ex=86400)
        await _redis.set(_AT_KEY, datetime.now(timezone.utc).isoformat(), ex=86400)
        await _redis.set(_COUNT_KEY, str(found), ex=86400)

    except asyncio.TimeoutError:
        await _redis.set(_STATE_KEY, "error", ex=3600)
    except Exception as exc:
        import logging
        logging.getLogger("discovery").error("scan task failed: %s", exc)
        await _redis.set(_STATE_KEY, "error", ex=3600)
