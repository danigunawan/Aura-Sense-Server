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

  if (state === 'loading') return null;
  if (state === 'login')   return <LoginPage onLogin={() => setState(resolveFromToken() || 'unlocked')} />;

  return (
    <App
      locked={state === 'locked'}
      onUnlock={() => setState(resolveFromToken() || 'unlocked')}
    />
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode><Root /></StrictMode>
);
