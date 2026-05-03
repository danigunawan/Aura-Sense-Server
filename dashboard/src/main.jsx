import { StrictMode, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import LoginPage from './LoginPage.jsx';
import { setUnauthHandler } from './api/client.js';

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

function Root() {
  const [authed, setAuthed] = useState(() => !!localStorage.getItem('nvr_token'));

  useEffect(() => {
    setUnauthHandler(() => setAuthed(false));
  }, []);

  if (!authed) return <LoginPage onLogin={() => setAuthed(true)} />;
  return <App />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode><Root /></StrictMode>
);
