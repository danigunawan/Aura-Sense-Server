import { StrictMode, useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import LoginPage from './LoginPage.jsx';
import {
  api,
  setToken,
  clearToken,
  decodeTokenRole,
  setUnauthHandler,
} from './api/client.js';

// Kiosk: hide cursor after 3 s of inactivity
let _cursorTimer;
function initCursorHide() {
  const hide = () => { document.body.style.cursor = 'none'; };
  const show = () => {
    document.body.style.cursor = '';
    clearTimeout(_cursorTimer);
    _cursorTimer = setTimeout(hide, 3000);
  };
  document.addEventListener('mousemove', show);
  show();
}
initCursorHide();

// Auth state machine:
//   'loading'   → first render, deciding what to show
//   'locked'    → live page visible, any click opens the unlock modal (viewer token)
//   'unlocked'  → full UI (admin/user token)
//   'login'     → fullscreen login (no kiosk token available, e.g. remote browser)
function Root() {
  const [state, setState] = useState('loading');
  const [splashVisible, setSplashVisible] = useState(true);
  const [splashMounted, setSplashMounted] = useState(true);

  const resolveFromToken = useCallback(() => {
    const token = localStorage.getItem('nvr_token');
    const role  = decodeTokenRole(token);
    if (role === 'admin' || role === 'user') return 'unlocked';
    if (role === 'viewer') return 'locked';
    return null;
  }, []);

  const acquireKioskToken = useCallback(async () => {
    try {
      const data = await api.kioskToken();
      if (data?.access_token) {
        setToken(data.access_token);
        return 'locked';
      }
    } catch {
      /* fallthrough → login screen */
    }
    return 'login';
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fromExisting = resolveFromToken();
      if (fromExisting) {
        if (!cancelled) setState(fromExisting);
        return;
      }
      const next = await acquireKioskToken();
      if (!cancelled) setState(next);
    })();
    return () => { cancelled = true; };
  }, [resolveFromToken, acquireKioskToken]);

  // Show splash for ~6 s after auth resolves so feeds have time to connect.
  useEffect(() => {
    if (state !== 'locked' && state !== 'unlocked') return;
    const t1 = setTimeout(() => setSplashVisible(false), 6000);
    const t2 = setTimeout(() => setSplashMounted(false), 6800);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [state]);

  // 401 → drop the current credentials and fall back to a kiosk token so the
  // live view never disappears behind a login wall. Only escalate to the full
  // login screen if even the kiosk token endpoint refuses us.
  useEffect(() => {
    setUnauthHandler(async () => {
      clearToken();
      const next = await acquireKioskToken();
      setState(next);
    });
  }, [acquireKioskToken]);

  if (state === 'loading') return <BootSplash visible />;
  if (state === 'login')   return <LoginPage onLogin={() => setState(resolveFromToken() || 'unlocked')} />;

  return (
    <>
      <App
        locked={state === 'locked'}
        onUnlock={() => setState(resolveFromToken() || 'unlocked')}
      />
      {splashMounted && <BootSplash visible={splashVisible} />}
    </>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode><Root /></StrictMode>
);

function BootSplash({ visible }) {
  return (
    <div style={{
      position:      'fixed',
      inset:          0,
      zIndex:         99999,
      background:    '#070809',
      display:       'flex',
      flexDirection: 'column',
      alignItems:    'center',
      justifyContent:'center',
      gap:            48,
      opacity:        visible ? 1 : 0,
      transition:    'opacity 0.8s cubic-bezier(0.4,0,0.2,1)',
      pointerEvents:  visible ? 'auto' : 'none',
    }}>
      <style>{`
        @keyframes bsRing {
          0%,100% { transform: scale(1);   opacity: 0.55; }
          50%      { transform: scale(1.5); opacity: 0; }
        }
        @keyframes bsSpin {
          to { transform: rotate(360deg); }
        }
        @keyframes bsShimmer {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(250%); }
        }
        @keyframes bsPulse {
          0%,100% { opacity: 0.7; }
          50%      { opacity: 1; }
        }
      `}</style>

      {/* Logo mark */}
      <div style={{ position: 'relative', width: 112, height: 112 }}>
        {/* Outer pulsing ring 1 */}
        <div style={{
          position: 'absolute', inset: -20, borderRadius: '50%',
          border: '1px solid rgba(10,132,255,0.22)',
          animation: 'bsRing 2.6s ease-out infinite',
        }} />
        {/* Outer pulsing ring 2 */}
        <div style={{
          position: 'absolute', inset: -40, borderRadius: '50%',
          border: '1px solid rgba(10,132,255,0.10)',
          animation: 'bsRing 2.6s ease-out infinite 0.55s',
        }} />
        {/* Spinning arc */}
        <div style={{
          position: 'absolute', inset: -5, borderRadius: '50%',
          border: '1.5px solid transparent',
          borderTopColor: '#0A84FF',
          borderRightColor: 'rgba(10,132,255,0.35)',
          boxShadow: '0 0 16px rgba(10,132,255,0.4)',
          animation: 'bsSpin 2s linear infinite',
        }} />
        {/* Main circle */}
        <div style={{
          width: 112, height: 112, borderRadius: '50%',
          background: 'radial-gradient(circle at 38% 32%, rgba(10,132,255,0.2) 0%, rgba(10,132,255,0.06) 55%, transparent 78%)',
          border: '1.5px solid rgba(10,132,255,0.42)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 0 70px rgba(10,132,255,0.14), 0 0 24px rgba(10,132,255,0.09), inset 0 0 44px rgba(10,132,255,0.04)',
          animation: 'bsPulse 2.6s ease-in-out infinite',
        }}>
          {/* Camera icon */}
          <svg width="50" height="50" viewBox="0 0 24 24" fill="none"
               stroke="rgba(10,132,255,0.92)" strokeWidth="1.35"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 7l-7 5 7 5V7z"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
          </svg>
        </div>
      </div>

      {/* Brand text */}
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{
          fontSize: 36, fontWeight: 700,
          letterSpacing: '-0.03em',
          color: '#ffffff',
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif',
        }}>
          6th Sense
        </div>
        <div style={{
          fontSize: 11, fontWeight: 500,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.28)',
          fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
        }}>
          Security Intelligence
        </div>
      </div>

      {/* Shimmer progress bar */}
      <div style={{
        width: 160, height: 2, borderRadius: 2,
        background: 'rgba(255,255,255,0.05)',
        overflow: 'hidden', position: 'relative',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(90deg, transparent 0%, rgba(10,132,255,0.85) 50%, transparent 100%)',
          animation: 'bsShimmer 1.7s ease-in-out infinite',
        }} />
      </div>
    </div>
  );
}
