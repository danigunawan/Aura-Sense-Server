import { useState } from 'react';
import FeaturedCamera from './FeaturedCamera.jsx';
import CameraCell from './CameraCell.jsx';

export default function CameraGrid({ cameras, onOpenCamera }) {
  const [featuredIndex, setFeaturedIndex] = useState(0);

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

  return (
    <div style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
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
              gap:           10,
              padding:      '0 44px',
              marginBottom:  16,
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
            </div>

            <div style={{
              display:             'grid',
              // auto-fill keeps tiles ~240px wide on the 1080p kiosk (≈ 6 cols)
              // so 16 cameras land in 3 rows; smaller screens reflow naturally.
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap:                  14,
              padding:             '6px 44px 32px',
            }}>
              {cameras.map(cam => (
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
