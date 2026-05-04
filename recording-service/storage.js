'use strict';

/**
 * StorageManager — enforces a hard cap on the recordings partition.
 *
 * NVR best-practice caps used here:
 *   Hard cap      200 GB  (of 224 GB partition)
 *   Evict trigger 190 GB  (10 GB headroom before hitting cap)
 *   Disk free min  20 GB  (OS/journal/temp space always reserved)
 *
 * Eviction strategy: delete oldest segments first (LRU by start_time),
 * removing both the MP4 file and its clips table row.  Runs every 60 s.
 *
 * Estimated retention with 3 sub-stream cameras @ ~512 kbps each:
 *   ~23 MB/segment × 3 cameras × 288 segments/day ≈ 20 GB/day
 *   200 GB ÷ 20 GB/day ≈ 10 days rolling window
 */

const fs  = require('fs');
const cfg = require('./config');
const db  = require('./db');

class StorageManager {
  constructor() {
    this._timer = null;
  }

  start() {
    this._check();
    this._timer = setInterval(() => this._check(), cfg.STORAGE_CHECK_INTERVAL_MS);
    console.log('[storage] manager started (cap 200 GB, evict at 190 GB)');
  }

  stop() {
    clearInterval(this._timer);
  }

  // ── private ────────────────────────────────────────────────────────────────

  _check() {
    try {
      const freeBytes  = this._getFreeBytes();
      const totalBytes = db.getTotalIndexedBytes();

      const overCap  = totalBytes  > cfg.DISK_EVICT_THRESHOLD_BYTES;
      const lowDisk  = freeBytes   < cfg.MIN_FREE_BYTES;

      if (!overCap && !lowDisk) return;

      if (overCap) {
        console.log(`[storage] indexed total ${_gb(totalBytes)} GB > evict threshold ${_gb(cfg.DISK_EVICT_THRESHOLD_BYTES)} GB`);
      }
      if (lowDisk) {
        console.log(`[storage] free disk ${_gb(freeBytes)} GB < minimum ${_gb(cfg.MIN_FREE_BYTES)} GB`);
      }

      this._evict();
    } catch (err) {
      console.error('[storage] check error:', err.message);
    }
  }

  _evict() {
    let daysEvicted = 0;

    while (true) {
      const freeBytes  = this._getFreeBytes();
      const totalBytes = db.getTotalIndexedBytes();
      if (totalBytes < cfg.DISK_EVICT_THRESHOLD_BYTES && freeBytes > cfg.MIN_FREE_BYTES) break;

      const day = db.getOldestClipDay();
      if (!day) {
        console.warn('[storage] nothing left to evict but still over threshold');
        break;
      }

      const paths = db.deleteClipsByDay(day);
      let unlinkCount = 0;
      for (const p of paths) {
        try { fs.unlinkSync(p); unlinkCount++; } catch (_) { /* already gone */ }
      }

      daysEvicted++;
      console.log(`[storage] evicted day ${day} (${unlinkCount} files removed); total now ${_gb(db.getTotalIndexedBytes())} GB`);
    }
  }

  _getFreeBytes() {
    // fs.statfs is available since Node 18.8 (experimental → stable in 19+)
    // Fall back to a synchronous parse of `df` output for older runtimes.
    try {
      const { statfsSync } = require('fs');
      const s = statfsSync(cfg.RECORDINGS_ROOT);
      return s.bfree * s.bsize;
    } catch (_) {
      return _dfFreeBytes(cfg.RECORDINGS_ROOT);
    }
  }
}

function _dfFreeBytes(mountOrPath) {
  const { execSync } = require('child_process');
  try {
    const out = execSync(`df -B1 --output=avail "${mountOrPath}" | tail -1`, { timeout: 5000 })
      .toString().trim();
    return parseInt(out, 10) || 0;
  } catch (_) {
    return Number.MAX_SAFE_INTEGER; // fail open — don't evict if we can't check
  }
}

function _gb(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

module.exports = { StorageManager };
