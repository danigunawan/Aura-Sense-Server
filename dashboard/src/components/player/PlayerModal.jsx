import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client.js';
import StatusDot from '../ui/StatusDot.jsx';
import Timeline from './Timeline.jsx';
import LivePlayer from './LivePlayer.jsx';

const MIN_W = 480;
const MIN_H = 340;
const CHROME_H = 52;

function initWin() {
  const w = Math.round(Math.min(window.innerWidth  * 0.82, 1200));
  const h = Math.round(Math.min(window.innerHeight * 0.84, 760));
  return {
    x: Math.round((window.innerWidth  - w) / 2),
    y: Math.round((window.innerHeight - h) / 2),
    w, h,
  };
}

export default function PlayerModal({ camera, prefetchedUrls, onClose }) {
  const [tab,        setTab]        = useState('live');
  const [streamUrls, setStreamUrls] = useState(prefetchedUrls ?? null);
  const [loading,    setLoading]    = useState(!prefetchedUrls);
  const [error,      setError]      = useState(null);
  const [activeClip, setActiveClip] = useState(null);
  const [win,        setWin]        = useState(initWin);

  const videoRef       = useRef(null);
  const pendingSeekRef = useRef(null);
  const dragRef        = useRef(null);  // { sx, sy, ox, oy }
  const resizeRef      = useRef(null);  // { handle, sx, sy, ox, oy, ow, oh }

  // Esc closes
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  // Global mouse move/up for drag and resize
  useEffect(() => {
    function onMove(e) {
      if (dragRef.current) {
        const { sx, sy, ox, oy } = dragRef.current;
        setWin(prev => ({
          ...prev,
          x: Math.max(0, Math.min(window.innerWidth  - prev.w, ox + e.clientX - sx)),
          y: Math.max(0, Math.min(window.innerHeight - CHROME_H, oy + e.clientY - sy)),
        }));
      }
      if (resizeRef.current) {
        const { handle, sx, sy, ox, oy, ow, oh } = resizeRef.current;
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        setWin(() => {
          let x = ox, y = oy, w = ow, h = oh;
          if (handle.includes('e')) w = Math.max(MIN_W, ow + dx);
          if (handle.includes('s')) h = Math.max(MIN_H, oh + dy);
          if (handle.includes('w')) { const d = Math.min(dx, ow - MIN_W); w = ow - d; x = ox + d; }
          if (handle.includes('n')) { const d = Math.min(dy, oh - MIN_H); h = oh - d; y = oy + d; }
          return { x, y, w, h };
        });
      }
    }
    function onUp() { dragRef.current = null; resizeRef.current = null; }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, []);

  // Fetch stream URLs if not pre-fetched
  useEffect(() => {
    if (tab !== 'live' || streamUrls) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.streamUrls(camera.id)
      .then(u => { if (!cancelled) { setStreamUrls(u); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [tab, camera?.id, streamUrls]); // eslint-disable-line

  // Apply pending seek after activeClip remounts the <video>
  useEffect(() => {
    const req = pendingSeekRef.current;
    if (!req || !videoRef.current) return;
    pendingSeekRef.current = null;
    const video = videoRef.current;
    video.src = req.url;
    video.load();
    const onReady = () => {
      video.currentTime = Math.max(0, req.offsetSec);
      video.play().catch(() => {});
      video.removeEventListener('canplay', onReady);
    };
    video.addEventListener('canplay', onReady);
  }, [activeClip]); // eslint-disable-line

  function _handleSeek({ date, clip }) {
    if (!clip) return;
    const offsetSec = (date.getTime() - new Date(clip.start_time).getTime()) / 1000;
    if (activeClip?.id === clip.id && videoRef.current) {
      videoRef.current.currentTime = Math.max(0, offsetSec);
      videoRef.current.play().catch(() => {});
      return;
    }
    pendingSeekRef.current = { url: clip.play_url, offsetSec };
    setActiveClip(clip);
  }

  function startDrag(e) {
    if (e.target.closest('button, [role="button"]')) return;
    e.preventDefault();
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: win.x, oy: win.y };
  }

  function startResize(handle) {
    return (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizeRef.current = { handle, sx: e.clientX, sy: e.clientY, ox: win.x, oy: win.y, ow: win.w, oh: win.h };
    };
  }

  const modal = createPortal(
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position:   'fixed',
          inset:       0,
          zIndex:      999,
          background: 'rgba(0,0,0,0.6)',
          animation:  'fadeIn 0.15s ease',
        }}
      />

      {/* Window */}
      <div
        style={{
          position:     'fixed',
          left:          win.x,
          top:           win.y,
          width:         win.w,
          height:        win.h,
          zIndex:        1000,
          display:      'flex',
          flexDirection: 'column',
          background:   '#0d0d0d',
          borderRadius:  12,
          border:       '1px solid rgba(255,255,255,0.09)',
          boxShadow:    '0 32px 80px rgba(0,0,0,0.92), 0 0 0 1px rgba(255,255,255,0.04)',
          overflow:     'hidden',
          animation:    'scaleIn 0.18s var(--ease)',
          userSelect:   'none',
        }}
      >
        {/* ── Title bar (drag handle) ─────────────────────────────────────── */}
        <div
          onMouseDown={startDrag}
          style={{
            height:         CHROME_H,
            flexShrink:     0,
            display:       'flex',
            alignItems:    'center',
            justifyContent:'space-between',
            padding:       '0 16px',
            background:    'rgba(255,255,255,0.03)',
            borderBottom:  '1px solid rgba(255,255,255,0.07)',
            cursor:        'move',
          }}
        >
          {/* Camera info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            <StatusDot status={camera.status} size={7} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>
                {camera.name}
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 1 }}>
                {[camera.manufacturer, camera.model].filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>

          {/* Tab toggle */}
          <div style={{
            display:    'flex',
            background: 'rgba(255,255,255,0.07)',
            borderRadius: 7,
            padding:     2,
            gap:         2,
          }}>
            {['live', 'playback'].map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  padding:       '5px 16px',
                  borderRadius:   5,
                  fontSize:       11,
                  fontWeight:     600,
                  textTransform: 'capitalize',
                  letterSpacing: '0.01em',
                  background:     tab === t ? 'rgba(255,255,255,0.14)' : 'transparent',
                  color:          tab === t ? '#fff' : 'rgba(255,255,255,0.4)',
                  transition:    'all 0.12s',
                }}
              >
                {t === 'live' && <span style={{ color: 'var(--live-red)', marginRight: 5, fontSize: 7 }}>●</span>}
                {t}
              </button>
            ))}
          </div>

          {/* Close */}
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{
              width:          32,
              height:         32,
              borderRadius:  '50%',
              background:    'rgba(255,255,255,0.07)',
              color:         'rgba(255,255,255,0.55)',
              display:       'flex',
              alignItems:    'center',
              justifyContent:'center',
              fontSize:       16,
              transition:    'background 0.12s, color 0.12s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,60,60,0.7)'; e.currentTarget.style.color = '#fff'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.color = 'rgba(255,255,255,0.55)'; }}
          >
            ✕
          </button>
        </div>

        {/* ── Content area ────────────────────────────────────────────────── */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#000' }}>
          {tab === 'live' ? (
            <>
              {loading  && <Spinner />}
              {error    && <ErrorMsg text={error} />}
              {streamUrls && !loading && <LivePlayer whepUrl={streamUrls.webrtc_url} />}

              {/* LIVE badge */}
              {streamUrls && !loading && (
                <div style={{
                  position:      'absolute',
                  bottom:         16,
                  left:           16,
                  display:       'flex',
                  alignItems:    'center',
                  gap:            5,
                  background:    'var(--live-red)',
                  color:         '#fff',
                  fontSize:       9,
                  fontWeight:     800,
                  letterSpacing: '0.16em',
                  padding:       '4px 9px',
                  borderRadius:   3,
                  textTransform: 'uppercase',
                  pointerEvents: 'none',
                }}>
                  <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#fff', animation: 'pulse 1.5s ease-in-out infinite', display: 'inline-block' }} />
                  LIVE
                </div>
              )}
            </>
          ) : (
            <>
              {activeClip ? (
                <video
                  ref={videoRef}
                  controls
                  muted
                  autoPlay
                  playsInline
                  style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
                />
              ) : (
                <PlaybackPrompt />
              )}

              {activeClip && (
                <div style={{
                  position:      'absolute',
                  bottom:         16,
                  left:           16,
                  padding:       '5px 10px',
                  borderRadius:   5,
                  background:    'rgba(0,0,0,0.72)',
                  backdropFilter: 'blur(8px)',
                  fontSize:       10,
                  fontWeight:     500,
                  color:         'rgba(255,255,255,0.7)',
                  letterSpacing: '0.02em',
                  pointerEvents: 'none',
                }}>
                  {_fmtClipRange(activeClip)}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Timeline (playback tab only) ─────────────────────────────────── */}
        {tab === 'playback' && (
          <div style={{ flexShrink: 0 }}>
            <Timeline cameraId={camera.id} onSeek={_handleSeek} />
          </div>
        )}

        {/* ── Resize handles ──────────────────────────────────────────────── */}
        {[
          { id: 'n',  style: { top: 0, left: 6, right: 6, height: 5, cursor: 'n-resize' } },
          { id: 's',  style: { bottom: 0, left: 6, right: 6, height: 5, cursor: 's-resize' } },
          { id: 'e',  style: { top: 6, bottom: 6, right: 0, width: 5, cursor: 'e-resize' } },
          { id: 'w',  style: { top: 6, bottom: 6, left: 0, width: 5, cursor: 'w-resize' } },
          { id: 'nw', style: { top: 0, left: 0, width: 10, height: 10, cursor: 'nw-resize' } },
          { id: 'ne', style: { top: 0, right: 0, width: 10, height: 10, cursor: 'ne-resize' } },
          { id: 'sw', style: { bottom: 0, left: 0, width: 10, height: 10, cursor: 'sw-resize' } },
          { id: 'se', style: { bottom: 0, right: 0, width: 10, height: 10, cursor: 'se-resize' } },
        ].map(h => (
          <div
            key={h.id}
            onMouseDown={startResize(h.id)}
            style={{ position: 'absolute', ...h.style, zIndex: 10 }}
          />
        ))}
      </div>

      <style>{`
        @keyframes scaleIn {
          from { opacity: 0; transform: scale(0.96); }
          to   { opacity: 1; transform: scale(1); }
        }
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes pulse  { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
        @keyframes spin   { to { transform: rotate(360deg) } }
      `}</style>
    </>,
    document.body,
  );

  return modal;
}

function PlaybackPrompt() {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 12, color: 'var(--text-tertiary)',
    }}>
      <div style={{ fontSize: 40, opacity: 0.3 }}>▶</div>
      <div style={{ fontSize: 12, letterSpacing: '0.02em' }}>
        Select a recording on the timeline below
      </div>
    </div>
  );
}

function _fmtClipRange(clip) {
  const fmt = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = new Date(clip.start_time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${date}  ·  ${fmt(clip.start_time)} – ${fmt(clip.end_time)}`;
}

function Spinner() {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 14, color: 'var(--text-secondary)',
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: '50%',
        border: '2px solid rgba(255,255,255,0.1)',
        borderTopColor: 'var(--accent)',
        animation: 'spin 0.7s linear infinite',
      }} />
      <span style={{ fontSize: 11, letterSpacing: '0.08em' }}>Connecting…</span>
    </div>
  );
}

function ErrorMsg({ text }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 10, color: 'var(--orange)',
    }}>
      <div style={{ fontSize: 32 }}>⚠</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 300, textAlign: 'center', lineHeight: 1.7 }}>
        {text}
      </div>
    </div>
  );
}
