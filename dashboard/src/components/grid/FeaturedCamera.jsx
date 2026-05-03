import { useState, useEffect } from 'react';
import { api } from '../../api/client.js';
import StatusDot from '../ui/StatusDot.jsx';
import LivePlayer from '../player/LivePlayer.jsx';

export default function FeaturedCamera({ camera, onOpen }) {
  const [hovered,    setHovered]    = useState(false);
  const [streamUrls, setStreamUrls] = useState(null);

  const isOffline = camera?.status !== 'online';

  useEffect(() => {
    if (!camera || isOffline) return;
    let cancelled = false;
    api.streamUrls(camera.id)
      .then(u => { if (!cancelled) setStreamUrls(u); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [camera?.id, isOffline]);

  const whepUrl = streamUrls ? `${streamUrls.webrtc_url}/whep` : null;

  if (!camera) {
    return (
      <div style={{
        width:          '100%',
        height:         '58vh',
        minHeight:       380,
        background:     'var(--surface)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        color:          'var(--text-tertiary)',
        fontSize:        12,
        letterSpacing:  '0.1em',
        textTransform:  'uppercase',
      }}>
        No cameras available
      </div>
    );
  }

  return (
    <div
      style={{
        position:  'relative',
        width:     '100%',
        height:    '58vh',
        minHeight:  380,
        overflow:  'hidden',
        cursor:     isOffline ? 'default' : 'pointer',
        flexShrink: 0,
      }}
      onClick={() => !isOffline && onOpen(camera, streamUrls)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Background: live feed or offline gradient */}
      {!isOffline ? (
        <div style={{ position: 'absolute', inset: 0 }}>
          <LivePlayer whepUrl={whepUrl} objectFit="cover" />
        </div>
      ) : (
        <div style={{
          position:   'absolute',
          inset:       0,
          background: 'linear-gradient(135deg, #0d1b2a 0%, #1a1a2e 35%, #16213e 65%, #0f3460 100%)',
        }} />
      )}

      {/* Cinematic left-to-right vignette */}
      <div style={{
        position:      'absolute',
        inset:          0,
        background:    'linear-gradient(to right, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.25) 45%, transparent 100%)',
        pointerEvents: 'none',
      }} />
      {/* Bottom vignette */}
      <div style={{
        position:      'absolute',
        inset:          0,
        background:    'linear-gradient(to top, #0a0a0a 0%, rgba(0,0,0,0.5) 30%, transparent 60%)',
        pointerEvents: 'none',
      }} />

      {/* Offline overlay */}
      {isOffline && (
        <div style={{
          position:       'absolute',
          inset:           0,
          display:        'flex',
          flexDirection:  'column',
          alignItems:     'center',
          justifyContent: 'center',
          gap:             10,
          color:          'rgba(255,255,255,0.15)',
        }}>
          <OfflineIcon size={44} />
          <span style={{ fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase' }}>
            {camera.status === 'error' ? 'Connection Error' : 'Camera Offline'}
          </span>
        </div>
      )}

      {/* LIVE badge */}
      {!isOffline && (
        <div style={{
          position:      'absolute',
          top:            28,
          left:           32,
          display:       'flex',
          alignItems:    'center',
          gap:            6,
          background:    'var(--live-red)',
          color:         '#fff',
          fontSize:       9,
          fontWeight:     800,
          letterSpacing: '0.18em',
          padding:       '4px 10px',
          borderRadius:   3,
          textTransform: 'uppercase',
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

      {/* Bottom-left: camera metadata */}
      <div style={{
        position: 'absolute',
        bottom:    36,
        left:      36,
        right:     160,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <StatusDot status={camera.status} size={7} />
          <span style={{
            fontSize:      11,
            color:         'rgba(255,255,255,0.45)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            fontWeight:     500,
          }}>
            Featured Camera
          </span>
        </div>
        <h2 style={{
          fontSize:      'clamp(26px, 3.5vw, 48px)',
          fontWeight:     800,
          lineHeight:     1.05,
          letterSpacing: '-0.03em',
          marginBottom:   8,
          textShadow:    '0 2px 12px rgba(0,0,0,0.4)',
        }}>
          {camera.name}
        </h2>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>
          {[camera.manufacturer, camera.model, camera.ip_address].filter(Boolean).join(' · ')}
        </p>
      </div>

      {/* Watch Live button — appears on hover */}
      {!isOffline && (
        <div style={{
          position:  'absolute',
          bottom:     40,
          right:      36,
          opacity:    hovered ? 1 : 0,
          transform:  hovered ? 'translateY(0)' : 'translateY(10px)',
          transition: 'opacity 0.25s var(--ease), transform 0.25s var(--ease)',
        }}>
          <div style={{
            display:        'flex',
            alignItems:     'center',
            gap:             9,
            background:     'rgba(255,255,255,0.14)',
            backdropFilter: 'blur(20px)',
            border:         '1px solid rgba(255,255,255,0.18)',
            borderRadius:    9,
            padding:        '11px 22px',
            fontSize:        14,
            fontWeight:      600,
            color:          '#fff',
          }}>
            <PlayIcon />
            Watch Live
          </div>
        </div>
      )}
    </div>
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
