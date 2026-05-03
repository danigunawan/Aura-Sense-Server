import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client.js';

export function useCameras() {
  const [cameras,   setCameras]   = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState(null);

  const fetch = useCallback(async () => {
    try {
      const data = await api.cameras({ limit: 16 });
      setCameras(data.items);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    // Re-poll status every 30 s
    const id = setInterval(fetch, 30_000);
    return () => clearInterval(id);
  }, [fetch]);

  return { cameras, loading, error, refresh: fetch };
}

export function useSystemStatus() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    const load = () => api.systemStatus().then(setStatus).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  return status;
}
