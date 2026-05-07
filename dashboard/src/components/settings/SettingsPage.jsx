import { useState, useEffect, useCallback, useRef } from 'react';
import { api, clearToken } from '../../api/client.js';
import StatusDot from '../ui/StatusDot.jsx';

// ── Top-level page ────────────────────────────────────────────────────────────

export default function SettingsPage() {
  return (
    <div style={{ padding: '28px 32px', maxWidth: 860, margin: '0 auto' }}>
      <DiscoverySection />
      <Divider />
      <CamerasSection />
      <Divider />
      <UsersSection />
      <Divider />
      <StorageSection />
      <Divider />
      <SystemSection />
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '32px 0' }} />;
}

function SectionHeader({ title, subtitle }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em' }}>{title}</h2>
      {subtitle && (
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>{subtitle}</p>
      )}
    </div>
  );
}

// ── Camera Discovery ──────────────────────────────────────────────────────────

function DiscoverySection() {
  const [status,   setStatus]   = useState(null);
  const [scanning, setScanning] = useState(false);
  const [error,    setError]    = useState('');

  const fetchStatus = useCallback(() => {
    api.scanStatus()
      .then(s => { setStatus(s); setScanning(s.state === 'running'); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll while scan is running
  useEffect(() => {
    if (!scanning) return;
    const id = setInterval(fetchStatus, 3000);
    return () => clearInterval(id);
  }, [scanning, fetchStatus]);

  async function handleScan() {
    setError('');
    setScanning(true);
    try {
      await api.triggerScan();
      fetchStatus();
    } catch (e) {
      setError(e.message);
      setScanning(false);
    }
  }

  const stateColor = {
    idle:    'var(--text-tertiary)',
    running: 'var(--accent)',
    done:    'var(--green)',
    error:   'var(--red)',
  };

  const stateLabel = {
    idle:    'Not scanned yet',
    running: 'Scanning network…',
    done:    `Last scan found ${status?.last_found ?? 0} new camera(s)`,
    error:   'Scan failed',
  };

  return (
    <div>
      <SectionHeader title="Camera Discovery" />

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <Button
          onClick={handleScan}
          disabled={scanning}
          primary
        >
          {scanning ? 'Scanning…' : 'Scan Network'}
        </Button>

        {status && (
          <div style={{ fontSize: 12 }}>
            <span style={{ color: stateColor[status.state] || 'var(--text-tertiary)' }}>
              {stateLabel[status.state] || status.state}
            </span>
            {status.last_scan && status.state !== 'running' && (
              <span style={{ color: 'var(--text-tertiary)', marginLeft: 8 }}>
                · {formatRelative(status.last_scan)}
              </span>
            )}
          </div>
        )}
      </div>

      {scanning && (
        <div style={{
          marginTop: 14,
          padding: '12px 16px',
          borderRadius: 8,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          fontSize: 12,
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <Spinner size={14} />
          Sending WS-Discovery probes across all network interfaces… This takes ~30 seconds.
        </div>
      )}

      {error && (
        <p style={{ marginTop: 10, fontSize: 12, color: 'var(--red)' }}>{error}</p>
      )}
    </div>
  );
}

// ── Camera Management ─────────────────────────────────────────────────────────

function CamerasSection() {
  const [cameras,   setCameras]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [editing,   setEditing]   = useState(null);   // camera id being renamed
  const [editName,  setEditName]  = useState('');
  const [deleting,  setDeleting]  = useState(null);   // camera to confirm-delete
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');

  const load = useCallback(() => {
    api.cameras({ limit: 100 })
      .then(d => { setCameras(d.items); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  function startEdit(cam) {
    setEditing(cam.id);
    setEditName(cam.name);
    setError('');
  }

  async function saveEdit() {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      await api.renameCamera(editing, editName.trim());
      setEditing(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    setSaving(true);
    try {
      await api.deleteCamera(deleting.id);
      setDeleting(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeader
        title="Cameras"
        subtitle="Manage discovered cameras. Deletion removes from database only — the physical camera is unaffected."
      />

      {error && (
        <p style={{ fontSize: 12, color: 'var(--red)', marginBottom: 12 }}>{error}</p>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Loading…</div>
      ) : cameras.length === 0 ? (
        <EmptyState text="No cameras found. Run a network scan to discover cameras." />
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Name', 'Model', 'Status', 'Last Seen', ''].map(h => (
                <th key={h} style={{
                  textAlign: 'left', padding: '8px 12px 10px',
                  fontSize: 11, fontWeight: 600,
                  color: 'var(--text-tertiary)', letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cameras.map(cam => (
              <tr
                key={cam.id}
                style={{ borderBottom: '1px solid var(--border)' }}
              >
                <td style={{ padding: '10px 12px' }}>
                  {editing === cam.id ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        autoFocus
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(null); }}
                        style={{
                          ...inlineInputStyle,
                          width: 130,
                        }}
                      />
                      <IconButton onClick={saveEdit} disabled={saving} title="Save">✓</IconButton>
                      <IconButton onClick={() => setEditing(null)} title="Cancel">✕</IconButton>
                    </div>
                  ) : (
                    <span style={{ fontWeight: 500 }}>{cam.name}</span>
                  )}
                </td>
                <td style={{ padding: '10px 12px', color: 'var(--text-secondary)' }}>
                  {[cam.manufacturer, cam.model].filter(Boolean).join(' ') || '—'}
                </td>
                <td style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <StatusDot status={cam.status} size={6} />
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'capitalize' }}>
                      {cam.status}
                    </span>
                  </div>
                </td>
                <td style={{ padding: '10px 12px', color: 'var(--text-tertiary)', fontSize: 11 }}>
                  {formatRelative(cam.last_seen)}
                </td>
                <td style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <IconButton onClick={() => startEdit(cam)} title="Rename">✏</IconButton>
                    <IconButton
                      onClick={() => { setDeleting(cam); setError(''); }}
                      title="Delete"
                      danger
                    >
                      🗑
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Delete confirmation */}
      {deleting && (
        <Modal onClose={() => setDeleting(null)}>
          <div style={{ padding: '28px 28px 24px', width: 360 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Delete Camera</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
              Remove <strong>{deleting.name}</strong> from the database?
              This won't affect the physical camera or its streams.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <Button onClick={() => setDeleting(null)}>Cancel</Button>
              <Button onClick={confirmDelete} disabled={saving} danger>
                {saving ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── User Management ───────────────────────────────────────────────────────────

function UsersSection() {
  const [users,    setUsers]    = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showAdd,  setShowAdd]  = useState(false);
  const [form,     setForm]     = useState({ username: '', password: '', role: 'viewer' });
  const [deleting, setDeleting] = useState(null);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');

  const load = useCallback(() => {
    api.listUsers()
      .then(u => { setUsers(u); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.username || !form.password) return;
    setSaving(true);
    setError('');
    try {
      await api.createUser(form);
      setForm({ username: '', password: '', role: 'viewer' });
      setShowAdd(false);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setSaving(true);
    try {
      await api.deleteUser(deleting.username);
      setDeleting(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeader
        title="Users"
        subtitle="Manage dashboard access. Admin role can modify settings; viewer role is read-only."
      />

      {error && (
        <p style={{ fontSize: 12, color: 'var(--red)', marginBottom: 12 }}>{error}</p>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Loading…</div>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Username', 'Role', 'Created', ''].map(h => (
                  <th key={h} style={{
                    textAlign: 'left', padding: '8px 12px 10px',
                    fontSize: 11, fontWeight: 600,
                    color: 'var(--text-tertiary)', letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 500 }}>{u.username}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <RoleBadge role={u.role} />
                  </td>
                  <td style={{ padding: '10px 12px', color: 'var(--text-tertiary)', fontSize: 11 }}>
                    {formatRelative(u.created_at)}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <IconButton
                        onClick={() => { setDeleting(u); setError(''); }}
                        title="Delete user"
                        danger
                      >
                        🗑
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {showAdd ? (
            <form onSubmit={handleCreate} style={{
              padding: '16px 18px',
              borderRadius: 10,
              background: 'var(--surface)',
              border: '1px solid var(--border-mid)',
              display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap',
            }}>
              <Field label="Username">
                <input
                  autoFocus
                  value={form.username}
                  onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                  style={inlineInputStyle}
                  placeholder="username"
                />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  style={inlineInputStyle}
                  placeholder="min 8 chars"
                />
              </Field>
              <Field label="Role">
                <select
                  value={form.role}
                  onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                  style={{ ...inlineInputStyle, paddingRight: 8 }}
                >
                  <option value="viewer">Viewer</option>
                  <option value="admin">Admin</option>
                </select>
              </Field>
              <div style={{ display: 'flex', gap: 8, paddingBottom: 1 }}>
                <Button type="submit" disabled={saving} primary>
                  {saving ? 'Creating…' : 'Create'}
                </Button>
                <Button onClick={() => setShowAdd(false)}>Cancel</Button>
              </div>
            </form>
          ) : (
            <Button onClick={() => { setShowAdd(true); setError(''); }}>
              + Add User
            </Button>
          )}
        </>
      )}

      {/* Delete confirmation */}
      {deleting && (
        <Modal onClose={() => setDeleting(null)}>
          <div style={{ padding: '28px 28px 24px', width: 340 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Delete User</h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
              Remove <strong>{deleting.username}</strong> ({deleting.role})?
              They will be immediately signed out.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <Button onClick={() => setDeleting(null)}>Cancel</Button>
              <Button onClick={handleDelete} disabled={saving} danger>
                {saving ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Storage / HDD ─────────────────────────────────────────────────────────────

function StorageSection() {
  const [info,        setInfo]        = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);

  // Format confirm flow
  const [confirmStep,  setConfirmStep]  = useState(0);    // 0=idle 1=modal 2=typing 3=running
  const [confirmInput, setConfirmInput] = useState('');
  const [formatError,  setFormatError]  = useState('');
  const confirmRef = useRef(null);

  const load = useCallback(() => {
    api.hddStatus()
      .then(d => { setInfo(d); setLoading(false); setLastUpdated(new Date()); setError(''); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refresh every 30 s while the tab is open
  useEffect(() => {
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (confirmStep === 1) {
      setConfirmInput('');
      setFormatError('');
      setTimeout(() => confirmRef.current?.focus(), 80);
    }
  }, [confirmStep]);

  async function handleFormat() {
    if (confirmInput !== 'FORMAT') {
      setFormatError('Type FORMAT (all caps) to confirm');
      return;
    }
    setConfirmStep(3);
    setFormatError('');
    try {
      await api.formatHdd();
      setConfirmStep(0);
      setLoading(true);
      setTimeout(load, 3000);   // give recording service time to restart
    } catch (e) {
      setFormatError(e.message);
      setConfirmStep(1);
    }
  }

  const usePct    = info?.use_percent ?? 0;
  const recGB     = _gb(info?.recordings_bytes ?? 0);
  const usedGB    = _gb(info?.used_bytes ?? 0);
  const freeGB    = _gb(info?.free_bytes ?? 0);
  const totalGB   = _gb(info?.total_bytes ?? 0);
  const capGB     = _gb(info?.disk_cap_bytes ?? 0);
  const estDays   = info?.estimated_days;

  // Bar colour: green → amber → red as usage rises
  const barColor = usePct > 90 ? 'var(--red)'
                 : usePct > 75 ? 'var(--orange)'
                 : 'var(--accent)';

  return (
    <div>
      <SectionHeader
        title="Recording Drive"
        subtitle="External HDD status and storage management for recorded footage"
      />

      {error && !info && (
        <div style={{
          padding: '14px 16px', borderRadius: 8,
          background: 'rgba(255,69,58,0.08)', border: '1px solid rgba(255,69,58,0.25)',
          fontSize: 13, color: 'var(--red)',
        }}>
          {error === 'Recording disk not mounted at /media/aura/recordaura'
            ? 'Recording drive not connected. Attach the USB/SATA drive and refresh.'
            : error}
        </div>
      )}

      {loading && !info && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-tertiary)', fontSize: 13 }}>
          <Spinner size={14} /> Reading drive status…
        </div>
      )}

      {info && (
        <div style={{
          padding: '20px 20px 16px',
          borderRadius: 12,
          background: 'var(--surface)',
          border: '1px solid var(--border-mid)',
        }}>
          {/* Drive header row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 38, height: 38, borderRadius: 8,
                background: 'var(--surface-mid)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 20,
              }}>
                💾
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Recording Drive</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1, fontFamily: 'monospace' }}>
                  {info.mount_point}
                </div>
              </div>
            </div>

            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.03em' }}>
                {usedGB} <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-secondary)' }}>/ {totalGB} GB</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                {freeGB} GB free
              </div>
            </div>
          </div>

          {/* Usage bar */}
          <div style={{
            height: 8, borderRadius: 4,
            background: 'var(--surface-mid)',
            overflow: 'hidden',
            marginBottom: 16,
          }}>
            <div style={{
              height: '100%',
              width: `${Math.min(usePct, 100)}%`,
              borderRadius: 4,
              background: barColor,
              transition: 'width 0.6s var(--ease)',
            }} />
          </div>

          {/* Stats row */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12,
            marginBottom: 18,
          }}>
            <StatCard label="Recordings" value={`${recGB} GB`} />
            <StatCard label="NVR Cap" value={`${capGB} GB`} />
            <StatCard
              label="Est. Retention"
              value={estDays != null ? `~${estDays} days` : 'calculating…'}
              highlight={estDays != null && estDays < 2}
            />
          </div>

          {/* Clip count + last updated */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            fontSize: 11, color: 'var(--text-tertiary)',
          }}>
            <span>{(info.clip_count ?? 0).toLocaleString()} segments indexed</span>
            {lastUpdated && (
              <button
                onClick={load}
                style={{ color: 'var(--accent)', fontSize: 11, padding: '2px 0' }}
              >
                Updated {_relTime(lastUpdated)} · Refresh
              </button>
            )}
          </div>
        </div>
      )}

      {/* Format button */}
      {info && (
        <div style={{ marginTop: 16 }}>
          <Button danger onClick={() => setConfirmStep(1)}>
            Format HDD…
          </Button>
          <p style={{
            marginTop: 8, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.6,
          }}>
            Erases all recordings and reinitialises the filesystem. This cannot be undone.
          </p>
        </div>
      )}

      {/* Format confirmation modal */}
      {confirmStep >= 1 && (
        <Modal onClose={() => { if (confirmStep !== 3) setConfirmStep(0); }}>
          <div style={{ padding: '28px 28px 24px', width: 420 }}>
            <div style={{ fontSize: 36, marginBottom: 14 }}>⚠</div>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Format Recording Drive?</h3>
            <p style={{
              fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.65, marginBottom: 20,
            }}>
              This will permanently erase <strong>all {(info.clip_count ?? 0).toLocaleString()} recordings</strong> ({recGB} GB) and
              reformat the drive. The recording service will restart automatically.<br /><br />
              <strong>This cannot be undone.</strong>
            </p>

            {confirmStep === 3 ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
                <Spinner size={16} />
                Formatting drive… do not disconnect the drive.
              </div>
            ) : (
              <>
                <label style={{
                  display: 'block', fontSize: 11, fontWeight: 600,
                  color: 'var(--text-tertiary)', letterSpacing: '0.06em',
                  textTransform: 'uppercase', marginBottom: 6,
                }}>
                  Type FORMAT to confirm
                </label>
                <input
                  ref={confirmRef}
                  value={confirmInput}
                  onChange={e => { setConfirmInput(e.target.value); setFormatError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleFormat(); }}
                  placeholder="FORMAT"
                  style={{
                    ...inlineInputStyle,
                    width: '100%',
                    boxSizing: 'border-box',
                    marginBottom: 6,
                    borderColor: formatError ? 'var(--red)' : undefined,
                  }}
                />
                {formatError && (
                  <p style={{ fontSize: 11, color: 'var(--red)', marginBottom: 12 }}>{formatError}</p>
                )}
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
                  <Button onClick={() => setConfirmStep(0)}>Cancel</Button>
                  <Button danger onClick={handleFormat} disabled={confirmInput !== 'FORMAT'}>
                    Erase and Format
                  </Button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function StatCard({ label, value, highlight }) {
  return (
    <div style={{
      padding: '10px 12px',
      borderRadius: 8,
      background: 'var(--surface-mid)',
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
        textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: 4,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 15, fontWeight: 700,
        color: highlight ? 'var(--orange)' : 'var(--text-primary)',
      }}>
        {value}
      </div>
    </div>
  );
}

function _gb(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

function _relTime(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 5)  return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

// ── System ────────────────────────────────────────────────────────────────────

function SystemSection() {
  const [confirm,   setConfirm]   = useState(false);
  const [shutting,  setShutting]  = useState(false);
  const [error,     setError]     = useState('');

  async function handleShutdown() {
    setShutting(true);
    setError('');
    try {
      await api.shutdown();
      clearToken();
      // Show a "shutting down" screen — services will stop within ~2 s
      setConfirm(false);
    } catch (e) {
      // Network error is expected once the process exits
      if (e.message !== 'Session expired') {
        setShutting(false);
        setError(e.message);
      }
    }
  }

  if (shutting) {
    return (
      <div>
        <SectionHeader title="System" />
        <div style={{
          display:        'flex',
          alignItems:     'center',
          gap:             12,
          padding:        '20px 0',
          color:          'var(--text-secondary)',
          fontSize:        14,
        }}>
          <Spinner size={18} />
          Shutting down AuraSense…
        </div>
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        title="System"
        subtitle="Stop all AuraSense services. You will need to restart them manually or via systemd."
      />

      {error && (
        <p style={{ fontSize: 12, color: 'var(--red)', marginBottom: 12 }}>{error}</p>
      )}

      <Button danger onClick={() => { setConfirm(true); setError(''); }}>
        Exit Application
      </Button>

      {confirm && (
        <Modal onClose={() => setConfirm(false)}>
          <div style={{ padding: '28px 28px 24px', width: 380 }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⏻</div>
            <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>
              Shut Down AuraSense?
            </h3>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
              This will stop all services — live streams, recording, and the API.
              The dashboard will become unavailable until the system is restarted.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
              <Button danger onClick={handleShutdown}>
                Shut Down
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Shared UI primitives ──────────────────────────────────────────────────────

function Button({ children, onClick, disabled, primary, danger, type = 'button' }) {
  const bg = primary ? 'var(--accent)'
           : danger  ? 'rgba(255,69,58,0.15)'
           : 'var(--surface-mid)';
  const color = primary ? '#fff'
              : danger  ? 'var(--red)'
              : 'var(--text-secondary)';

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '8px 16px',
        borderRadius: 8,
        background: bg,
        color,
        fontSize: 13,
        fontWeight: 500,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'opacity 0.15s',
        border: danger ? '1px solid rgba(255,69,58,0.3)' : '1px solid transparent',
      }}
    >
      {children}
    </button>
  );
}

function IconButton({ children, onClick, disabled, title, danger }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: 28, height: 28,
        borderRadius: 6,
        background: 'var(--surface-mid)',
        color: danger ? 'var(--red)' : 'var(--text-secondary)',
        fontSize: 13,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.12s',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'var(--surface-high)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface-mid)'; }}
    >
      {children}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function RoleBadge({ role }) {
  const isAdmin = role === 'admin';
  return (
    <span style={{
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 600,
      background: isAdmin ? 'rgba(10,132,255,0.15)' : 'var(--surface-mid)',
      color: isAdmin ? 'var(--accent)' : 'var(--text-secondary)',
    }}>
      {role}
    </span>
  );
}

function Modal({ children, onClose }) {
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)',
      }}
    >
      <div style={{
        background: 'var(--surface)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border-mid)',
        boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
      }}>
        {children}
      </div>
    </div>
  );
}

function Spinner({ size = 20 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      border: `2px solid var(--surface-high)`,
      borderTopColor: 'var(--accent)',
      animation: 'spin 0.7s linear infinite',
      flexShrink: 0,
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

function EmptyState({ text }) {
  return (
    <div style={{
      padding: '32px 0',
      textAlign: 'center',
      color: 'var(--text-tertiary)',
      fontSize: 13,
    }}>
      {text}
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const inlineInputStyle = {
  padding: '7px 10px',
  borderRadius: 7,
  background: 'var(--surface-mid)',
  border: '1px solid var(--border)',
  color: 'var(--text-primary)',
  fontSize: 13,
  outline: 'none',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelative(iso) {
  if (!iso) return '—';
  const diff = (Date.now() - new Date(iso)) / 1000;
  if (diff < 60)   return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
