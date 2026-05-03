import time
from datetime import datetime

from fastapi import APIRouter, HTTPException, status

from deps import DB, User
from models import DeviceStatusResponse, MessageResponse, SystemStatusResponse
from routes.streams import _redis

router = APIRouter(tags=["status"])

_start_time = time.time()


@router.get("/status", response_model=SystemStatusResponse)
async def system_status(db: DB, _user: User):
    """Aggregate health across all cameras plus active stream count."""
    async with db.execute(
        "SELECT status, COUNT(*) as n FROM cameras GROUP BY status"
    ) as cur:
        rows = await cur.fetchall()

    counts = {r["status"]: r["n"] for r in rows}
    total  = sum(counts.values())

    active_streams = 0
    if _redis is not None:
        try:
            keys = await _redis.keys("device:viewer-*")
            active_streams = len(keys)
        except Exception:
            pass

    return SystemStatusResponse(
        total_cameras  = total,
        online         = counts.get("online",  0),
        offline        = counts.get("offline", 0),
        error          = counts.get("error",   0),
        active_streams = active_streams,
        uptime_seconds = int(time.time() - _start_time),
    )


@router.get("/cameras/{camera_id}/status", response_model=DeviceStatusResponse)
async def camera_status(camera_id: int, db: DB, _user: User):
    """Detailed health for a single camera."""
    async with db.execute(
        """SELECT id, name, ip_address, manufacturer, model,
                  status, last_seen, last_error
           FROM cameras WHERE id = ?""",
        (camera_id,),
    ) as cur:
        row = await cur.fetchone()

    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Camera not found")

    return DeviceStatusResponse(
        camera_id    = row["id"],
        name         = row["name"],
        ip_address   = row["ip_address"],
        manufacturer = row["manufacturer"] or "",
        model        = row["model"] or "",
        status       = row["status"],
        last_seen    = datetime.fromisoformat(row["last_seen"]),
        last_error   = row["last_error"],
    )


@router.get("/health", response_model=MessageResponse, include_in_schema=False)
async def health():
    """Kubernetes/Docker liveness probe. No auth required."""
    return MessageResponse(message="ok")
