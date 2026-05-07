import asyncio
from datetime import datetime
from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import Response

from deps import DB, User, Admin
from models import CameraDetailResponse, CameraListResponse, CameraResponse, MessageResponse, UpdateCameraRequest

router = APIRouter(prefix="/cameras", tags=["cameras"])


@router.get("", response_model=CameraListResponse)
async def list_cameras(
    db:     DB,
    _user:  User,
    page:   int = Query(1, ge=1),
    limit:  int = Query(20, ge=1, le=100),
    status: str | None = Query(None, description="Filter: online | offline | error"),
):
    """
    List all discovered cameras, newest last-seen first.
    Optionally filter by status.
    """
    offset = (page - 1) * limit

    where  = "WHERE status = ?" if status else ""
    params: list = [status, limit, offset] if status else [limit, offset]

    async with db.execute(
        f"SELECT COUNT(*) FROM cameras {where}", [status] if status else []
    ) as cur:
        total = (await cur.fetchone())[0]

    async with db.execute(
        f"""SELECT id, name, ip_address, manufacturer, model, status, last_seen
            FROM cameras {where}
            ORDER BY last_seen DESC
            LIMIT ? OFFSET ?""",
        params,
    ) as cur:
        rows = await cur.fetchall()

    items = [
        CameraResponse(
            id=r["id"],
            name=r["name"],
            ip_address=r["ip_address"],
            manufacturer=r["manufacturer"] or "",
            model=r["model"] or "",
            status=r["status"],
            last_seen=datetime.fromisoformat(r["last_seen"]),
        )
        for r in rows
    ]

    return CameraListResponse(
        items=items,
        total=total,
        page=page,
        limit=limit,
        has_more=(page * limit) < total,
    )


@router.get("/{camera_id}", response_model=CameraDetailResponse)
async def get_camera(camera_id: int, db: DB, _user: User):
    """Single camera with extended fields. RTSP URL is never returned."""
    async with db.execute(
        """SELECT id, name, ip_address, port, manufacturer, model,
                  serial_number, firmware_version, status, last_seen
           FROM cameras WHERE id = ?""",
        (camera_id,),
    ) as cur:
        row = await cur.fetchone()

    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Camera not found")

    return CameraDetailResponse(
        id=row["id"],
        name=row["name"],
        ip_address=row["ip_address"],
        port=row["port"],
        manufacturer=row["manufacturer"] or "",
        model=row["model"] or "",
        serial_number=row["serial_number"] or "",
        firmware_version=row["firmware_version"] or "",
        status=row["status"],
        last_seen=datetime.fromisoformat(row["last_seen"]),
    )


@router.patch("/{camera_id}", response_model=MessageResponse)
async def update_camera(camera_id: int, body: UpdateCameraRequest, db: DB, _user: Admin):
    """Rename a camera. Admin only."""
    async with db.execute("SELECT id FROM cameras WHERE id = ?", (camera_id,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Camera not found")

    await db.execute("UPDATE cameras SET name = ? WHERE id = ?", (body.name, camera_id))
    await db.commit()
    return MessageResponse(message=f"Camera renamed to '{body.name}'")


@router.get("/{camera_id}/snapshot")
async def get_snapshot(camera_id: int, db: DB, _user: User):
    """Grab a single JPEG frame from the camera via mediamtx's local RTSP relay."""
    async with db.execute("SELECT name, slug FROM cameras WHERE id = ?", (camera_id,)) as cur:
        cam = await cur.fetchone()
    if not cam:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Camera not found")

    # mediamtx paths are keyed on the stored slug (stable across renames).
    key = cam["slug"] or cam["name"].lower().replace(" ", "-")
    rtsp_url = f"rtsp://localhost:8554/{key}"

    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            "-rtsp_transport", "tcp",
            "-i", rtsp_url,
            "-vframes", "1",
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "pipe:1",
            "-loglevel", "quiet",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=8.0)
    except asyncio.TimeoutError:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Snapshot timed out")
    except Exception as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"Snapshot error: {e}")

    if not stdout:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "No frame captured")

    return Response(content=stdout, media_type="image/jpeg",
                    headers={"Cache-Control": "max-age=10"})


@router.delete("/{camera_id}", response_model=MessageResponse)
async def delete_camera(camera_id: int, db: DB, _user: Admin):
    """Remove a camera from the database. Admin only."""
    async with db.execute("SELECT id FROM cameras WHERE id = ?", (camera_id,)) as cur:
        if not await cur.fetchone():
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Camera not found")

    await db.execute("DELETE FROM cameras WHERE id = ?", (camera_id,))
    await db.commit()
    return MessageResponse(message="Camera deleted")
