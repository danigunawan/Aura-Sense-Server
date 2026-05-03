import StatusDot from '../ui/StatusDot.jsx';

const NAV = [
  { id: 'live',     icon: <GridIcon />,    label: 'Live View' },
  { id: 'playback', icon: <PlayIcon />,    label: 'Playback'  },
  { id: 'alerts',   icon: <BellIcon />,    label: 'Alerts'    },
  { id: 'settings', icon: <GearIcon />,    label: 'Settings'  },
];

export default function Sidebar({ active, onChange, systemStatus }) {
  return (
    <aside style={{
      width:          'var(--sidebar-w)',
      flexShrink:      0,
      height:         '100%',
      display:        'flex',
      flexDirection:  'column',
      borderRight:    '1px solid var(--border)',
      background:     'var(--surface)',
      padding:        '16px 10px',
      gap:             4,
    }}>
      {/* Logo */}
      <div style={{
        padding:       '4px 8px 18px',
        display:       'flex',
        alignItems:    'center',
        gap:            10,
      }}>
        <div style={{
          width:          28,
          height:         28,
          borderRadius:   8,
          background:    'var(--accent)',
          display:       'flex',
          alignItems:    'center',
          justifyContent: 'center',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" />
          </svg>
        </div>
        <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em' }}>AuraSense</span>
      </div>

      {/* Nav items */}
      {NAV.map(({ id, icon, label }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            style={{
              display:        'flex',
              alignItems:     'center',
              gap:             10,
              padding:        '9px 12px',
              borderRadius:  'var(--radius-sm)',
              background:     isActive ? 'var(--surface-mid)' : 'transparent',
              color:           isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight:      isActive ? 600 : 400,
              fontSize:        13,
              textAlign:      'left',
              transition:     'background 0.12s var(--ease), color 0.12s var(--ease)',
              width:          '100%',
            }}
          >
            <span style={{ opacity: isActive ? 1 : 0.7 }}>{icon}</span>
            {label}
          </button>
        );
      })}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* System status pill */}
      {systemStatus && (
        <div style={{
          margin:        '0 2px',
          padding:       '10px 12px',
          borderRadius:  'var(--radius-sm)',
          background:    'var(--surface-mid)',
          fontSize:       11,
          color:          'var(--text-secondary)',
          lineHeight:     1.7,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: 12 }}>System</span>
            <StatusDot status={systemStatus.online > 0 ? 'online' : 'offline'} size={6} />
          </div>
          <Row label="Online"   value={systemStatus.online}  color="var(--green)" />
          <Row label="Offline"  value={systemStatus.offline} color="var(--text-tertiary)" />
          {systemStatus.error > 0 &&
            <Row label="Errors" value={systemStatus.error}   color="var(--orange)" />}
          <Row label="Total"    value={systemStatus.total_cameras} />
        </div>
      )}
    </aside>
  );
}

function Row({ label, value, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span>{label}</span>
      <span style={{ fontWeight: 600, color: color ?? 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}

function GridIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>;
}
function PlayIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/></svg>;
}
function BellIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>;
}
function GearIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>;
}
