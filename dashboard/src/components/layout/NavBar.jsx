import { useState, useEffect } from 'react';
import StatusDot from '../ui/StatusDot.jsx';

const NAV_ITEMS = [
  { id: 'live',     label: 'Live' },
  { id: 'playback', label: 'Recordings' },
  { id: 'alerts',   label: 'Alerts' },
  { id: 'settings', label: 'Settings' },
];

export default function NavBar({ active, onChange, systemStatus, visible }) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = time.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <nav style={{
      position:      'fixed',
      top:            0,
      left:           0,
      right:          0,
      height:        'var(--nav-h)',
      zIndex:         200,
      display:       'flex',
      alignItems:    'center',
      padding:       '0 40px',
      background:    'linear-gradient(to bottom, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.5) 70%, transparent 100%)',
      opacity:        visible ? 1 : 0,
      pointerEvents:  visible ? 'all' : 'none',
      transition:    'opacity 0.45s var(--ease)',
      userSelect:    'none',
    }}>

      {/* Logo + wordmark */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 52, flexShrink: 0 }}>
        <img
          src="/logo.png"
          alt="6th Sense"
          width={30}
          height={30}
          style={{ borderRadius: '50%', flexShrink: 0, boxShadow: '0 0 16px rgba(255,255,255,0.15)' }}
        />
        <span style={{ fontWeight: 800, fontSize: 16, letterSpacing: '-0.04em', color: '#fff' }}>
          6TH SENSE
        </span>
      </div>

      {/* Nav links */}
      <div style={{ display: 'flex', gap: 2, flex: 1 }}>
        {NAV_ITEMS.map(({ id, label }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              onClick={() => onChange(id)}
              style={{
                padding:       '7px 18px',
                borderRadius:   6,
                fontSize:       14,
                fontWeight:     isActive ? 700 : 400,
                color:          isActive ? '#fff' : 'rgba(255,255,255,0.6)',
                background:     isActive ? 'rgba(255,255,255,0.1)' : 'transparent',
                letterSpacing: '-0.01em',
                transition:    'all 0.15s var(--ease)',
              }}
              onMouseEnter={e => { if (!isActive) { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; } }}
              onMouseLeave={e => { if (!isActive) { e.currentTarget.style.color = 'rgba(255,255,255,0.6)'; e.currentTarget.style.background = 'transparent'; } }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Right: status pill + clock */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexShrink: 0 }}>
        {systemStatus && (
          <div style={{
            display:        'flex',
            alignItems:     'center',
            gap:             6,
            padding:        '4px 12px',
            borderRadius:    20,
            background:     'rgba(255,255,255,0.05)',
            border:         '1px solid rgba(255,255,255,0.07)',
            fontSize:        12,
            color:          'rgba(255,255,255,0.5)',
          }}>
            <StatusDot status={systemStatus.online > 0 ? 'online' : 'offline'} size={6} />
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {systemStatus.online} / {systemStatus.total_cameras}
            </span>
          </div>
        )}

        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>
            {timeStr}
          </div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 1, letterSpacing: '0.04em' }}>
            {dateStr.toUpperCase()}
          </div>
        </div>
      </div>
    </nav>
  );
}
