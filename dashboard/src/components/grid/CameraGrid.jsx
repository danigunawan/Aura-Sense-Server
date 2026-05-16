import { useEffect, useState } from 'react';
import FeaturedCamera from './FeaturedCamera.jsx';
import CameraCell from './CameraCell.jsx';

// Fixed layouts let the operator pick a tile size; "auto" keeps the previous
// auto-fill behavior (tiles ~240px wide, no pagination).
const GRID_LAYOUTS = [
  { id: 'auto', label: 'Auto', cols: null, rows: null },
  { id: '2x2',  label: '2 × 2', cols: 2, rows: 2 },
  { id: '3x2',  label: '3 × 2', cols: 3, rows: 2 },
  { id: '3x3',  label: '3 × 3', cols: 3, rows: 3 },
  { id: '4x3',  label: '4 × 3', cols: 4, rows: 3 },
  { id: '4x4',  label: '4 × 4', cols: 4, rows: 4 },
];

const LS_KEY = 'kiosk.gridLayout';

export default function CameraGrid({ cameras, onOpenCamera, scrollRef }) {
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const [layoutId, setLayoutId] = useState(() => {
    try { return localStorage.getItem(LS_KEY) || 'auto'; } catch { return 'auto'; }
  });
  const [page, setPage] = useState(0);

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, layoutId); } catch {}
  }, [layoutId]);

  const layout = GRID_LAYOUTS.find(l => l.id === layoutId) || GRID_LAYOUTS[0];
  const cellsPerPage = layout.cols ? layout.cols * layout.rows : cameras.length || 1;
  const totalPages   = Math.max(1, Math.ceil(cameras.length / cellsPerPage));

  // Clamp page when camera count or layout shrinks underneath us.
  useEffect(() => {
    if (page > totalPages - 1) setPage(Math.max(0, totalPages - 1));
  }, [page, totalPages]);

  const safePage = Math.min(page, totalPages - 1);
  const pageStart = safePage * cellsPerPage;
  const visibleCameras = layout.cols
    ? cameras.slice(pageStart, pageStart + cellsPerPage)
    : cameras;

  const safeIndex   = cameras.length ? featuredIndex % cameras.length : 0;
  const featuredCam = cameras[safeIndex] ?? null;

  function onFeature(cameraId) {
    const idx = cameras.findIndex(c => c.id === cameraId);
    if (idx >= 0) setFeaturedIndex(idx);
  }

  function goPrev() {
    if (cameras.length > 1) setFeaturedIndex(i => (i - 1 + cameras.length) % cameras.length);
  }
  function goNext() {
    if (cameras.length > 1) setFeaturedIndex(i => (i + 1) % cameras.length);
  }

  function pagePrev() { setPage(p => (p - 1 + totalPages) % totalPages); }
  function pageNext() { setPage(p => (p + 1) % totalPages); }

  return (
    <div ref={scrollRef} style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
      <FeaturedCamera
        camera={featuredCam}
        cameras={cameras}
        featuredIndex={safeIndex}
        onDotClick={i => setFeaturedIndex(i)}
        onPrev={goPrev}
        onNext={goNext}
        onOpen={onOpenCamera}
      />

      <div style={{ paddingTop: 32, paddingBottom: 48 }}>
        {cameras.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <div style={{
              display:      'flex',
              alignItems:   'center',
              gap:           12,
              padding:      '0 44px',
              marginBottom:  16,
              flexWrap:     'wrap',
            }}>
              <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.025em' }}>All Cameras</span>
              <span style={{
                fontSize:    11,
                fontWeight:  600,
                color:       'var(--text-tertiary)',
                padding:     '2px 8px',
                borderRadius: 20,
                background:  'var(--surface-mid)',
              }}>
                {cameras.length}
              </span>

              <div style={{ flex: 1 }} />

              <LayoutPicker
                value={layoutId}
                onChange={(id) => { setLayoutId(id); setPage(0); }}
              />

              {layout.cols && totalPages > 1 && (
                <Pager
                  page={safePage}
                  total={totalPages}
                  onPrev={pagePrev}
                  onNext={pageNext}
                />
              )}
            </div>

            <div style={{
              display:             'grid',
              gridTemplateColumns: layout.cols
                ? `repeat(${layout.cols}, 1fr)`
                : 'repeat(auto-fill, minmax(240px, 1fr))',
              gap:                  14,
              padding:             '6px 44px 32px',
            }}>
              {visibleCameras.map(cam => (
                <CameraCell
                  key={cam.id}
                  camera={cam}
                  onOpen={onOpenCamera}
                  onFeature={onFeature}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function LayoutPicker({ value, onChange }) {
  return (
    <div style={{
      display:      'flex',
      alignItems:   'center',
      gap:           2,
      padding:       2,
      borderRadius:  8,
      background:   'var(--surface-mid)',
      border:       '1px solid var(--border)',
    }}>
      {GRID_LAYOUTS.map(opt => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            title={opt.id === 'auto' ? 'Auto-fit tiles' : `${opt.cols} columns × ${opt.rows} rows`}
            style={{
              padding:     '6px 10px',
              fontSize:     11,
              fontWeight:   600,
              borderRadius: 6,
              background:   active ? 'var(--accent)' : 'transparent',
              color:        active ? '#fff' : 'var(--text-secondary)',
              transition:  'background 0.12s, color 0.12s',
              cursor:      'pointer',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function Pager({ page, total, onPrev, onNext }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: 2,
      borderRadius: 8,
      background: 'var(--surface-mid)',
      border: '1px solid var(--border)',
    }}>
      <PagerArrow onClick={onPrev} dir="left" />
      <span style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--text-secondary)',
        minWidth: 42,
        textAlign: 'center',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {page + 1} / {total}
      </span>
      <PagerArrow onClick={onNext} dir="right" />
    </div>
  );
}

function PagerArrow({ dir, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label={dir === 'left' ? 'Previous page' : 'Next page'}
      style={{
        width: 26, height: 26, borderRadius: 6,
        background: 'transparent',
        color: 'var(--text-secondary)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-high)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        {dir === 'left'
          ? <path d="M15 18l-6-6 6-6"/>
          : <path d="M9 18l6-6-6-6"/>}
      </svg>
    </button>
  );
}

function EmptyState() {
  return (
    <div style={{
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      justifyContent: 'center',
      gap:             10,
      padding:        '60px 0',
      color:          'var(--text-tertiary)',
    }}>
      <div style={{ fontSize: 12, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
        No cameras found
      </div>
      <div style={{ fontSize: 12, opacity: 0.5 }}>
        Go to Settings to scan your network
      </div>
    </div>
  );
}
