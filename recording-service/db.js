'use strict';

const Database = require('better-sqlite3');
const { DB_PATH } = require('./config');

let _db = null;

function getDb() {
  if (_db) return _db;

  _db = new Database(DB_PATH, { fileMustExist: false });
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // Ensure clips table exists (api-gateway may have already created it)
  _db.exec(`
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
  `);

  return _db;
}

// Returns all cameras with status='online'
function getActiveCameras() {
  return getDb()
    .prepare(`SELECT id, name, slug, rtsp_url FROM cameras WHERE status != 'offline' ORDER BY id`)
    .all();
}

// Insert a new clip record; silently skips if path already exists (UNIQUE)
function insertClip({ cameraId, path, startTime, endTime, sizeBytes }) {
  getDb()
    .prepare(`
      INSERT OR IGNORE INTO clips (camera_id, path, start_time, end_time, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(cameraId, path, startTime, endTime, sizeBytes, new Date().toISOString());
}

// Returns the oldest calendar day (YYYY-MM-DD) that has clips, or null
function getOldestClipDay() {
  const row = getDb()
    .prepare("SELECT date(start_time) AS day FROM clips ORDER BY start_time ASC LIMIT 1")
    .get();
  return row ? row.day : null;
}

// Deletes all clips whose start_time falls on `day` (YYYY-MM-DD).
// Returns the file paths that were deleted so the caller can unlink them.
function deleteClipsByDay(day) {
  const rows = getDb()
    .prepare("SELECT id, path FROM clips WHERE date(start_time) = ?")
    .all(day);
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  getDb().prepare(`DELETE FROM clips WHERE id IN (${placeholders})`).run(...ids);
  return rows.map(r => r.path);
}

function deleteClipById(id) {
  getDb().prepare('DELETE FROM clips WHERE id = ?').run(id);
}

// Sum of size_bytes for all indexed clips
function getTotalIndexedBytes() {
  const row = getDb().prepare('SELECT SUM(size_bytes) AS total FROM clips').get();
  return row?.total ?? 0;
}

// Paths already in clips table for a given camera (for backfill deduplication)
function getIndexedPaths(cameraId) {
  const rows = getDb()
    .prepare('SELECT path FROM clips WHERE camera_id = ?')
    .all(cameraId);
  return new Set(rows.map(r => r.path));
}

module.exports = {
  getDb,
  getActiveCameras,
  insertClip,
  getOldestClipDay,
  deleteClipsByDay,
  deleteClipById,
  getTotalIndexedBytes,
  getIndexedPaths,
};
