const BASE = '';

let _onUnauth = () => {};
export function setUnauthHandler(fn) { _onUnauth = fn; }

function getToken() {
  return localStorage.getItem('nvr_token');
}

export function setToken(token) {
  localStorage.setItem('nvr_token', token);
}

export function clearToken() {
  localStorage.removeItem('nvr_token');
}

async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  });

  if (res.status === 401) {
    clearToken();
    _onUnauth();
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Request failed');
  }

  return res.json();
}

export function decodeTokenRole(token) {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64)).role || null;
  } catch {
    return null;
  }
}

export const api = {
  login:         (username, password) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),

  kioskToken:    () => request('/auth/kiosk-token', { method: 'POST' }),

  cameras:       (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/cameras${q ? `?${q}` : ''}`);
  },

  cameraStatus:  (id)           => request(`/cameras/${id}/status`),
  systemStatus:  ()             => request('/status'),

  streamUrls:    (id)           => request(`/cameras/${id}/stream-urls`),
  requestStream: (id)           => request(`/cameras/${id}/stream`, { method: 'POST' }),
  endStream:     (id, sid)      => request(`/cameras/${id}/stream/${sid}`, { method: 'DELETE' }),

  renameCamera:  (id, name)     => request(`/cameras/${id}`, {
    method: 'PATCH', body: JSON.stringify({ name }),
  }),
  deleteCamera:  (id)           => request(`/cameras/${id}`, { method: 'DELETE' }),
  syncCameraTime:(id)           => request(`/cameras/${id}/sync-time`, { method: 'POST' }),
  pushAddressing:(id)           => request(`/cameras/${id}/push-addressing`, { method: 'POST' }),

  scanStatus:    ()             => request('/discovery/status'),
  triggerScan:   ()             => request('/discovery/scan', { method: 'POST' }),

  listUsers:     ()             => request('/auth/users'),
  createUser:    (body)         => request('/auth/users', {
    method: 'POST', body: JSON.stringify(body),
  }),
  deleteUser:    (username)     => request(`/auth/users/${username}`, { method: 'DELETE' }),

  shutdown:      ()             => request('/system/shutdown', { method: 'POST' }),

  clips:         (id, params)   => {
    const q = new URLSearchParams(params).toString();
    return request(`/cameras/${id}/clips?${q}`);
  },

  hddStatus:         ()         => request('/storage/hdd'),
  listStorageDevices:()         => request('/storage/devices'),
  recordingStatus:   ()         => request('/storage/recording-status'),
  formatHdd:         (device)   => request('/storage/format', {
    method: 'POST', body: JSON.stringify({ device }),
  }),
};

export function snapshotUrl(cameraId) {
  return `/thumbs/cam-${cameraId}-latest.jpg`;
}
