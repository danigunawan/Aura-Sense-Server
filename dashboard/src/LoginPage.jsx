import { useState } from 'react';
import { api, setToken } from './api/client.js';

export default function LoginPage({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username || !password) return;
    setLoading(true);
    setError('');
    try {
      const data = await api.login(username, password);
      setToken(data.access_token);
      onLogin();
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      position:       'fixed',
      inset:           0,
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'center',
      background:     'var(--bg)',
      overflow:       'hidden',
    }}>
      {/* Ambient glow mesh */}
      <div style={{
        position:   'absolute',
        inset:       0,
        background: 'radial-gradient(ellipse at 20% 50%, rgba(10,132,255,0.09) 0%, transparent 55%), radial-gradient(ellipse at 80% 20%, rgba(48,209,88,0.05) 0%, transparent 45%), radial-gradient(ellipse at 60% 85%, rgba(255,149,0,0.04) 0%, transparent 40%)',
        pointerEvents: 'none',
      }} />

      {/* Subtle grid */}
      <div style={{
        position:        'absolute',
        inset:            0,
        backgroundImage: 'linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.018) 1px, transparent 1px)',
        backgroundSize:  '64px 64px',
        pointerEvents:   'none',
      }} />

      {/* Card */}
      <div style={{
        position:       'relative',
        width:           390,
        background:     'rgba(18, 18, 18, 0.82)',
        backdropFilter: 'blur(28px)',
        borderRadius:    18,
        border:         '1px solid rgba(255,255,255,0.07)',
        padding:        '48px 40px 40px',
        boxShadow:      '0 48px 96px rgba(0,0,0,0.7)',
        animation:      'slideUp 0.45s var(--ease-spring)',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{
            width:          56,
            height:         56,
            borderRadius:   16,
            background:    'var(--accent)',
            display:       'inline-flex',
            alignItems:    'center',
            justifyContent: 'center',
            marginBottom:   18,
            boxShadow:     '0 8px 32px rgba(10,132,255,0.4)',
          }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>
            </svg>
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.04em' }}>AuraSense</h1>
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 5, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            NVR Dashboard
          </p>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            style={inputStyle}
            onFocus={e => { e.target.style.borderColor = 'rgba(10,132,255,0.5)'; e.target.style.background = 'rgba(255,255,255,0.07)'; }}
            onBlur={e  => { e.target.style.borderColor = 'rgba(255,255,255,0.08)'; e.target.style.background = 'rgba(255,255,255,0.05)'; }}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
            style={inputStyle}
            onFocus={e => { e.target.style.borderColor = 'rgba(10,132,255,0.5)'; e.target.style.background = 'rgba(255,255,255,0.07)'; }}
            onBlur={e  => { e.target.style.borderColor = 'rgba(255,255,255,0.08)'; e.target.style.background = 'rgba(255,255,255,0.05)'; }}
          />

          {error && (
            <p style={{ fontSize: 12, color: '#ff6b6b', textAlign: 'center', margin: '0 0 2px' }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password}
            style={{
              marginTop:     6,
              padding:      '14px 0',
              borderRadius:  10,
              background:   'var(--accent)',
              color:        '#fff',
              fontWeight:    700,
              fontSize:      15,
              letterSpacing: '-0.01em',
              opacity:       loading || !username || !password ? 0.4 : 1,
              transition:   'opacity 0.15s, transform 0.1s',
              boxShadow:    '0 4px 24px rgba(10,132,255,0.35)',
            }}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

const inputStyle = {
  padding:      '13px 16px',
  borderRadius:  10,
  background:   'rgba(255,255,255,0.05)',
  border:       '1px solid rgba(255,255,255,0.08)',
  color:        '#fff',
  fontSize:      14,
  outline:      'none',
  transition:   'border-color 0.15s, background 0.15s',
  width:        '100%',
};
