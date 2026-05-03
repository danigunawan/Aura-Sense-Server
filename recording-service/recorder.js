'use strict';

/**
 * CameraRecorder — manages a single FFmpeg segment-recording process.
 *
 * FFmpeg pulls from mediamtx sub-stream and writes 5-min MP4 segments.
 * No decode/encode: -c copy.  H.265 gets -tag:v hvc1 so MP4 players
 * can parse it without probing.
 *
 * Segment detection: FFmpeg appends each completed segment to segments.csv
 * (format: path,start_sec,end_sec).  We poll that file every 5 s so we
 * know exactly when a segment is closed and safe to index.
 *
 * On crash: exponential backoff restart up to RESTART_MAX_MS.
 * On startup: backfill any MP4 files in the output dir not yet in the DB.
 */

const EventEmitter = require('events');
const fs           = require('fs');
const path         = require('path');
const { spawn }    = require('child_process');

const cfg = require('./config');
const db  = require('./db');

// Derive a filesystem-safe slug from a camera name
// "Entrance"  → "entrance"
// "Side Gate" → "side-gate"
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Parse wall-clock start time from a strftime filename like 20260503_143000.mp4
function parseFilenameTime(filePath) {
  const base = path.basename(filePath, '.mp4');
  const m = base.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, yr, mo, dy, hr, mn, sc] = m;
  return new Date(`${yr}-${mo}-${dy}T${hr}:${mn}:${sc}`);
}

class CameraRecorder extends EventEmitter {
  /**
   * @param {{ id: number, name: string, rtsp_url: string }} camera
   */
  constructor(camera) {
    super();
    this.camera      = camera;
    this.slug        = slugify(camera.name);
    this.outDir      = path.join(cfg.RECORDINGS_ROOT, this.slug);
    this.csvPath     = path.join(this.outDir, 'segments.csv');

    this._proc        = null;
    this._stopped     = false;
    this._restartN    = 0;
    this._csvOffset   = 0;
    this._pollTimer   = null;
  }

  start() {
    this._stopped = false;
    this._ensureDir();
    this._backfill();
    this._spawnFfmpeg();
    this._startCsvPoll();
    console.log(`[${this.slug}] recorder started`);
  }

  stop() {
    this._stopped = true;
    clearInterval(this._pollTimer);
    if (this._proc) {
      this._proc.kill('SIGTERM');
      this._proc = null;
    }
    console.log(`[${this.slug}] recorder stopped`);
  }

  // ── private ────────────────────────────────────────────────────────────────

  _ensureDir() {
    fs.mkdirSync(this.outDir, { recursive: true });
  }

  // Index MP4 files that landed on disk between last shutdown and now
  _backfill() {
    try {
      const indexed  = db.getIndexedPaths(this.camera.id);
      const existing = fs.readdirSync(this.outDir)
        .filter(f => f.endsWith('.mp4'))
        .sort();

      for (let i = 0; i < existing.length - 1; i++) {
        const filePath = path.join(this.outDir, existing[i]);
        if (indexed.has(filePath)) continue;

        const startTime = parseFilenameTime(filePath);
        if (!startTime) continue;

        const endTime  = new Date(startTime.getTime() + cfg.SEGMENT_DURATION_SEC * 1000);
        let sizeBytes  = 0;
        try { sizeBytes = fs.statSync(filePath).size; } catch (_) {}

        if (sizeBytes < 1024) continue; // skip empty/corrupt files

        this._indexSegment(filePath, startTime, endTime, sizeBytes);
        console.log(`[${this.slug}] backfilled ${path.basename(filePath)}`);
      }
    } catch (err) {
      console.warn(`[${this.slug}] backfill error: ${err.message}`);
    }
  }

  _buildFfmpegArgs() {
    const inputUrl = `${cfg.MEDIAMTX_RTSP_BASE}/${this.slug}-sub`;
    const outPattern = path.join(this.outDir, '%Y%m%d_%H%M%S.mp4');

    return [
      '-hide_banner', '-loglevel', 'warning',

      // Input
      '-rtsp_transport', 'tcp',
      '-i', inputUrl,

      // Video: stream copy (zero CPU). hvc1 tag needed for H.265-in-MP4.
      // Audio: transcode to AAC so pcm_mulaw/pcm_alaw from IP cameras are
      // always MP4-compatible. Low bitrate is fine for surveillance audio.
      '-c:v', 'copy',
      '-tag:v', 'hvc1',
      '-c:a', 'aac', '-b:a', '32k',

      // Segment muxer
      '-f', 'segment',
      '-segment_time', String(cfg.SEGMENT_DURATION_SEC),
      '-segment_atclocktime', '1',   // align to wall-clock 5-min boundaries
      '-reset_timestamps', '1',
      '-strftime', '1',

      // Segment list — keep unlimited entries so the file grows monotonically
      // ('+append' flag is unavailable in FFmpeg 4.4.x; segment_list_size 0
      // causes FFmpeg to rewrite the full list each segment, which also lets
      // the offset-based CSV poller detect new lines correctly)
      '-segment_list', this.csvPath,
      '-segment_list_type', 'csv',
      '-segment_list_size', '0',

      '-movflags', '+faststart',

      outPattern,
    ];
  }

  _spawnFfmpeg() {
    const args = this._buildFfmpegArgs();
    if (cfg.LOG_FFMPEG) {
      console.log(`[${this.slug}] ffmpeg ${args.join(' ')}`);
    }

    this._proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    if (cfg.LOG_FFMPEG) {
      this._proc.stderr.on('data', d => process.stderr.write(`[ffmpeg/${this.slug}] ${d}`));
    }

    this._proc.on('exit', (code, signal) => {
      this._proc = null;
      if (this._stopped) return;

      const reason = signal ? `signal ${signal}` : `exit ${code}`;
      const delay  = Math.min(
        cfg.RESTART_BASE_MS * 2 ** this._restartN,
        cfg.RESTART_MAX_MS,
      );
      console.warn(`[${this.slug}] FFmpeg exited (${reason}); restart in ${delay / 1000}s`);
      this._restartN++;
      setTimeout(() => {
        if (!this._stopped) {
          this._backfill();
          this._spawnFfmpeg();
        }
      }, delay);
    });

    // Reset backoff counter after 60 s of stable run
    setTimeout(() => { this._restartN = 0; }, 60_000);
  }

  // Poll segments.csv for lines added since last check
  _startCsvPoll() {
    // Set initial offset to current file size so we don't re-index old entries
    try {
      this._csvOffset = fs.statSync(this.csvPath).size;
    } catch (_) {
      this._csvOffset = 0;
    }

    this._pollTimer = setInterval(() => this._pollCsv(), cfg.CSV_POLL_INTERVAL_MS);
  }

  _pollCsv() {
    try {
      const stat = fs.statSync(this.csvPath);
      if (stat.size <= this._csvOffset) return;

      const fd  = fs.openSync(this.csvPath, 'r');
      const len = stat.size - this._csvOffset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this._csvOffset);
      fs.closeSync(fd);
      this._csvOffset = stat.size;

      const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
      for (const line of lines) this._processCsvLine(line);
    } catch (_) {
      // CSV not created yet (FFmpeg hasn't finished first segment)
    }
  }

  // CSV format written by FFmpeg: <path>,<start_sec>,<end_sec>
  // FFmpeg writes relative filenames when the list and output share a directory.
  _processCsvLine(line) {
    const parts = line.split(',');
    if (parts.length < 1) return;

    const raw = parts[0].trim();
    if (!raw.endsWith('.mp4')) return;

    // Resolve to absolute so fs.statSync and db path are correct
    const filePath = path.isAbsolute(raw) ? raw : path.join(this.outDir, raw);

    // Use filename as authoritative wall-clock start time
    const startTime = parseFilenameTime(filePath);
    if (!startTime) return;

    const endTime = new Date(startTime.getTime() + cfg.SEGMENT_DURATION_SEC * 1000);

    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(filePath).size; } catch (_) { return; }
    if (sizeBytes < 1024) return; // ignore empty/corrupt files

    this._indexSegment(filePath, startTime, endTime, sizeBytes);
  }

  _indexSegment(filePath, startTime, endTime, sizeBytes) {
    db.insertClip({
      cameraId:  this.camera.id,
      path:      filePath,
      startTime: startTime.toISOString(),
      endTime:   endTime.toISOString(),
      sizeBytes,
    });
    this.emit('segment', { cameraId: this.camera.id, path: filePath, sizeBytes });
    console.log(`[${this.slug}] indexed ${path.basename(filePath)} (${(sizeBytes / 1e6).toFixed(1)} MB)`);
  }
}

module.exports = { CameraRecorder, slugify };
