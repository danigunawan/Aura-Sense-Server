"""
Playback / clip access.

Clips are recorded as 5-minute MP4 segments (H.265) by the Recording Service
and indexed into the `clips` table.  This router is read-only on that table.

Two access modes per clip:
  download_url — raw H.265 MP4, HMAC-signed, 1-hour TTL
  play_url     — H.264 transcoded via FFmpeg (VAAPI h264_vaapi when the iGPU
                 supports it, libx264 software otherwise), streamed as
                 fragmented MP4 — plays in any modern browser including
                 hardware that lacks H.265 decode (e.g. Haswell iGPU).
"""

import asyncio
import os
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, StreamingResponse

import auth
from deps import DB, User
from models import ClipListResponse, ClipResponse

router = APIRouter(tags=["clips"])

_VAAPI_DEVICE = "/dev/dri/renderD128"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _signed_url(clip_id: int, endpoint: str) -> str:
    sig, exp = auth.sign_clip_url(clip_id, ttl_seconds=3600)
    # Relative path — works through both the Vite dev proxy (/api → :8000)
    # and production nginx (also mounts API under /api).
    return f"/api/clips/{clip_id}/{endpoint}?sig={sig}&exp={exp}"


def _to_clip(row, camera_name: str) -> ClipResponse:
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
        download_url     = _signed_url(row["id"], "download"),
        play_url         = _signed_url(row["id"], "play"),
    )


def _ffmpeg_mp4_args(src_path: str) -> list[str]:
    """Transcode any input to H.264 / AAC fragmented MP4.

    The recording service stores H.265, which Chrome cannot decode without
    HEVC hardware support — so we always re-encode for playback. H.264 is
    chosen over VP8 because every relevant Intel iGPU back to Haswell
    hardware-encodes H.264, while VP8 encode requires Skylake+.

    Input is decoded in software (Haswell has no HEVC HW decode); output is
    HW-encoded via h264_vaapi when /dev/dri is accessible, libx264 otherwise.
    """
    common_audio = ["-c:a", "aac", "-b:a", "32k"]
    common_out   = [
        # Fragmented MP4 — playable progressively over a streaming response,
        # no need for the moov atom at the end of the file.
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "pipe:1",
    ]
    if os.access(_VAAPI_DEVICE, os.R_OK):
        return [
            "ffmpeg", "-hide_banner", "-loglevel", "warning",
            "-vaapi_device", _VAAPI_DEVICE,
            "-i", src_path,
            "-vf", "format=nv12,hwupload",
            "-c:v", "h264_vaapi", "-b:v", "700k",
            *common_audio,
            *common_out,
        ]
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "warning",
        "-i", src_path,
        "-c:v", "libx264", "-preset", "veryfast", "-b:v", "700k", "-pix_fmt", "yuv420p",
        *common_audio,
        *common_out,
    ]


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/cameras/{camera_id}/clips", response_model=ClipListResponse)
async def list_clips(
    camera_id: int,
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

    items = [_to_clip(r, camera_name) for r in rows]

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


@router.get("/clips/{clip_id}/play")
async def play_clip(
    clip_id: int,
    sig:     str,
    exp:     int,
    db:      DB,
):
    """
    Stream clip as H.264/AAC fragmented MP4 for browser/kiosk playback.
    Source files are H.265 (camera sub-stream), which Chrome cannot decode
    on hardware lacking HEVC support — so we always transcode here.
    Uses VAAPI h264_vaapi when available, libx264 software otherwise.
    URL is pre-signed — no Authorization header needed.
    """
    if not auth.verify_clip_sig(clip_id, sig, exp):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired link")

    async with db.execute("SELECT path FROM clips WHERE id = ?", (clip_id,)) as cur:
        row = await cur.fetchone()

    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Clip not found")

    src_path = row["path"]
    if not os.path.isfile(src_path):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Clip file not found on disk")

    # Validate file is readable before starting the stream
    probe = await asyncio.create_subprocess_exec(
        "ffprobe", "-hide_banner", "-v", "error",
        "-select_streams", "v:0", "-show_entries", "stream=codec_name",
        "-of", "csv=p=0", src_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    probe_out, probe_err = await probe.communicate()
    if probe.returncode != 0 or not probe_out.strip():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Clip is corrupt: {probe_err.decode(errors='replace').strip()[:120]}",
        )

    args = _ffmpeg_mp4_args(src_path)

    async def _stream():
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                yield chunk
        finally:
            if proc.returncode is None:
                proc.kill()
            await proc.wait()

    return StreamingResponse(
        _stream(),
        media_type="video/mp4",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
