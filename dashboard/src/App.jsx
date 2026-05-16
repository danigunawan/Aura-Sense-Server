import { useState, useRef } from 'react';
import { useCameras, useSystemStatus } from './hooks/useCameras.js';
import NavBar         from './components/layout/NavBar.jsx';
import CameraGrid     from './components/grid/CameraGrid.jsx';
import PlayerModal    from './components/player/PlayerModal.jsx';
import RecordingsPage from './components/recordings/RecordingsPage.jsx';
import SettingsPage   from './components/settings/SettingsPage.jsx';
import LoginPage      from './LoginPage.jsx';

export default function App({ locked = false, onUnlock }) {
  const [page,        setPage]        = useState('live');
  const [selected,    setSelected]    = useState(null);   // { camera, streamUrls }
  const [unlockOpen,  setUnlockOpen]  = useState(false);
  const [pendingPage, setPendingPage] = useState(null);

  const { cameras }  = useCameras();
  const systemStatus = useSystemStatus();
  const gridScrollRef = useRef(null);

  // Live page is open to everyone. Recordings / Settings / Events require login.
  function handleNavChange(id) {
    if (locked && id !== 'live') {
      setPendingPage(id);
      setUnlockOpen(true);
    } else {
      setPage(id);
    }
  }

  // After a successful login, land on the page the user originally tapped.
  function handleUnlock() {
    const dest = pendingPage || 'live';
    setUnlockOpen(false);
    setPendingPage(null);
    onUnlock?.();
    setPage(dest);
  }

  return (
    <div style={{ height: '100%', background: 'var(--bg)', overflow: 'hidden' }}>
      <NavBar
        active={page}
        onChange={handleNavChange}
        systemStatus={systemStatus}
        visible={true}
      />

      {/* Live page: nav overlays content (no top padding). Other pages: nav sits above. */}
      <div style={{ height: '100%', paddingTop: page !== 'live' ? 'var(--nav-h)' : 0 }}>
        {page === 'live' && (
          <CameraGrid
            cameras={cameras}
            onOpenCamera={(cam, urls) => setSelected({ camera: cam, streamUrls: urls })}
            scrollRef={gridScrollRef}
          />
        )}
        {page === 'settings' && (
          <div style={{ height: '100%', overflowY: 'auto' }}>
            <SettingsPage />
          </div>
        )}
        {page === 'playback' && (
          <RecordingsPage cameras={cameras} />
        )}
        {page === 'alerts' && (
          <PlaceholderPage title="Alerts" subtitle="No alerts configured yet." />
        )}
      </div>

      {selected && (
        <PlayerModal
          camera={selected.camera}
          prefetchedUrls={selected.streamUrls}
          onClose={() => setSelected(null)}
        />
      )}

      {unlockOpen && (
        <LoginPage
          onLogin={handleUnlock}
          onCancel={() => { setUnlockOpen(false); setPendingPage(null); }}
        />
      )}
    </div>
  );
}

function PlaceholderPage({ title, subtitle }) {
  return (
    <div style={{
      height:         '100%',
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      justifyContent: 'center',
      gap:             10,
      color:          'var(--text-tertiary)',
    }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '-0.02em' }}>
        {title}
      </div>
      <div style={{ fontSize: 13, maxWidth: 320, textAlign: 'center', lineHeight: 1.7 }}>
        {subtitle}
      </div>
    </div>
  );
}
