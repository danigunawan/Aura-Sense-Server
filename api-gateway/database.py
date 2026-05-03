"""
Shared aiosqlite connection.

Reads camera data written by camera_discovery service.
Owns the users and clips tables (clips are populated by Storage Manager).
"""

import aiosqlite
from config import config

# Tables owned by this service
_DDL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT    UNIQUE NOT NULL,
    hashed_password TEXT    NOT NULL,
    role            TEXT    NOT NULL DEFAULT 'viewer',
    created_at      TEXT    NOT NULL
);

-- Populated by Storage Manager; API gateway is read-only on this table.
CREATE TABLE IF NOT EXISTS clips (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id   INTEGER NOT NULL,
    path        TEXT    NOT NULL UNIQUE,
    start_time  TEXT    NOT NULL,
    end_time    TEXT    NOT NULL,
    size_bytes  INTEGER NOT NULL,
    created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clips_camera_time ON clips(camera_id, start_time);
"""

_conn: aiosqlite.Connection | None = None


async def init() -> None:
    global _conn
    _conn = await aiosqlite.connect(config.db_path)
    _conn.row_factory = aiosqlite.Row
    await _conn.executescript(_DDL)
    await _conn.commit()


async def close() -> None:
    if _conn:
        await _conn.close()


def get() -> aiosqlite.Connection:
    assert _conn is not None, "Database not initialised"
    return _conn
