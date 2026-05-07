'use strict';

/**
 * AuraSense Recording Service
 *
 * Spawns one FFmpeg recorder per active camera.
 * Polls cameras.db every 30 s so newly discovered cameras start recording
 * automatically without a service restart.
 *
 * FFmpeg pulls sub-streams from mediamtx (rtsp://localhost:8554/{slug}-sub)
 * and writes 5-minute MP4 segments to:
 *   /media/aura/recordaura/recordings/{slug}/YYYYMMDD_HHMMSS.mp4
 *
 * Completed segments are indexed into the shared clips table so the
 * API gateway can serve them to the dashboard and Android app.
 */

const cfg            = require('./config');
const db             = require('./db');
const { CameraRecorder, slugify } = require('./recorder');
const { StorageManager }          = require('./storage');

// cameraId → CameraRecorder
const recorders = new Map();
const storage   = new StorageManager();

function startRecorder(camera) {
  if (recorders.has(camera.id)) return;
  const rec = new CameraRecorder(camera);
  recorders.set(camera.id, rec);
  rec.start();
}

function stopRecorder(cameraId) {
  const rec = recorders.get(cameraId);
  if (!rec) return;
  rec.stop();
  recorders.delete(cameraId);
}

function refreshCameras() {
  try {
    const active = db.getActiveCameras();
    const activeIds = new Set(active.map(c => c.id));

    // Start recorders for any new camera
    for (const camera of active) {
      if (!recorders.has(camera.id)) {
        console.log(`[manager] new camera: "${camera.name}" (id=${camera.id}, slug=${camera.slug || slugify(camera.name)})`);
        startRecorder(camera);
      }
    }

    // Stop recorders for cameras that disappeared / went offline
    for (const [id] of recorders) {
      if (!activeIds.has(id)) {
        console.log(`[manager] camera id=${id} removed or offline — stopping recorder`);
        stopRecorder(id);
      }
    }
  } catch (err) {
    console.error('[manager] refreshCameras error:', err.message);
  }
}

function shutdown(signal) {
  console.log(`\n[manager] received ${signal}, stopping all recorders…`);
  for (const [id] of recorders) stopRecorder(id);
  storage.stop();
  process.exit(0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('[manager] AuraSense Recording Service starting');
console.log(`[manager] recordings root: ${cfg.RECORDINGS_ROOT}`);
console.log(`[manager] database:        ${cfg.DB_PATH}`);
console.log(`[manager] segment length:  ${cfg.SEGMENT_DURATION_SEC}s`);
console.log(`[manager] disk cap:        ${(cfg.DISK_CAP_BYTES / 1e9).toFixed(0)} GB`);
console.log(`[manager] evict at:        ${(cfg.DISK_EVICT_THRESHOLD_BYTES / 1e9).toFixed(0)} GB`);

storage.start();
refreshCameras();

setInterval(refreshCameras, cfg.CAMERA_POLL_INTERVAL_MS);

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
