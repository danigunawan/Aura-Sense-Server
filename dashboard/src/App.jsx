import { useState, useEffect, useRef, useCallback } from 'react';
import { useCameras, useSystemStatus } from './hooks/useCameras.js';
import NavBar      from './components/layout/NavBar.jsx';
import CameraGrid  from './components/grid/CameraGrid.jsx';
import PlayerModal from './components/player/PlayerModal.jsx';
import RecordingsPage from './components/recordings/RecordingsPage.jsx';
import SettingsPage from './components/settings/SettingsPage.jsx';
import LoginPage from './LoginPage.jsx';

export default function App({ locked = false, onUnlock }) {
  const [page,       setPage]     = useState('live');
  const [selected,   setSelected] = useState(null);   // { camera, streamUrls }
  const [navVisible, setNavVisible] = useState(true);
  const [unlockOpen, setUnlockOpen] = useState(false);

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

  // Keep nav always visible on non-live pages — except in locked mode, where
  // the only allowed view IS the live page and clicks pop the unlock modal.
  const isNavVisible = !locked && (navVisible || page !== 'live');
  const effectivePage = locked ? 'live' : page;

  return (
    <div style={{ height: '100%', background: 'var(--bg)', overflow: 'hidden' }}>
      <NavBar
        active={effectivePage}
        onChange={setPage}
        systemStatus={systemStatus}
        visible={isNavVisible}
      />

      {/* Main content — padded only when nav is always-on */}
      <div style={{ height: '100%', paddingTop: effectivePage !== 'live' ? 'var(--nav-h)' : 0 }}>
        {effectivePage === 'live' && (
          <CameraGrid
            cameras={cameras}
            onOpenCamera={(cam, urls) => setSelected({ camera: cam, streamUrls: urls })}
          />
        )}
        {effectivePage === 'settings' && (
          <div style={{ height: '100%', overflowY: 'auto' }}>
            <SettingsPage />
          </div>
        )}
        {effectivePage === 'playback' && (
          <RecordingsPage cameras={cameras} />
        )}
        {effectivePage === 'alerts' && (
          <PlaceholderPage title="Alerts" subtitle="No alerts configured yet." />
        )}
      </div>

      {selected && !locked && (
        <PlayerModal
          camera={selected.camera}
          prefetchedUrls={selected.streamUrls}
          onClose={() => setSelected(null)}
        />
      )}

      {/* Locked: transparent overlay swallows every click and pops the unlock modal */}
      {locked && !unlockOpen && (
        <div
          onClick={() => setUnlockOpen(true)}
          onContextMenu={(e) => { e.preventDefault(); setUnlockOpen(true); }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9000,
            background: 'transparent',
            cursor: 'pointer',
          }}
        />
      )}

      {locked && unlockOpen && (
        <LoginPage
          onLogin={() => { setUnlockOpen(false); onUnlock?.(); }}
          onCancel={() => setUnlockOpen(false)}
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
