import { useState, useEffect } from 'react';
import StatusDot from '../ui/StatusDot.jsx';
import LivePlayer from '../player/LivePlayer.jsx';
import { api } from '../../api/client.js';
import { effectiveStatus, statusLabel, shouldShowLive } from '../../utils/cameraStatus.js';

export default function FeaturedCamera({ camera, cameras, featuredIndex, onDotClick, onPrev, onNext, onOpen }) {
  const [hovered, setHovered] = useState(false);
  const [streamUrls, setStreamUrls] = useState(null);

  const status    = effectiveStatus(camera);
  const canLive   = shouldShowLive(status);
  const isOffline = !canLive;

  // Refetch stream URLs whenever the carousel rotates to a new camera. Reset
  // first so the previous camera's video doesn't briefly bleed into the new cell.
  useEffect(() => {
    setStreamUrls(null);
    if (!camera || !canLive) return;
    let cancelled = false;
    api.streamUrls(camera.id)
      .then(u => { if (!cancelled) setStreamUrls(u); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [camera?.id, canLive]);

  const whepUrl = streamUrls?.webrtc_url ?? null;

  if (!camera) {
    return (
      <div style={{
        width: '100%', height: '58vh', minHeight: 380,
        background: 'var(--surface)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-tertiary)', fontSize: 12,
        letterSpacing: '0.1em', textTransform: 'uppercase',
      }}>
        No cameras available
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'relative', width: '100%', height: '58vh',
        minHeight: 380, overflow: 'hidden', flexShrink: 0,
        cursor: isOffline ? 'default' : 'pointer',
      }}
      onClick={() => !isOffline && onOpen(camera, null)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Background — key triggers crossfade animation on camera change */}
      <div
        key={camera.id}
        style={{ position: 'absolute', inset: 0, animation: 'bannerFade 0.55s ease' }}
      >
        {/* Cinematic gradient — visible underneath the live feed during connect. */}
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(135deg, #0d1b2a 0%, #1a1a2e 35%, #16213e 65%, #0f3460 100%)',
        }} />
        {whepUrl && !isOffline && (
          <div style={{ position: 'absolute', inset: 0 }}>
            <LivePlayer whepUrl={whepUrl} objectFit="cover" background="transparent" />
          </div>
        )}
      </div>

      {/* Cinematic left-to-right vignette */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(to right, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.22) 45%, transparent 100%)',
        pointerEvents: 'none',
      }} />
      {/* Bottom vignette */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(to top, #0a0a0a 0%, rgba(0,0,0,0.45) 30%, transparent 60%)',
        pointerEvents: 'none',
      }} />

      {/* Offline / check-wire overlay */}
      {isOffline && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 14,
          color: status === 'check_wire' ? '#FF9F0A' : 'rgba(255,255,255,0.18)',
          background: status === 'check_wire' ? 'rgba(255,159,10,0.07)' : 'transparent',
        }}>
          {status === 'check_wire' ? <CheckWireBigIcon /> : <OfflineIcon size={44} />}
          <span style={{
            fontSize: 18, fontWeight: 800, letterSpacing: '0.18em', textTransform: 'uppercase',
          }}>
            {status === 'check_wire' ? 'Check Wire' :
             status === 'error'       ? 'Connection Error' : 'Camera Offline'}
          </span>
          {status === 'check_wire' && (
            <span style={{ fontSize: 12, color: 'rgba(255,159,10,0.85)', letterSpacing: '0.06em' }}>
              No video reaching the NVR — check camera cable / PoE
            </span>
          )}
        </div>
      )}

      {/* Camera metadata (bottom-left) */}
      <div style={{ position: 'absolute', bottom: 44, left: 36, right: 160 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <StatusDot status={status} size={7} />
          <span style={{
            fontSize: 11,
            color: status === 'check_wire' ? '#FF9F0A' : 'rgba(255,255,255,0.45)',
            letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600,
          }}>
            {status === 'check_wire'
              ? statusLabel(status)
              : (cameras.length > 1 ? `${featuredIndex + 1} of ${cameras.length}` : 'Featured Camera')}
          </span>
        </div>
        <h2 style={{
          fontSize: 'clamp(26px, 3.5vw, 48px)', fontWeight: 800,
          lineHeight: 1.05, letterSpacing: '-0.03em', marginBottom: 0,
          textShadow: '0 2px 12px rgba(0,0,0,0.4)',
        }}>
          {camera.name}
        </h2>
      </div>

      {/* Watch Live button — appears on hover */}
      {!isOffline && (
        <div style={{
          position: 'absolute', bottom: 48, right: 36,
          opacity: hovered ? 1 : 0,
          transform: hovered ? 'translateY(0)' : 'translateY(10px)',
          transition: 'opacity 0.25s var(--ease), transform 0.25s var(--ease)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 9,
            background: 'rgba(255,255,255,0.14)', backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.18)', borderRadius: 9,
            padding: '11px 22px', fontSize: 14, fontWeight: 600, color: '#fff',
          }}>
            <PlayIcon /> Watch Live
          </div>
        </div>
      )}

      {/* Manual prev/next — auto-rotate is intentionally disabled so the
          operator picks which camera to feature. e.stopPropagation prevents the
          outer banner click handler from opening the player on every arrow tap. */}
      {cameras.length > 1 && (
        <>
          <BannerArrow side="left"  onClick={e => { e.stopPropagation(); onPrev?.(); }} />
          <BannerArrow side="right" onClick={e => { e.stopPropagation(); onNext?.(); }} />
        </>
      )}

      {/* Dot / pill indicators */}
      {cameras.length > 1 && (
        <div style={{
          position: 'absolute', bottom: 14, left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex', gap: 5, alignItems: 'center',
        }}>
          {cameras.map((_, i) => (
            <button
              key={i}
              onClick={e => { e.stopPropagation(); onDotClick(i); }}
              style={{
                width: i === featuredIndex ? 20 : 6,
                height: 6, borderRadius: 3, padding: 0, border: 'none', cursor: 'pointer',
                background: i === featuredIndex ? '#fff' : 'rgba(255,255,255,0.32)',
                transition: 'width 0.35s var(--ease), background 0.25s ease',
              }}
            />
          ))}
        </div>
      )}

      <style>{`
        @keyframes bannerFade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.4 } }
      `}</style>
    </div>
  );
}

function BannerArrow({ side, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={side === 'left' ? 'Previous camera' : 'Next camera'}
      style={{
        position:       'absolute',
        top:            '50%',
        [side]:          18,
        transform:      'translateY(-50%)',
        zIndex:          25,
        width:           52,
        height:          82,
        borderRadius:    10,
        background:      hovered ? 'rgba(20,20,20,0.85)' : 'rgba(10,10,10,0.55)',
        backdropFilter: 'blur(14px)',
        border:         '1px solid rgba(255,255,255,0.10)',
        color:           hovered ? '#fff' : 'rgba(255,255,255,0.7)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        cursor:         'pointer',
        transition:     'background 0.15s, color 0.15s',
      }}
    >
      {side === 'left'
        ? <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
        : <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
      }
    </button>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
  );
}

function OfflineIcon({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M17 17H4a2 2 0 01-2-2V7a2 2 0 012-2h1"/>
      <path d="M14 5h2a2 2 0 012 2v3"/>
      <line x1="2" y1="2" x2="22" y2="22"/>
      <path d="M22 9l-4 4-4-4"/>
    </svg>
  );
}

function CheckWireBigIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l2-3 4 6 2-3h4" />
      <line x1="2" y1="2" x2="22" y2="22" opacity="0.6" />
    </svg>
  );
}
