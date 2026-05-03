import { useEffect, useRef, useState } from 'react';

/**
 * Connects to mediamtx via WHEP (WebRTC-HTTP Egress Protocol).
 * whepUrl: e.g. http://localhost:8889/entrance/whep
 */
export default function LivePlayer({ whepUrl, objectFit = 'contain' }) {
  const videoRef = useRef(null);
  const pcRef    = useRef(null);
  const [state,    setState]    = useState('connecting');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!whepUrl) return;
    let cancelled = false;

    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.ontrack = (e) => {
      if (cancelled || !videoRef.current || !e.streams[0]) return;
      videoRef.current.srcObject = e.streams[0];
      videoRef.current.play().catch(() => {});
      setState('playing');
    };

    async function connect() {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Wait for host ICE candidates — fast on LAN (<100 ms)
        await new Promise(resolve => {
          if (pc.iceGatheringState === 'complete') { resolve(); return; }
          pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === 'complete') resolve();
          };
          setTimeout(resolve, 1000);
        });

        if (cancelled) return;

        const res = await fetch(whepUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body:    pc.localDescription.sdp,
        });

        if (!res.ok) throw new Error(`mediamtx ${res.status}: ${res.statusText}`);

        const sdp = await res.text();
        if (cancelled) return;
        await pc.setRemoteDescription({ type: 'answer', sdp });
      } catch (err) {
        if (!cancelled) { setState('error'); setErrorMsg(err.message); }
      }
    }

    connect();

    return () => {
      cancelled = true;
      pc.close();
      pcRef.current = null;
    };
  }, [whepUrl]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', background: '#000',
                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{
          width:      '100%',
          height:     '100%',
          objectFit,
          display:    state === 'playing' ? 'block' : 'none',
        }}
      />
      {state === 'connecting' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
                      color: 'var(--text-secondary)', position: 'absolute' }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            border: '2px solid var(--surface-mid)', borderTopColor: 'var(--accent)',
            animation: 'spin 0.7s linear infinite',
          }} />
          <span style={{ fontSize: 12 }}>Connecting…</span>
          <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
        </div>
      )}
      {state === 'error' && (
        <div style={{ textAlign: 'center', color: 'var(--orange)', position: 'absolute' }}>
          <div style={{ fontSize: 28 }}>⚠</div>
          <div style={{ fontSize: 12, marginTop: 8, color: 'var(--text-secondary)', maxWidth: 260 }}>
            {errorMsg}
          </div>
        </div>
      )}
    </div>
  );
}
