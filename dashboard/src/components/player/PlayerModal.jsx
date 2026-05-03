import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client.js';
import StatusDot from '../ui/StatusDot.jsx';
import Timeline from './Timeline.jsx';
import LivePlayer from './LivePlayer.jsx';

export default function PlayerModal({ camera, prefetchedUrls, onClose }) {
  const [tab,              setTab]            = useState('live');
  const [streamUrls,       setStreamUrls]     = useState(prefetchedUrls ?? null);
  const [loading,          setLoading]        = useState(!prefetchedUrls);
  const [error,            setError]          = useState(null);
  const [activeClip,       setActiveClip]     = useState(null);   // clip currently loaded in <video>
  const [controlsVisible,  setControlsVisible] = useState(true);
  const hideTimer      = useRef(null);
  const videoRef       = useRef(null);
  const pendingSeekRef = useRef(null);  // { url, offsetSec } — set before activeClip state update

  // Esc closes
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Auto-hide chrome overlay while watching
  function showControls() {
    setControlsVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), 3500);
  }

  useEffect(() => {
    showControls();
    return () => clearTimeout(hideTimer.current);
  }, []); // eslint-disable-line

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

  // After activeClip state change mounts the <video> element, apply the
  // pending seek. Using a ref avoids an extra render cycle.
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

  // Called by Timeline with { date: Date, clip: ClipResponse|null }
  function _handleSeek({ date, clip }) {
    if (!clip) return;
    const offsetSec = (date.getTime() - new Date(clip.start_time).getTime()) / 1000;

    if (activeClip?.id === clip.id && videoRef.current) {
      // Same clip already loaded — seek directly without remounting
      const video = videoRef.current;
      video.currentTime = Math.max(0, offsetSec);
      video.play().catch(() => {});
      return;
    }

    // <video> not mounted yet — store the seek, then trigger the render
    pendingSeekRef.current = { url: clip.download_url, offsetSec };
    setActiveClip(clip);
  }

  const modal = (
    <div
      onMouseMove={showControls}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position:      'fixed',
        inset:          0,
        zIndex:         1000,
        background:    '#000',
        display:       'flex',
        flexDirection: 'column',
        animation:     'fadeIn 0.18s var(--ease)',
      }}
    >
      {/* Top chrome — auto-hides */}
      <div style={{
        position:       'absolute',
        top:             0,
        left:            0,
        right:           0,
        height:          80,
        background:     'linear-gradient(to bottom, rgba(0,0,0,0.92) 0%, transparent 100%)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        padding:        '0 28px',
        zIndex:          10,
        opacity:         controlsVisible ? 1 : 0,
        transition:     'opacity 0.4s var(--ease)',
        pointerEvents:   controlsVisible ? 'all' : 'none',
      }}>
        {/* Camera info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <StatusDot status={camera.status} size={8} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, letterSpacing: '-0.02em' }}>
              {camera.name}
            </div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.38)', marginTop: 2 }}>
              {[camera.manufacturer, camera.model].filter(Boolean).join(' · ')}
            </div>
          </div>
        </div>

        {/* Tab toggle */}
        <div style={{
          display:    'flex',
          background: 'rgba(255,255,255,0.08)',
          borderRadius: 8,
          padding:     2,
          gap:         2,
        }}>
          {['live', 'playback'].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding:       '6px 18px',
                borderRadius:   6,
                fontSize:       12,
                fontWeight:     600,
                textTransform: 'capitalize',
                letterSpacing: '0.01em',
                background:     tab === t ? 'rgba(255,255,255,0.16)' : 'transparent',
                color:          tab === t ? '#fff' : 'rgba(255,255,255,0.45)',
                transition:    'all 0.15s var(--ease)',
              }}
            >
              {t === 'live' && (
                <span style={{ color: 'var(--live-red)', marginRight: 5, fontSize: 8 }}>●</span>
              )}
              {t}
            </button>
          ))}
        </div>

        {/* Close button */}
        <button
          onClick={onClose}
          title="Close (Esc)"
          style={{
            width:          38,
            height:         38,
            borderRadius:  '50%',
            background:    'rgba(255,255,255,0.09)',
            color:         'rgba(255,255,255,0.65)',
            display:       'flex',
            alignItems:    'center',
            justifyContent: 'center',
            fontSize:       18,
            transition:    'background 0.15s, color 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)'; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.09)'; e.currentTarget.style.color = 'rgba(255,255,255,0.65)'; }}
        >
          ✕
        </button>
      </div>

      {/* Video area — full screen */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {tab === 'live' ? (
          <>
            {loading  && <Spinner />}
            {error    && <ErrorMsg text={error} />}
            {streamUrls && !loading && (
              <LivePlayer whepUrl={`${streamUrls.webrtc_url}/whep`} />
            )}
          </>
        ) : (
          <>
            {activeClip ? (
              <video
                ref={videoRef}
                controls
                style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
              />
            ) : (
              <PlaybackPrompt />
            )}

            {/* Clip info overlay — bottom-left, fades with controls */}
            {activeClip && (
              <div style={{
                position:      'absolute',
                bottom:         28,
                left:           28,
                padding:       '6px 12px',
                borderRadius:   6,
                background:    'rgba(0,0,0,0.72)',
                backdropFilter: 'blur(8px)',
                fontSize:       11,
                fontWeight:     500,
                color:         'rgba(255,255,255,0.75)',
                letterSpacing: '0.02em',
                opacity:        controlsVisible ? 1 : 0,
                transition:    'opacity 0.4s var(--ease)',
                pointerEvents: 'none',
              }}>
                {_fmtClipRange(activeClip)}
              </div>
            )}
          </>
        )}

        {/* LIVE badge — bottom left */}
        {tab === 'live' && streamUrls && !loading && (
          <div style={{
            position:       'absolute',
            bottom:          28,
            left:            28,
            display:        'flex',
            alignItems:     'center',
            gap:             6,
            background:     'var(--live-red)',
            color:          '#fff',
            fontSize:        9,
            fontWeight:      800,
            letterSpacing:  '0.18em',
            padding:        '5px 10px',
            borderRadius:    3,
            textTransform:  'uppercase',
            opacity:         controlsVisible ? 1 : 0,
            transition:     'opacity 0.4s var(--ease)',
          }}>
            <span style={{
              width:       5,
              height:      5,
              borderRadius: '50%',
              background:  '#fff',
              animation:   'pulse 1.5s ease-in-out infinite',
              display:     'inline-block',
              flexShrink:   0,
            }} />
            LIVE
          </div>
        )}
      </div>

      {/* Timeline strip — playback only */}
      {tab === 'playback' && (
        <div style={{
          opacity:    controlsVisible ? 1 : 0,
          transition: 'opacity 0.4s var(--ease)',
        }}>
          <Timeline cameraId={camera.id} onSeek={_handleSeek} />
        </div>
      )}
    </div>
  );

  return createPortal(modal, document.body);
}

function PlaybackPrompt() {
  return (
    <div style={{
      position:       'absolute',
      inset:           0,
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      justifyContent: 'center',
      gap:             12,
      color:          'var(--text-tertiary)',
    }}>
      <div style={{ fontSize: 44, opacity: 0.3 }}>▶</div>
      <div style={{ fontSize: 13, letterSpacing: '0.02em' }}>
        Select a recording on the timeline below
      </div>
    </div>
  );
}

function _fmtClipRange(clip) {
  const fmt = (iso) => new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const date = new Date(clip.start_time).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short',
  });
  return `${date}  ·  ${fmt(clip.start_time)} – ${fmt(clip.end_time)}`;
}

function Spinner() {
  return (
    <div style={{
      position:       'absolute',
      inset:           0,
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      justifyContent: 'center',
      gap:             14,
      color:          'var(--text-secondary)',
    }}>
      <div style={{
        width:            32,
        height:           32,
        borderRadius:    '50%',
        border:          '2px solid rgba(255,255,255,0.1)',
        borderTopColor:  'var(--accent)',
        animation:       'spin 0.7s linear infinite',
      }} />
      <span style={{ fontSize: 12, letterSpacing: '0.08em' }}>Connecting…</span>
    </div>
  );
}

function ErrorMsg({ text }) {
  return (
    <div style={{
      position:       'absolute',
      inset:           0,
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      justifyContent: 'center',
      gap:             10,
      color:          'var(--orange)',
    }}>
      <div style={{ fontSize: 36 }}>⚠</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 340, textAlign: 'center', lineHeight: 1.7 }}>
        {text}
      </div>
    </div>
  );
}
