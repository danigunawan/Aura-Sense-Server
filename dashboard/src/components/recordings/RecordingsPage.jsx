import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client.js';

/**
 * Multi-camera recordings page — ports the Android RecordingsScreen UX:
 *   • Top:    date bar (◀  Today  ▶  + native date picker)
 *   • Middle: grid of camera tiles, each playing the clip queue from the
 *             current scrub time forward, advancing through 5-min segments
 *             automatically.
 *   • Bottom: 24-hour timeline canvas with clip availability bars, a fixed
 *             centre playhead, drag-to-scrub, and Ctrl/wheel zoom.
 *
 * Two playhead variables (mirrors the Android ViewModel):
 *   - scrubMs:    queue anchor. Only changes on user action (drag the bar
 *                 / pick a date / latest-clip auto-snap). Stable so the
 *                 underlying <video> queue isn't churned mid-playback.
 *   - playheadMs: live position. Ticks from the leading <video> element's
 *                 currentTime + clip start, drives the needle and HH:MM:SS
 *                 readout, never reloads media.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export default function RecordingsPage({ cameras: rawCameras }) {
  // useCameras() polls the API every 30 s and calls setCameras(data.items)
  // with a fresh array each time, so the prop reference flips even when the
  // camera list is unchanged. Without stabilization, every poll cascades:
  // queues recomputes → queue-driver effect refires → either re-seeks the
  // <video> back to the user's scrub offset (same firstUrl) or reloads it
  // with a freshly-signed URL, while the load-clips effect simultaneously
  // refetches and snaps scrubMs to the latest clip — that snap is what made
  // playback jump to the end of the day 10–30 s in. Key by camera IDs so
  // downstream only sees a change when the actual camera list changes.
  const camerasKey = rawCameras.map(c => c.id).sort((a, b) => a - b).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cameras = useMemo(() => rawCameras, [camerasKey]);

  // ── Date / clips ──────────────────────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState(() => isoDate(new Date()));
  const [clipsByCamera, setClipsByCamera] = useState({});  // { [camId]: Clip[] }
  const [loadingClips, setLoadingClips] = useState(false);
  const [error,        setError]        = useState('');

  // ── Scrub / playhead ──────────────────────────────────────────────────────
  const [scrubMs,    setScrubMs]    = useState(12 * 60 * 60 * 1000);   // noon default
  const [playheadMs, setPlayheadMs] = useState(12 * 60 * 60 * 1000);
  const [zoom,       setZoom]       = useState(8);                     // ×8 ≈ 3 h visible
  const [paused,     setPaused]     = useState(false);
  // Tile expansion: when a tile is clicked, it fills the middle area while
  // the date bar + timeline stay visible. All tiles stay mounted so the
  // underlying <video> elements (and videoRefs) keep playing — non-expanded
  // ones are just hidden via display:none.
  const [expandedCameraId, setExpandedCameraId] = useState(null);

  const visibleMs   = Math.max(60_000, Math.floor(DAY_MS / zoom));
  const leftEdgeMs  = playheadMs - visibleMs / 2;
  const rightEdgeMs = playheadMs + visibleMs / 2;

  // Refs for each camera's <video> so we can drive seeks + read currentTime.
  const videoRefs = useRef(new Map());
  // Live mirror of `paused` so async media events (loadedmetadata, ended)
  // see the *current* play state, not the value captured when the listener
  // was attached — otherwise pausing during a clip swap can be undone.
  const pausedRef = useRef(paused);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // ── Load clips on date change ─────────────────────────────────────────────
  useEffect(() => {
    if (cameras.length === 0) return;
    let cancelled = false;
    setLoadingClips(true);
    setError('');

    const start = new Date(`${selectedDate}T00:00:00`);
    const end   = new Date(start.getTime() + DAY_MS);
    const from  = start.toISOString();
    const to    = end.toISOString();

    Promise.all(cameras.map(cam =>
      api.clips(cam.id, { page: 1, limit: 400, from, to })
        .then(r => [cam.id, r.items || []])
        .catch(() => [cam.id, []])
    )).then(pairs => {
      if (cancelled) return;
      const byId = Object.fromEntries(pairs);
      setClipsByCamera(byId);
      setLoadingClips(false);

      // Snap the scrubber to the latest clip's start so opening a date
      // lands on real footage instead of an empty noon.
      const midnightMs   = start.getTime();
      const allStarts = Object.values(byId).flat().map(c => Date.parse(c.start_time));
      if (allStarts.length > 0) {
        const latestStart = Math.max(...allStarts);
        const ms = clamp(latestStart - midnightMs, 0, DAY_MS - 1);
        setScrubMs(ms);
        setPlayheadMs(ms);
      }
    });

    return () => { cancelled = true; };
  }, [selectedDate, cameras]);

  // ── Build per-camera playback queues ──────────────────────────────────────
  // Stable across playback (only depends on scrubMs + clips), so a fresh
  // queue is only built when the user explicitly seeks.
  const queues = useMemo(() => {
    const midnightMs = new Date(`${selectedDate}T00:00:00`).getTime();
    const targetEpoch = midnightMs + scrubMs;
    const out = {};

    for (const cam of cameras) {
      const clips = (clipsByCamera[cam.id] || []).slice().sort(
        (a, b) => a.start_time.localeCompare(b.start_time),
      );
      if (clips.length === 0) { out[cam.id] = null; continue; }

      // First clip whose end is at-or-after the scrub instant.
      let startIdx = clips.findIndex(c => Date.parse(c.end_time) >= targetEpoch);
      if (startIdx < 0) startIdx = clips.length - 1;   // scrubbed past last clip
      const tail = clips.slice(startIdx);
      const startInstant = Date.parse(tail[0].start_time);
      const seekSec = targetEpoch < startInstant
        ? 0
        : Math.max(0, (targetEpoch - startInstant) / 1000);

      out[cam.id] = {
        urls:        tail.map(c => c.play_url),
        startsMs:    tail.map(c => clamp(Date.parse(c.start_time) - midnightMs, 0, DAY_MS - 1)),
        startSeekS:  seekSec,
        firstUrl:    tail[0].play_url,
        downloadUrl: tail[0].download_url,
      };
    }
    return out;
  }, [cameras, clipsByCamera, scrubMs, selectedDate]);

  // ── Drive each <video> to play the queue starting at scrub time ───────────
  // Mirrors Android's setMediaItems / seekTo + auto-advance. We update the
  // <video>'s src on queue change, and chain `ended` → next URL.
  const queueIndexes = useRef(new Map());   // cameraId -> current idx in queue

  useEffect(() => {
    for (const cam of cameras) {
      const v = videoRefs.current.get(cam.id);
      const q = queues[cam.id];
      if (!v) continue;
      if (!q) { v.removeAttribute('src'); v.load(); continue; }

      queueIndexes.current.set(cam.id, 0);
      if (v.dataset.curUrl !== q.firstUrl) {
        // Different clip: swap src, then seek + resume once metadata is in.
        v.dataset.curUrl = q.firstUrl;
        v.src = q.firstUrl;
        v.load();
        v.addEventListener('loadedmetadata', () => {
          try { v.currentTime = q.startSeekS; } catch (_) {}
          if (!pausedRef.current) v.play().catch(() => {});
        }, { once: true });
      } else {
        // Same clip, new offset inside it: seek immediately and resume.
        // Without this the playhead visual moves but the <video> keeps
        // running at its old position, then the 250 ms ticker snaps the
        // playhead back — looks like the scrub did nothing.
        try { v.currentTime = q.startSeekS; } catch (_) {}
        if (!pausedRef.current) v.play().catch(() => {});
      }
    }
  }, [queues, cameras]);

  // ── Auto-advance: when a clip ends, jump to the next URL in the queue ────
  useEffect(() => {
    const handlers = new Map();
    for (const cam of cameras) {
      const v = videoRefs.current.get(cam.id);
      const q = queues[cam.id];
      if (!v || !q) continue;
      const onEnded = () => {
        const idx = (queueIndexes.current.get(cam.id) || 0) + 1;
        if (idx >= q.urls.length) return;
        queueIndexes.current.set(cam.id, idx);
        v.dataset.curUrl = q.urls[idx];
        v.src = q.urls[idx];
        v.load();
        v.addEventListener('loadedmetadata', () => {
          if (!pausedRef.current) v.play().catch(() => {});
        }, { once: true });
      };
      v.addEventListener('ended', onEnded);
      handlers.set(cam.id, onEnded);
    }
    return () => {
      for (const [id, h] of handlers) {
        const v = videoRefs.current.get(id);
        if (v) v.removeEventListener('ended', h);
      }
    };
  }, [queues, cameras]);

  // ── Tick the playhead from a reference video's currentTime ────────────────
  useEffect(() => {
    const ref = cameras.find(c => c.status === 'online') || cameras[0];
    if (!ref) return;
    const id = setInterval(() => {
      const v   = videoRefs.current.get(ref.id);
      const q   = queues[ref.id];
      if (!v || !q || v.paused) return;
      const idx = queueIndexes.current.get(ref.id) || 0;
      const startMs = q.startsMs[idx];
      if (startMs == null) return;
      const newPlayhead = clamp(startMs + Math.floor(v.currentTime * 1000), 0, DAY_MS - 1);
      setPlayheadMs(newPlayhead);
    }, 250);
    return () => clearInterval(id);
  }, [cameras, queues]);

  // ── Apply pause / resume to all tiles ─────────────────────────────────────
  useEffect(() => {
    for (const cam of cameras) {
      const v = videoRefs.current.get(cam.id);
      if (!v) continue;
      if (paused) v.pause();
      else        v.play().catch(() => {});
    }
  }, [paused, cameras]);

  // ── Bars across all cameras (combined for the timeline visualisation) ────
  const bars = useMemo(() => {
    const midnightMs = new Date(`${selectedDate}T00:00:00`).getTime();
    const out = [];
    for (const camId of Object.keys(clipsByCamera)) {
      for (const c of clipsByCamera[camId]) {
        out.push({
          startMs: clamp(Date.parse(c.start_time) - midnightMs, 0, DAY_MS),
          endMs:   clamp(Date.parse(c.end_time)   - midnightMs, 0, DAY_MS),
        });
      }
    }
    return out;
  }, [clipsByCamera, selectedDate]);

  const onScrub = useCallback((newMs) => {
    const clamped = clamp(newMs, 0, DAY_MS - 1);
    setScrubMs(clamped);
    setPlayheadMs(clamped);
  }, []);

  const downloadClipForCamera = (cam) => {
    const q = queues[cam.id];
    if (!q) return;
    const a = document.createElement('a');
    a.href = q.downloadUrl;
    a.download = `aurasense_${(cam.name || `cam${cam.id}`).replace(/[^A-Za-z0-9_-]/g, '_')}.mp4`;
    document.body.appendChild(a); a.click(); a.remove();
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <DateBar
        date={selectedDate}
        onPrev={() => setSelectedDate(shiftDate(selectedDate, -1))}
        onNext={() => setSelectedDate(shiftDate(selectedDate, +1))}
        onToday={() => setSelectedDate(isoDate(new Date()))}
        onPick={setSelectedDate}
        loading={loadingClips}
      />

      <div style={{
        flex:     1,
        overflow: expandedCameraId !== null ? 'hidden' : 'auto',
        padding: '12px 16px',
        minHeight: 0,
      }}>
        {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p>}
        <CameraTilesGrid
          cameras={cameras}
          queues={queues}
          videoRefs={videoRefs}
          scrubLabel={fmtTimeOfDay(playheadMs)}
          onDownload={downloadClipForCamera}
          expandedCameraId={expandedCameraId}
          onToggleExpand={(id) => setExpandedCameraId(prev => prev === id ? null : id)}
        />
      </div>

      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px 16px', background: 'rgba(0,0,0,0.4)' }}>
        <PlayPauseRow paused={paused} onToggle={() => setPaused(p => !p)} />
        <Timeline24h
          playheadMs={playheadMs}
          leftEdgeMs={leftEdgeMs}
          rightEdgeMs={rightEdgeMs}
          visibleMs={visibleMs}
          zoom={zoom}
          setZoom={setZoom}
          bars={bars}
          onScrub={onScrub}
        />
      </div>
    </div>
  );
}

// ── Date bar ────────────────────────────────────────────────────────────────

function DateBar({ date, onPrev, onNext, onToday, onPick, loading }) {
  return (
    <div style={{
      display:        'flex',
      alignItems:     'center',
      gap:             8,
      padding:        '10px 16px',
      borderBottom:   '1px solid var(--border)',
      background:     'rgba(0,0,0,0.3)',
    }}>
      <ArrowButton onClick={onPrev} aria-label="Previous day">‹</ArrowButton>
      <input
        type="date"
        value={date}
        onChange={e => onPick(e.target.value)}
        style={{
          padding:       '6px 10px',
          borderRadius:   6,
          border:        '1px solid var(--border)',
          background:    'var(--surface)',
          color:         'var(--text-primary)',
          fontSize:       13,
          colorScheme:   'dark',
        }}
      />
      <ArrowButton onClick={onNext} aria-label="Next day">›</ArrowButton>
      <button
        onClick={onToday}
        style={{
          marginLeft:    4,
          padding:       '6px 12px',
          borderRadius:   6,
          border:        '1px solid var(--border)',
          background:    'var(--surface)',
          color:         'var(--text-secondary)',
          fontSize:       12,
          fontWeight:     600,
          cursor:        'pointer',
        }}
      >Today</button>
      {loading && <span style={{ marginLeft: 12, color: 'var(--text-tertiary)', fontSize: 12 }}>Loading clips…</span>}
    </div>
  );
}

function ArrowButton({ children, ...rest }) {
  return (
    <button
      {...rest}
      style={{
        width:          32,
        height:         32,
        borderRadius:    6,
        border:        '1px solid var(--border)',
        background:    'var(--surface)',
        color:         'var(--text-primary)',
        fontSize:       18,
        lineHeight:     1,
        cursor:        'pointer',
      }}
    >
      {children}
    </button>
  );
}

// ── Camera grid ─────────────────────────────────────────────────────────────

function CameraTilesGrid({ cameras, queues, videoRefs, scrubLabel, onDownload, expandedCameraId, onToggleExpand }) {
  if (cameras.length === 0) {
    return <p style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>No cameras.</p>;
  }
  const isExpanded = expandedCameraId !== null;
  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: isExpanded ? '1fr' : 'repeat(auto-fill, minmax(320px, 1fr))',
      gap:                  isExpanded ? 0 : 12,
      height:               isExpanded ? '100%' : 'auto',
    }}>
      {cameras.map(cam => (
        <CameraTile
          key={cam.id}
          camera={cam}
          queue={queues[cam.id]}
          videoRefs={videoRefs}
          scrubLabel={scrubLabel}
          onDownload={() => onDownload(cam)}
          expanded={expandedCameraId === cam.id}
          hidden={isExpanded && expandedCameraId !== cam.id}
          onToggleExpand={() => onToggleExpand(cam.id)}
        />
      ))}
    </div>
  );
}

function CameraTile({ camera, queue, videoRefs, scrubLabel, onDownload, expanded, hidden, onToggleExpand }) {
  const ref = useRef(null);
  // Callback ref: fires whenever the <video> mounts or unmounts. A useEffect
  // tied to [camera.id] only ran once at mount, when queue was still
  // undefined and the <video> hadn't been rendered yet — so videoRefs never
  // got populated and the parent's queue-driver always saw v === undefined.
  const setVideoRef = useCallback((el) => {
    ref.current = el;
    if (el) videoRefs.current.set(camera.id, el);
    else    videoRefs.current.delete(camera.id);
  }, [camera.id, videoRefs]);

  // Stop the tile-level click handler from firing when the user is hitting
  // one of the corner controls. Without this, downloading also toggles
  // expand/collapse.
  const stop = (fn) => (e) => { e.stopPropagation(); fn?.(); };

  return (
    <div
      onClick={onToggleExpand}
      style={{
        position:      'relative',
        borderRadius:   expanded ? 0 : 8,
        overflow:      'hidden',
        background:    '#000',
        aspectRatio:   expanded ? 'auto' : '16 / 9',
        height:        expanded ? '100%' : undefined,
        width:         expanded ? '100%' : undefined,
        border:        expanded ? 'none' : '1px solid var(--border)',
        display:       hidden ? 'none' : 'block',
        cursor:        'pointer',
      }}>
      {queue ? (
        <video
          ref={setVideoRef}
          muted
          playsInline
          controls={false}
          style={{
            width:     '100%',
            height:    '100%',
            objectFit: expanded ? 'contain' : 'cover',
          }}
        />
      ) : (
        <div style={{
          height:        '100%',
          display:       'flex',
          alignItems:    'center',
          justifyContent: 'center',
          color:         'var(--text-tertiary)',
          fontSize:       12,
        }}>No recording at this time</div>
      )}

      <div style={{
        position:    'absolute',
        top:          8,
        left:         10,
        right:        10,
        display:     'flex',
        alignItems:  'center',
        gap:          8,
        textShadow: '0 1px 4px rgba(0,0,0,0.9)',
        pointerEvents: 'none',
      }}>
        <span style={{ fontSize: expanded ? 16 : 13, fontWeight: 600 }}>{camera.name}</span>
        <span style={{ fontSize: expanded ? 13 : 11, color: 'rgba(255,255,255,0.7)' }}>{scrubLabel}</span>
        <span style={{ flex: 1 }} />
        {expanded && (
          <TileIconButton
            title="Back to grid"
            onClick={stop(onToggleExpand)}
            style={{ pointerEvents: 'auto', width: 32, height: 32, fontSize: 16 }}
          >✕</TileIconButton>
        )}
      </div>

      <div style={{
        position:   'absolute',
        bottom:      8,
        right:       8,
        display:    'flex',
        gap:         6,
      }}>
        {queue && <TileIconButton title="Download" onClick={stop(onDownload)}>⤓</TileIconButton>}
      </div>
    </div>
  );
}

function TileIconButton({ children, style, ...rest }) {
  return (
    <button
      {...rest}
      style={{
        width:         28,
        height:        28,
        borderRadius:   6,
        border:        'none',
        background:    'rgba(0,0,0,0.55)',
        color:         '#fff',
        fontSize:       14,
        cursor:        'pointer',
        ...style,
      }}
    >{children}</button>
  );
}

// ── Play / pause row ────────────────────────────────────────────────────────

function PlayPauseRow({ paused, onToggle }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
      <button
        onClick={onToggle}
        style={{
          width:          40,
          height:         40,
          borderRadius:    20,
          border:        '1px solid var(--border)',
          background:    'var(--surface)',
          color:         'var(--text-primary)',
          cursor:        'pointer',
          fontSize:       16,
        }}
        aria-label={paused ? 'Play' : 'Pause'}
      >
        {paused ? '▶' : '❚❚'}
      </button>
    </div>
  );
}

// ── 24-hour timeline ────────────────────────────────────────────────────────

function Timeline24h({ playheadMs, leftEdgeMs, rightEdgeMs, visibleMs, zoom, setZoom, bars, onScrub }) {
  const ref = useRef(null);
  const dragRef = useRef(null);   // { anchorMs, startX, width }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ctx = el.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssW = el.clientWidth;
    const cssH = el.clientHeight;
    el.width  = Math.floor(cssW * dpr);
    el.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = cssW;
    const h = cssH;

    ctx.clearRect(0, 0, w, h);
    // Background
    ctx.fillStyle = '#16181d';
    ctx.fillRect(0, 0, w, h);
    // Hour gridlines
    ctx.strokeStyle = '#1f2228';
    ctx.lineWidth = 1;
    const firstHour = Math.floor(leftEdgeMs / 3_600_000) + 1;
    const lastHour  = Math.floor(rightEdgeMs / 3_600_000);
    for (let hr = firstHour; hr <= lastHour; hr++) {
      const x = ((hr * 3_600_000 - leftEdgeMs) / visibleMs) * w;
      if (x >= 0 && x <= w) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
    }
    // Clip availability bars
    ctx.fillStyle = 'rgba(10,132,255,0.55)';
    const barH = h * 0.65;
    const topY = (h - barH) / 2;
    for (const b of bars) {
      const xs = ((b.startMs - leftEdgeMs) / visibleMs) * w;
      const xe = ((b.endMs   - leftEdgeMs) / visibleMs) * w;
      const cs = clamp(xs, 0, w);
      const ce = clamp(xe, 0, w);
      if (ce > cs) ctx.fillRect(cs, topY, ce - cs, barH);
    }
    // Centre needle
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(w / 2, h / 2, 4, 0, Math.PI * 2); ctx.fill();
  }, [bars, leftEdgeMs, rightEdgeMs, visibleMs, playheadMs]);

  const onMouseDown = (e) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Anchor + accumulated dx, mirroring the Android Timeline24h fix —
    // a single capture at touch-down, not a stale parameter on every tick.
    const anchorMs = playheadMs;
    const startX   = e.clientX;
    const width    = rect.width;
    const liveVis  = visibleMs;

    const move = (ev) => {
      const dx = ev.clientX - startX;
      const deltaMs = -((dx / width) * liveVis);
      onScrub(anchorMs + deltaMs);
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup',   up);
    };
    dragRef.current = { anchorMs, startX, width };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup',   up);
  };

  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;     // require modifier so scroll still works
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    setZoom(z => clamp(z * factor, 0.5, 60));
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>
        <span>{fmtTimeOfDay(clamp(leftEdgeMs, 0, DAY_MS - 1))}</span>
        <span>{zoom.toFixed(1)}× · drag to scrub · Ctrl+wheel to zoom</span>
        <span>{fmtTimeOfDay(clamp(rightEdgeMs, 0, DAY_MS - 1))}</span>
      </div>
      <canvas
        ref={ref}
        onMouseDown={onMouseDown}
        onWheel={onWheel}
        style={{ width: '100%', height: 56, borderRadius: 8, cursor: dragRef.current ? 'grabbing' : 'grab', display: 'block' }}
      />
      <div style={{ textAlign: 'center', marginTop: 6, fontWeight: 600, fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>
        {fmtTimeOfDay(playheadMs)}
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

function fmtTimeOfDay(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
