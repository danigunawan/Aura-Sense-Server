import { useState, useEffect } from 'react';
import StatusDot from '../ui/StatusDot.jsx';
import { api } from '../../api/client.js';
import LivePlayer from '../player/LivePlayer.jsx';

export default function CameraCell({ camera, onOpen, onFeature }) {
  const [hovered,    setHovered]    = useState(false);
  const [streamUrls, setStreamUrls] = useState(null);

  const isOffline = camera.status !== 'online';

  useEffect(() => {
    if (isOffline) return;
    let cancelled = false;
    api.streamUrls(camera.id)
      .then(u => { if (!cancelled) setStreamUrls(u); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [camera.id, isOffline]);

  const whepUrl = streamUrls?.webrtc_url ?? null;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position:    'relative',
        width:       '100%',
        aspectRatio: '16/9',
        borderRadius: 'var(--radius)',
        overflow:    'visible',
        zIndex:       hovered ? 10 : 1,
      }}
    >
      {/* Card — transforms on hover */}
      <div
        onClick={() => onOpen(camera, streamUrls)}
        style={{
          position:     'absolute',
          inset:         0,
          borderRadius: 'var(--radius)',
          overflow:     'hidden',
          background:   'var(--surface)',
          transform:     hovered ? 'scale(1.07)' : 'scale(1)',
          boxShadow:     hovered
            ? '0 24px 64px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.08)'
            : '0 2px 8px rgba(0,0,0,0.4)',
          transition:   'transform 0.28s var(--ease-spring), box-shadow 0.28s var(--ease)',
          cursor:        'pointer',
        }}
      >
        {/* Live feed */}
        {!isOffline && whepUrl && (
          <div style={{ position: 'absolute', inset: 0 }}>
            <LivePlayer whepUrl={whepUrl} objectFit="cover" />
          </div>
        )}

        {/* Offline state */}
        {isOffline && (
          <div style={{
            position:       'absolute',
            inset:           0,
            display:        'flex',
            flexDirection:  'column',
            alignItems:     'center',
            justifyContent: 'center',
            gap:             6,
            color:          'var(--text-tertiary)',
          }}>
            <OfflineIcon />
            <span style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600 }}>
              {camera.status === 'error' ? 'Error' : 'Offline'}
            </span>
          </div>
        )}

        {/* Bottom gradient */}
        <div style={{
          position:      'absolute',
          bottom:         0, left: 0, right: 0,
          height:        '65%',
          background:    'linear-gradient(to top, rgba(0,0,0,0.92) 0%, transparent 100%)',
          pointerEvents: 'none',
        }} />

        {/* Status badge — top right */}
        <div style={{
          position:       'absolute',
          top:             8,
          right:           8,
          display:        'flex',
          alignItems:     'center',
          gap:             4,
          background:     'rgba(0,0,0,0.65)',
          backdropFilter: 'blur(8px)',
          borderRadius:    20,
          padding:        '2px 7px 2px 5px',
          fontSize:        9,
          fontWeight:      700,
          letterSpacing:  '0.09em',
          textTransform:  'uppercase',
          color:          'rgba(255,255,255,0.7)',
        }}>
          <StatusDot status={camera.status} size={5} />
          {camera.status}
        </div>

        {/* Camera name — bottom */}
        <div style={{ position: 'absolute', bottom: 10, left: 10, right: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.2, letterSpacing: '-0.01em' }}>
            {camera.name}
          </div>
        </div>

        {/* Hover: expand indicator */}
        {!isOffline && hovered && (
          <div style={{
            position:       'absolute',
            inset:           0,
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
            background:     'rgba(0,0,0,0.2)',
          }}>
            <div style={{
              width:          40,
              height:         40,
              borderRadius:  '50%',
              background:    'rgba(255,255,255,0.92)',
              display:       'flex',
              alignItems:    'center',
              justifyContent: 'center',
              boxShadow:     '0 4px 20px rgba(0,0,0,0.4)',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="#000">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            </div>
          </div>
        )}
      </div>

      {/* Context menu on hover: "Set as Featured" */}
      {hovered && onFeature && (
        <div
          onClick={(e) => { e.stopPropagation(); onFeature(camera.id); }}
          style={{
            position:       'absolute',
            bottom:         -32,
            left:           '50%',
            transform:      'translateX(-50%)',
            whiteSpace:     'nowrap',
            background:     'rgba(20,20,20,0.95)',
            backdropFilter: 'blur(10px)',
            border:         '1px solid rgba(255,255,255,0.08)',
            borderRadius:    6,
            padding:        '5px 12px',
            fontSize:        11,
            color:          'rgba(255,255,255,0.7)',
            cursor:         'pointer',
            zIndex:          20,
          }}
        >
          Set as Featured
        </div>
      )}
    </div>
  );
}

function OfflineIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M17 17H4a2 2 0 01-2-2V7a2 2 0 012-2h1"/>
      <path d="M14 5h2a2 2 0 012 2v3"/>
      <line x1="2" y1="2" x2="22" y2="22"/>
    </svg>
  );
}
