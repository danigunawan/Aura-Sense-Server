"""
HDD storage status and format endpoint.

GET  /storage/hdd                Disk usage of the active recording mount
GET  /storage/devices            All connected block devices (OS disk excluded)
GET  /storage/recording-status   Live recording health from on-disk segment mtimes
POST /storage/format             Wipe + reformat a chosen device as ext4 — admin only

The format operation delegates to a sudoers-allowed shell script so that the
API process (running as `aura`) can run mkfs and mount without a full root
shell. See systemd/aurasense-format-hdd.sh and the install notes.
"""

import asyncio
import json
import os
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from config import config
from deps import Admin, DB

router = APIRouter(prefix="/storage", tags=["storage"])

_MOUNT          = Path("/media/aura/recordaura")
_RECORDINGS_DIR = _MOUNT / "recordings"
_FORMAT_SCRIPT  = Path("/usr/local/bin/aurasense-format-hdd.sh")

# A segment is ~60 s; allow 2× plus a bit for restart jitter before we
# call a camera "not recording".
_HEALTH_WINDOW_SECS = 150

# Mount points that flag a disk as the OS disk — refuse to list/format.
_PROTECTED_MOUNTS = {"/", "/boot", "/boot/efi", "/home", "/usr", "/var", "/var/log"}

# Allowed device-path shapes for the format endpoint.
_DEVICE_RE = re.compile(r"^/dev/(sd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$")


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


# ── GET /storage/devices ─────────────────────────────────────────────────────

@router.get("/devices")
async def list_devices():
    """
    Enumerates all block devices except the one hosting the OS.
    Used by the Settings page to let an admin pick a disk to format.
    """
    try:
        tree = _run_lsblk()
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            f"Could not enumerate block devices: {exc}",
        )

    protected = _protected_disk_paths(tree)
    devices = []
    for disk in tree.get("blockdevices", []):
        if disk.get("type") != "disk":
            continue
        path = disk.get("path") or f"/dev/{disk['name']}"
        if path in protected:
            continue
        devices.append(_describe_disk(disk, path))

    return {
        "os_disk_paths":     sorted(protected),
        "recording_mount":   str(_MOUNT),
        "devices":           devices,
    }


def _run_lsblk() -> dict:
    """Returns lsblk JSON output. Uses bytes for sizes."""
    proc = subprocess.run(
        [
            "lsblk", "-J", "-b",
            "-o", "NAME,PATH,SIZE,MODEL,SERIAL,TYPE,FSTYPE,MOUNTPOINT,MOUNTPOINTS,"
                  "LABEL,UUID,ROTA,TRAN,VENDOR",
        ],
        capture_output=True, text=True, check=True, timeout=10,
    )
    return json.loads(proc.stdout)


def _node_mountpoints(node: dict) -> list[str]:
    """Handle both old (mountpoint) and new (mountpoints) lsblk schemas."""
    mps = node.get("mountpoints")
    if isinstance(mps, list):
        return [m for m in mps if m]
    mp = node.get("mountpoint")
    return [mp] if mp else []


def _protected_disk_paths(tree: dict) -> set[str]:
    """Disks whose any descendant is mounted at a system path."""
    protected: set[str] = set()

    def walk(node: dict, root_path: str):
        for mp in _node_mountpoints(node):
            if mp in _PROTECTED_MOUNTS or mp.startswith("/boot"):
                protected.add(root_path)
        for child in node.get("children", []) or []:
            walk(child, root_path)

    for disk in tree.get("blockdevices", []):
        if disk.get("type") != "disk":
            continue
        path = disk.get("path") or f"/dev/{disk['name']}"
        walk(disk, path)
    return protected


def _describe_disk(disk: dict, path: str) -> dict:
    """Flatten one lsblk disk node into the response shape."""
    partitions = []
    is_recording_disk = False
    for child in disk.get("children", []) or []:
        if child.get("type") != "part":
            continue
        mps = _node_mountpoints(child)
        mount = mps[0] if mps else None
        if mount == str(_MOUNT):
            is_recording_disk = True
        partitions.append({
            "path":        child.get("path") or f"/dev/{child['name']}",
            "size_bytes":  int(child.get("size") or 0),
            "fstype":      child.get("fstype"),
            "label":       child.get("label"),
            "uuid":        child.get("uuid"),
            "mountpoint":  mount,
        })

    return {
        "path":              path,
        "size_bytes":        int(disk.get("size") or 0),
        "model":             (disk.get("model") or "").strip() or None,
        "vendor":            (disk.get("vendor") or "").strip() or None,
        "serial":            disk.get("serial"),
        "transport":         disk.get("tran"),         # sata, usb, nvme, …
        "rotational":        disk.get("rota"),
        "partitions":        partitions,
        "is_recording_disk": is_recording_disk,
    }


# ── GET /storage/recording-status ────────────────────────────────────────────

@router.get("/recording-status")
async def recording_status(db: DB):
    """
    Live recording health derived from segment mtimes on disk.
    A camera is "active" if its newest *.mp4 was modified within the
    health window (≈2× segment length).
    """
    mount_healthy = _MOUNT.is_mount() if hasattr(Path, "is_mount") else _is_mount_point(_MOUNT)
    if not mount_healthy:
        return {
            "is_recording":             False,
            "mount_healthy":            False,
            "mount_point":              str(_MOUNT),
            "reason":                   "Recording drive not mounted",
            "last_segment_at":          None,
            "seconds_since_last_write": None,
            "cameras":                  [],
        }

    try:
        free_bytes = shutil.disk_usage(str(_MOUNT)).free
    except OSError:
        free_bytes = None

    # Camera name lookup so the UI can show friendly labels next to slugs.
    name_by_slug: dict[str, str] = {}
    try:
        async with db.execute("SELECT slug, name FROM cameras") as cur:
            async for row in cur:
                name_by_slug[row[0]] = row[1]
    except Exception:
        pass  # cameras table may be empty / not yet created

    now = time.time()
    newest_overall = 0.0
    cameras = []

    if _RECORDINGS_DIR.is_dir():
        for cam_dir in sorted(_RECORDINGS_DIR.iterdir()):
            if not cam_dir.is_dir():
                continue
            newest = _newest_mtime(cam_dir)
            if newest is None:
                continue
            newest_overall = max(newest_overall, newest)
            cameras.append({
                "slug":             cam_dir.name,
                "name":             name_by_slug.get(cam_dir.name) or cam_dir.name,
                "last_segment_at":  _iso(newest),
                "seconds_since":    int(now - newest),
                "active":           (now - newest) <= _HEALTH_WINDOW_SECS,
            })

    seconds_since = int(now - newest_overall) if newest_overall else None
    is_recording  = bool(newest_overall) and seconds_since is not None and seconds_since <= _HEALTH_WINDOW_SECS

    reason = None
    if not cameras:
        reason = "No camera recording directories on disk yet"
    elif not is_recording:
        reason = f"No new segments written in the last {seconds_since}s"

    return {
        "is_recording":              is_recording,
        "mount_healthy":             True,
        "mount_point":               str(_MOUNT),
        "free_bytes":                free_bytes,
        "last_segment_at":           _iso(newest_overall) if newest_overall else None,
        "seconds_since_last_write":  seconds_since,
        "health_window_secs":        _HEALTH_WINDOW_SECS,
        "cameras":                   cameras,
        "reason":                    reason,
    }


def _newest_mtime(directory: Path) -> float | None:
    """Return the largest mtime (epoch seconds) of any *.mp4 in `directory`, or None."""
    newest = 0.0
    try:
        with os.scandir(directory) as it:
            for entry in it:
                if not entry.is_file(follow_symlinks=False):
                    continue
                if not entry.name.endswith(".mp4"):
                    continue
                try:
                    m = entry.stat().st_mtime
                except OSError:
                    continue
                if m > newest:
                    newest = m
    except OSError:
        return None
    return newest or None


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")


def _is_mount_point(p: Path) -> bool:
    """Fallback when Path.is_mount() isn't available."""
    try:
        return p.exists() and p.stat().st_dev != p.parent.stat().st_dev
    except OSError:
        return False


# ── POST /storage/format ─────────────────────────────────────────────────────

class FormatRequest(BaseModel):
    device: str = Field(..., description="Whole-disk path, e.g. /dev/sdc")


@router.post("/format", status_code=202)
async def format_hdd(req: FormatRequest, _admin: Admin):
    """
    Wipe and reformat the chosen external disk as ext4, mount it at
    /media/aura/recordaura, and restart the recording service.
    Requires admin role. The format script revalidates the device and
    refuses to touch any disk holding a system mount.
    """
    if not _FORMAT_SCRIPT.exists():
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "Format script not installed. Run: sudo bash systemd/install.sh",
        )

    device = req.device.strip()
    if not _DEVICE_RE.match(device):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Invalid device path: {device!r}",
        )

    # Refuse OS disks at the API layer too (defence in depth — the script also checks).
    try:
        tree = _run_lsblk()
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            f"Could not enumerate block devices: {exc}",
        )
    if device in _protected_disk_paths(tree):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Refusing to format {device}: holds a system mount",
        )

    try:
        proc = await asyncio.create_subprocess_exec(
            "sudo", str(_FORMAT_SCRIPT), device,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=180)
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status.HTTP_504_GATEWAY_TIMEOUT,
            "Format timed out after 180 s",
        ) from exc
    except OSError as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            f"Could not run format script: {exc}",
        ) from exc

    if proc.returncode != 0:
        detail = stderr.decode(errors="replace").strip() or "Unknown error"
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, f"Format failed: {detail}")

    return {"ok": True, "device": device, "message": "HDD formatted and recording service restarted"}
