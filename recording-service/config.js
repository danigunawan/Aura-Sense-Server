'use strict';

module.exports = {
  // Where mediamtx re-streams all cameras
  MEDIAMTX_RTSP_BASE: 'rtsp://localhost:8554',

  // External hard disk mount point
  RECORDINGS_ROOT: '/media/aura/recordaura/recordings',

  // Shared SQLite DB (camera_discovery + api-gateway)
  DB_PATH: '/home/aura/Documents/aurasense/camera_discovery/cameras.db',

  // Segment length in seconds (300 = 5 minutes)
  SEGMENT_DURATION_SEC: 300,

  // ── Storage caps ────────────────────────────────────────────────────────────
  // Hard cap: never exceed this on the recordings partition (200 GB of 224 GB)
  DISK_CAP_BYTES: 200 * 1024 * 1024 * 1024,

  // Start evicting (oldest-first) when used exceeds this (190 GB)
  DISK_EVICT_THRESHOLD_BYTES: 190 * 1024 * 1024 * 1024,

  // Always keep at least this many free bytes on the partition (20 GB)
  MIN_FREE_BYTES: 20 * 1024 * 1024 * 1024,

  // How many clips to delete per eviction pass
  EVICT_BATCH: 20,

  // ── Timers ──────────────────────────────────────────────────────────────────
  STORAGE_CHECK_INTERVAL_MS: 60_000,   // check disk every 60 s
  CAMERA_POLL_INTERVAL_MS:   30_000,   // re-read cameras.db every 30 s
  CSV_POLL_INTERVAL_MS:       5_000,   // poll segment list every 5 s

  // ── FFmpeg restart backoff ──────────────────────────────────────────────────
  RESTART_BASE_MS:   5_000,
  RESTART_MAX_MS:  300_000,   // cap at 5 minutes

  // Set LOG_FFMPEG=1 to forward FFmpeg stderr to console
  LOG_FFMPEG: process.env.LOG_FFMPEG === '1',
};
