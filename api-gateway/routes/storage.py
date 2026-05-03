"""
HDD storage status and format endpoint.

GET  /storage/hdd      Disk usage, retention estimate — all authenticated users
POST /storage/format   Wipe all recordings + reformat ext4 — admin only

The format operation delegates to a sudoers-allowed shell script so that the
API process (running as `aura`) can run mkfs and mount without a full root
shell. See systemd/aurasense-format-hdd.sh and the install notes.
"""

import asyncio
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, status

from config import config
from deps import Admin, DB

router = APIRouter(prefix="/storage", tags=["storage"])

_MOUNT       = Path("/media/aura/recordaura")
_FORMAT_SCRIPT = Path("/usr/local/bin/aurasense-format-hdd.sh")


# ── GET /storage/hdd ─────────────────────────────────────────────────────────

@router.get("/hdd")
async def hdd_status(db: DB):
    """
    Returns partition-level disk stats and recordings-specific usage.
    Queries the clips table for recordings_bytes (fast; avoids filesystem scan).
    Estimates retention from actual daily ingestion rate over the last 7 days.
    """
    if not _MOUNT.exists():
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Recording disk not mounted at /media/aura/recordaura",
        )

    try:
        usage = shutil.disk_usage(str(_MOUNT))
    except OSError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc

    # Recordings bytes from clips index (maintained by recording service)
    async with db.execute("SELECT COALESCE(SUM(size_bytes), 0) FROM clips") as cur:
        row = await cur.fetchone()
        recordings_bytes: int = row[0]

    # Clip count
    async with db.execute("SELECT COUNT(*) FROM clips") as cur:
        row = await cur.fetchone()
        clip_count: int = row[0]

    # Daily ingestion rate — average over last 7 days of actual data
    estimated_days = await _estimate_days_remaining(db, recordings_bytes, usage.total)

    return {
        "mount_point":       str(_MOUNT),
        "total_bytes":       usage.total,
        "used_bytes":        usage.used,
        "free_bytes":        usage.free,
        "recordings_bytes":  recordings_bytes,
        "clip_count":        clip_count,
        "use_percent":       round(usage.used / usage.total * 100, 1) if usage.total else 0,
        "estimated_days":    estimated_days,
        "disk_cap_bytes":    200 * 1024 * 1024 * 1024,
    }


async def _estimate_days_remaining(db, recordings_bytes: int, disk_total: int) -> float | None:
    """
    Computes estimated days of remaining capacity.
    Uses actual 7-day ingestion rate when enough data exists;
    falls back to 20 GB/day (3-camera sub-stream estimate) otherwise.
    """
    cap_bytes    = min(disk_total, 200 * 1024 * 1024 * 1024)
    remaining    = cap_bytes - recordings_bytes
    if remaining < 0:
        return 0.0
    if recordings_bytes == 0:
        return None

    # Average daily bytes from clips created in the past 7 days
    async with db.execute("""
        SELECT COALESCE(SUM(size_bytes), 0), COUNT(*)
        FROM clips
        WHERE created_at >= datetime('now', '-7 days')
    """) as cur:
        row = await cur.fetchone()
        seven_day_bytes: int = row[0]
        seven_day_count: int = row[1]

    if seven_day_bytes > 0:
        daily_bytes = seven_day_bytes / 7.0
    else:
        daily_bytes = 20 * 1024 * 1024 * 1024  # 20 GB/day static fallback

    return round(remaining / daily_bytes, 1)


# ── POST /storage/format ─────────────────────────────────────────────────────

@router.post("/format", status_code=202)
async def format_hdd(_admin: Admin):
    """
    Wipe all recordings and reformat the external HDD as ext4.
    Requires admin role.  Runs the sudoers-allowed format script synchronously;
    the script stops the recording service, formats, remounts, and restarts.
    Times out after 120 s.
    """
    if not _FORMAT_SCRIPT.exists():
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Format script not installed. Run: sudo bash systemd/install.sh",
        )

    try:
        proc = await asyncio.create_subprocess_exec(
            "sudo", str(_FORMAT_SCRIPT),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT,
            "Format timed out after 120 s",
        ) from exc
    except OSError as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            f"Could not run format script: {exc}",
        ) from exc

    if proc.returncode != 0:
        detail = stderr.decode(errors="replace").strip() or "Unknown error"
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"Format failed: {detail}")

    return {"ok": True, "message": "HDD formatted and recording service restarted"}
