import aiosqlite
import logging
from datetime import datetime, timezone
from typing import List, Optional

from models import Camera

log = logging.getLogger(__name__)

_DDL = """
CREATE TABLE IF NOT EXISTS cameras (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_uuid       TEXT    UNIQUE NOT NULL,
    ip_address        TEXT    NOT NULL,
    port              INTEGER NOT NULL DEFAULT 80,
    device_url        TEXT    NOT NULL,
    manufacturer      TEXT,
    model             TEXT,
    serial_number     TEXT,
    firmware_version  TEXT,
    rtsp_url          TEXT    NOT NULL DEFAULT '',
    sub_rtsp_url      TEXT    NOT NULL DEFAULT '',
    profile_token     TEXT,
    sub_profile_token TEXT,
    slug              TEXT    NOT NULL DEFAULT '',
    name              TEXT    NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'online',
    created_at        TEXT    NOT NULL,
    last_seen         TEXT    NOT NULL,
    last_error        TEXT
);

CREATE TABLE IF NOT EXISTS discovery_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT NOT NULL,
    camera_uuid TEXT,
    ip_address  TEXT,
    message     TEXT,
    timestamp   TEXT NOT NULL
);
"""

# Columns added after the initial schema — applied via ALTER TABLE migration.
_NEW_COLUMNS: list[tuple[str, str]] = [
    ('sub_rtsp_url',      "TEXT NOT NULL DEFAULT ''"),
    ('sub_profile_token', 'TEXT'),
    ('slug',              "TEXT NOT NULL DEFAULT ''"),
    ('static_ip',         'TEXT'),
    ('tls_fingerprint',   'TEXT'),
]


class CameraDB:
    def __init__(self, path: str):
        self._path = path
        self._db: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        self._db = await aiosqlite.connect(self._path)
        self._db.row_factory = aiosqlite.Row
        await self._db.executescript(_DDL)
        await self._migrate()
        await self._db.commit()
        log.info("Database ready: %s", self._path)

    async def close(self) -> None:
        if self._db:
            await self._db.close()

    # ------------------------------------------------------------------
    # Camera operations
    # ------------------------------------------------------------------

    async def upsert_camera(self, cam: Camera) -> bool:
        """Insert or update a camera. Returns True if it was a new insertion."""
        now = _now()
        async with self._db.execute(
            "SELECT id FROM cameras WHERE device_uuid = ?", (cam.device_uuid,)
        ) as cur:
            existing = await cur.fetchone()

        if existing:
            await self._db.execute(
                """UPDATE cameras SET
                    ip_address        = ?,
                    port              = ?,
                    device_url        = ?,
                    rtsp_url          = ?,
                    sub_rtsp_url      = ?,
                    profile_token     = ?,
                    sub_profile_token = ?,
                    slug              = ?,
                    tls_fingerprint   = ?,
                    status            = 'online',
                    last_seen         = ?,
                    last_error        = NULL
                WHERE device_uuid = ?""",
                (
                    cam.ip_address, cam.port, cam.device_url,
                    cam.rtsp_url, cam.sub_rtsp_url,
                    cam.profile_token, cam.sub_profile_token,
                    cam.slug, cam.tls_fingerprint, now, cam.device_uuid,
                ),
            )
            await self._db.commit()
            return False

        await self._db.execute(
            """INSERT INTO cameras (
                device_uuid, ip_address, port, device_url,
                manufacturer, model, serial_number, firmware_version,
                rtsp_url, sub_rtsp_url, profile_token, sub_profile_token,
                slug, name, status, created_at, last_seen, tls_fingerprint
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'online',?,?,?)""",
            (
                cam.device_uuid, cam.ip_address, cam.port, cam.device_url,
                cam.manufacturer, cam.model, cam.serial_number, cam.firmware_version,
                cam.rtsp_url, cam.sub_rtsp_url,
                cam.profile_token, cam.sub_profile_token,
                cam.slug, cam.name,
                now, now, cam.tls_fingerprint,
            ),
        )
        await self._db.commit()
        return True

    async def mark_offline(self, device_uuid: str, error: str) -> None:
        await self._db.execute(
            "UPDATE cameras SET status = 'error', last_error = ? WHERE device_uuid = ?",
            (error, device_uuid),
        )
        await self._db.commit()

    async def get_assigned_static_ips(self) -> List[str]:
        """Return all IPs in use — both reserved via static_ip and current ip_address values.

        Including ip_address prevents the allocator from handing out an IP that a
        camera already lives on but whose static_ip column was never written (e.g.
        cameras that were pre-configured on the hardware before this NVR knew them).
        """
        async with self._db.execute(
            "SELECT static_ip AS ip FROM cameras WHERE static_ip IS NOT NULL"
            " UNION "
            "SELECT ip_address AS ip FROM cameras WHERE ip_address IS NOT NULL"
        ) as cur:
            rows = await cur.fetchall()
        return [r["ip"] for r in rows]

    async def update_static_ip(self, device_uuid: str, static_ip: str) -> None:
        """Record the static IP that was assigned to a camera via ONVIF."""
        await self._db.execute(
            "UPDATE cameras SET static_ip = ? WHERE device_uuid = ?",
            (static_ip, device_uuid),
        )
        await self._db.commit()

    async def get_used_names(self) -> List[str]:
        async with self._db.execute("SELECT name FROM cameras") as cur:
            rows = await cur.fetchall()
        return [r["name"] for r in rows]

    async def get_used_slugs(self) -> List[str]:
        async with self._db.execute("SELECT slug FROM cameras WHERE slug != ''") as cur:
            rows = await cur.fetchall()
        return [r["slug"] for r in rows]

    async def get_all(self) -> List[Camera]:
        async with self._db.execute("SELECT * FROM cameras ORDER BY id") as cur:
            rows = await cur.fetchall()
        return [_row_to_camera(r) for r in rows]

    async def get_online(self) -> List[Camera]:
        async with self._db.execute(
            "SELECT * FROM cameras WHERE status = 'online' ORDER BY id"
        ) as cur:
            rows = await cur.fetchall()
        return [_row_to_camera(r) for r in rows]

    async def get_by_uuid(self, device_uuid: str) -> Optional[Camera]:
        async with self._db.execute(
            "SELECT * FROM cameras WHERE device_uuid = ?", (device_uuid,)
        ) as cur:
            row = await cur.fetchone()
        return _row_to_camera(row) if row else None

    # ------------------------------------------------------------------
    # Discovery log
    # ------------------------------------------------------------------

    async def log_event(
        self,
        event_type: str,
        message: str,
        camera_uuid: str | None = None,
        ip_address: str | None = None,
    ) -> None:
        await self._db.execute(
            "INSERT INTO discovery_log (event_type, camera_uuid, ip_address, message, timestamp) "
            "VALUES (?, ?, ?, ?, ?)",
            (event_type, camera_uuid, ip_address, message, _now()),
        )
        await self._db.commit()

    # ------------------------------------------------------------------
    # Migration
    # ------------------------------------------------------------------

    async def _migrate(self) -> None:
        """Add columns introduced after the initial schema without data loss."""
        async with self._db.execute("PRAGMA table_info(cameras)") as cur:
            existing = {row[1] async for row in cur}

        for col, col_def in _NEW_COLUMNS:
            if col not in existing:
                await self._db.execute(
                    f"ALTER TABLE cameras ADD COLUMN {col} {col_def}"
                )
                log.info("DB migration: added column cameras.%s", col)


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_camera(row: aiosqlite.Row) -> Camera:
    keys = row.keys()
    return Camera(
        id=row["id"],
        device_uuid=row["device_uuid"],
        ip_address=row["ip_address"],
        port=row["port"],
        device_url=row["device_url"],
        manufacturer=row["manufacturer"] or "",
        model=row["model"] or "",
        serial_number=row["serial_number"] or "",
        firmware_version=row["firmware_version"] or "",
        rtsp_url=row["rtsp_url"] or "",
        sub_rtsp_url=row["sub_rtsp_url"] if "sub_rtsp_url" in keys else "",
        profile_token=row["profile_token"] or "",
        sub_profile_token=row["sub_profile_token"] if "sub_profile_token" in keys else "",
        slug=row["slug"] if "slug" in keys else "",
        name=row["name"],
        status=row["status"],
        static_ip=row["static_ip"] if "static_ip" in keys else None,
        tls_fingerprint=row["tls_fingerprint"] if "tls_fingerprint" in keys else None,
        last_error=row["last_error"],
    )
