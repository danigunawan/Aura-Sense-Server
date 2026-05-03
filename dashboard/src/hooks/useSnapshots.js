import { useState, useEffect, useRef } from 'react';
import { snapshotUrl } from '../api/client.js';

/**
 * Refreshes a camera snapshot every `interval` ms by appending a cache-bust
 * query param. Uses a natural image load to avoid showing broken frames.
 */
export function useSnapshot(cameraId, interval = 30_000) {
  const [src,    setSrc]    = useState(null);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!cameraId) return;

    function refresh() {
      const url = `${snapshotUrl(cameraId)}?t=${Date.now()}`;
      const img = new Image();
      img.onload  = () => { setSrc(url); setLoaded(true); };
      img.onerror = () => {};   // keep previous frame on error
      img.src = url;
    }

    refresh();
    timer.current = setInterval(refresh, interval);
    return () => clearInterval(timer.current);
  }, [cameraId, interval]);

  return { src, loaded };
}
