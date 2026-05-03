import { useState } from 'react';
import FeaturedCamera from './FeaturedCamera.jsx';
import CameraRow from './CameraRow.jsx';

export default function CameraGrid({ cameras, onOpenCamera }) {
  const [featuredId, setFeaturedId] = useState(null);

  const onlineCameras  = cameras.filter(c => c.status === 'online');
  const offlineCameras = cameras.filter(c => c.status !== 'online');

  // Featured: user-pinned → first online → first camera overall
  const featuredCam = featuredId
    ? cameras.find(c => c.id === featuredId) ?? onlineCameras[0] ?? cameras[0]
    : onlineCameras[0] ?? cameras[0];

  const shelfCameras   = cameras.filter(c => c.id !== featuredCam?.id);
  const shelfOffline   = offlineCameras.filter(c => c.id !== featuredCam?.id);

  return (
    <div style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
      <FeaturedCamera
        camera={featuredCam ?? null}
        onOpen={onOpenCamera}
      />

      <div style={{ paddingTop: 32, paddingBottom: 48 }}>
        {cameras.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {shelfCameras.length > 0 && (
              <CameraRow
                label="All Cameras"
                cameras={shelfCameras}
                onOpenCamera={onOpenCamera}
                onFeature={setFeaturedId}
              />
            )}
            {shelfOffline.length > 0 && (
              <CameraRow
                label="Offline"
                cameras={shelfOffline}
                onOpenCamera={onOpenCamera}
                onFeature={setFeaturedId}
              />
            )}
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
