import { useState, useEffect, useRef } from 'react';
import FeaturedCamera from './FeaturedCamera.jsx';
import CameraRow from './CameraRow.jsx';

const BANNER_INTERVAL = 7000;

export default function CameraGrid({ cameras, onOpenCamera }) {
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const timerRef = useRef(null);

  function startTimer(len) {
    clearInterval(timerRef.current);
    if (len > 1) {
      timerRef.current = setInterval(
        () => setFeaturedIndex(i => (i + 1) % len),
        BANNER_INTERVAL,
      );
    }
  }

  useEffect(() => {
    startTimer(cameras.length);
    return () => clearInterval(timerRef.current);
  }, [cameras.length]); // eslint-disable-line

  const safeIndex  = cameras.length ? featuredIndex % cameras.length : 0;
  const featuredCam = cameras[safeIndex] ?? null;

  function onFeature(cameraId) {
    const idx = cameras.findIndex(c => c.id === cameraId);
    if (idx >= 0) { setFeaturedIndex(idx); startTimer(cameras.length); }
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
      <FeaturedCamera
        camera={featuredCam}
        cameras={cameras}
        featuredIndex={safeIndex}
        onDotClick={i => { setFeaturedIndex(i); startTimer(cameras.length); }}
        onOpen={onOpenCamera}
      />

      <div style={{ paddingTop: 32, paddingBottom: 48 }}>
        {cameras.length === 0 ? (
          <EmptyState />
        ) : (
          <CameraRow
            label="All Cameras"
            cameras={cameras}
            onOpenCamera={onOpenCamera}
            onFeature={onFeature}
          />
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
