import { useState, useEffect, useRef, useCallback } from 'react';
import { useCameras, useSystemStatus } from './hooks/useCameras.js';
import NavBar      from './components/layout/NavBar.jsx';
import CameraGrid  from './components/grid/CameraGrid.jsx';
import PlayerModal from './components/player/PlayerModal.jsx';
import RecordingsPage from './components/recordings/RecordingsPage.jsx';
import SettingsPage from './components/settings/SettingsPage.jsx';

export default function App() {
  const [page,       setPage]     = useState('live');
  const [selected,   setSelected] = useState(null);   // { camera, streamUrls }
  const [navVisible, setNavVisible] = useState(true);

  const { cameras } = useCameras();
  const systemStatus = useSystemStatus();

  // Auto-hide nav after 4 s of mouse inactivity
  const hideTimer = useRef(null);
  const showNav = useCallback(() => {
    setNavVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setNavVisible(false), 4000);
  }, []);

  useEffect(() => {
    showNav();
    document.addEventListener('mousemove', showNav);
    return () => {
      document.removeEventListener('mousemove', showNav);
      clearTimeout(hideTimer.current);
    };
  }, [showNav]);

  // Keep nav always visible on non-live pages
  const isNavVisible = navVisible || page !== 'live';

  return (
    <div style={{ height: '100%', background: 'var(--bg)', overflow: 'hidden' }}>
      <NavBar
        active={page}
        onChange={setPage}
        systemStatus={systemStatus}
        visible={isNavVisible}
      />

      {/* Main content — padded only when nav is always-on */}
      <div style={{ height: '100%', paddingTop: page !== 'live' ? 'var(--nav-h)' : 0 }}>
        {page === 'live' && (
          <CameraGrid
            cameras={cameras}
            onOpenCamera={(cam, urls) => setSelected({ camera: cam, streamUrls: urls })}
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
