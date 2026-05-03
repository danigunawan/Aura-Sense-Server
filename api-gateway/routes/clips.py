"""
Playback / clip access.

Clips are recorded as 5-minute MP4 segments by the Recording Service and
indexed into the `clips` table by the Storage Manager.  This router is
read-only on that table.

Download URLs are HMAC-signed with a 1-hour expiry so the mobile app can
fetch files without a separate auth header (useful for <video> src= tags).
"""

import os
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import FileResponse

import auth
from deps import DB, User
from models import ClipListResponse, ClipResponse

router = APIRouter(tags=["clips"])


# ── Helpers ───────────────────────────────────────────────────────────────────

def _signed_url(request: Request, clip_id: int) -> str:
    sig, exp = auth.sign_clip_url(clip_id, ttl_seconds=3600)
    base = str(request.base_url).rstrip("/")
    return f"{base}/clips/{clip_id}/download?sig={sig}&exp={exp}"


def _to_clip(row, camera_name: str, download_url: str) -> ClipResponse:
    start = datetime.fromisoformat(row["start_time"])
    end   = datetime.fromisoformat(row["end_time"])
    return ClipResponse(
        id               = row["id"],
        camera_id        = row["camera_id"],
        camera_name      = camera_name,
        start_time       = start,
        end_time         = end,
        duration_seconds = (end - start).total_seconds(),
        size_bytes       = row["size_bytes"],
        download_url     = download_url,
    )


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/cameras/{camera_id}/clips", response_model=ClipListResponse)
async def list_clips(
    camera_id: int,
    request:   Request,
    db:        DB,
    _user:     User,
    from_time: datetime | None = Query(None, alias="from", description="ISO 8601 start filter"),
    to_time:   datetime | None = Query(None, alias="to",   description="ISO 8601 end filter"),
    page:      int = Query(1, ge=1),
    limit:     int = Query(20, ge=1, le=1440),
):
    """
    Paginated clip list for a camera, newest first.
    Optionally filter by time range with ?from= and ?to= (ISO 8601).
    """
    # Verify camera exists
    async with db.execute("SELECT name FROM cameras WHERE id = ?", (camera_id,)) as cur:
        cam = await cur.fetchone()
    if not cam:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Camera not found")

    camera_name = cam["name"]
    offset      = (page - 1) * limit

    # Build dynamic WHERE clause
    conditions = ["camera_id = ?"]
    params: list = [camera_id]

    if from_time:
        conditions.append("end_time >= ?")
        params.append(from_time.isoformat())
    if to_time:
        conditions.append("start_time <= ?")
        params.append(to_time.isoformat())

    where = "WHERE " + " AND ".join(conditions)

    async with db.execute(f"SELECT COUNT(*) FROM clips {where}", params) as cur:
        total = (await cur.fetchone())[0]

    async with db.execute(
        f"""SELECT id, camera_id, path, start_time, end_time, size_bytes
            FROM clips {where}
            ORDER BY start_time DESC
            LIMIT ? OFFSET ?""",
        params + [limit, offset],
    ) as cur:
        rows = await cur.fetchall()

    items = [_to_clip(r, camera_name, _signed_url(request, r["id"])) for r in rows]

    return ClipListResponse(
        items    = items,
        total    = total,
        page     = page,
        limit    = limit,
        has_more = (page * limit) < total,
    )


@router.get("/clips/{clip_id}/download")
async def download_clip(
    clip_id: int,
    sig:     str,
    exp:     int,
    db:      DB,
):
    """
    Stream a clip file to the client.
    The URL is signed — no Authorization header needed.
    Useful for embedding in <video src="..."> tags in the mobile app.
    """
    if not auth.verify_clip_sig(clip_id, sig, exp):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired download link")

    async with db.execute(
        "SELECT path, camera_id FROM clips WHERE id = ?", (clip_id,)
    ) as cur:
        row = await cur.fetchone()

    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Clip not found")

    path = row["path"]
    if not os.path.isfile(path):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Clip file not found on disk")

    filename = os.path.basename(path)
    return FileResponse(
        path              = path,
        media_type        = "video/mp4",
        filename          = filename,
        headers           = {"Cache-Control": "private, max-age=3600"},
    )
