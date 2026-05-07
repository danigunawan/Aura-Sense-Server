import { useEffect, useRef, useState } from 'react';

function detectVideoCodec(sdp) {
  // Returns 'H265' | 'H264' | 'unknown' by inspecting the SDP answer.
  const lines = sdp.split(/\r?\n/);
  // Collect payload types from the video m= section only.
  let inVideo = false;
  const videoPayloads = new Set();
  for (const line of lines) {
    if (line.startsWith('m=video'))  { inVideo = true;  continue; }
    if (line.startsWith('m='))       { inVideo = false; continue; }
    if (!inVideo) continue;
    if (line.startsWith('m=video')) continue;
    const mMatch = line.match(/^m=video \d+ \S+ (.+)/);
    if (mMatch) { mMatch[1].split(' ').forEach(pt => videoPayloads.add(pt)); continue; }
    const fmtpLine = line.match(/^a=rtpmap:(\d+) (H265|H264|hevc|avc)/i);
    if (fmtpLine && videoPayloads.has(fmtpLine[1])) {
      return /H265|hevc/i.test(fmtpLine[2]) ? 'H265' : 'H264';
    }
  }
  return 'unknown';
}

/**
 * Connects to mediamtx via WHEP (WebRTC-HTTP Egress Protocol).
 * whepUrl: e.g. http://localhost:8889/entrance/whep
 */
export default function LivePlayer({ whepUrl, objectFit = 'contain', background = '#000' }) {
  const videoRef = useRef(null);
  const pcRef    = useRef(null);
  const [state,    setState]    = useState('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [codec,    setCodec]    = useState(null);   // 'H264' | 'H265' | 'unknown'

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

        setCodec(detectVideoCodec(sdp));
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
    <div style={{ width: '100%', height: '100%', position: 'relative', background,
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
          opacity:    state === 'playing' ? 1 : 0,
          transition: 'opacity 0.35s ease-out',
        }}
      />

      {/* H.265 on main stream — camera misconfigured */}
      {state === 'playing' && codec === 'H265' && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          background: 'rgba(220, 80, 0, 0.92)',
          color: '#fff', fontSize: 11, fontWeight: 600,
          padding: '5px 10px',
          display: 'flex', alignItems: 'center', gap: 6,
          letterSpacing: '0.02em',
        }}>
          <span style={{ fontSize: 14 }}>⚠</span>
          Main stream is H.265 — set camera video encoding to H.264
        </div>
      )}

      {state === 'connecting' && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background:
            'radial-gradient(ellipse at 50% 45%, rgba(10,132,255,0.12) 0%, transparent 55%),' +
            'linear-gradient(180deg, rgba(7,8,9,0.55) 0%, rgba(7,8,9,0.85) 100%)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          transition: 'opacity 0.35s ease-out',
        }}>
          <div style={{ position: 'relative', width: 44, height: 44,
                        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(10,132,255,0.30) 0%, transparent 70%)',
              animation: 'lpAura 1.8s ease-in-out infinite',
            }} />
            <div style={{
              width: 24, height: 24, borderRadius: '50%',
              border: '1.5px solid rgba(255,255,255,0.06)',
              borderTopColor: '#0A84FF',
              borderRightColor: 'rgba(10,132,255,0.55)',
              boxShadow: '0 0 14px rgba(10,132,255,0.45)',
              animation: 'lpSpin 1.1s cubic-bezier(.55,.15,.45,.85) infinite',
            }} />
          </div>
          <style>{`
            @keyframes lpSpin { to { transform: rotate(360deg) } }
            @keyframes lpAura {
              0%, 100% { transform: scale(0.85); opacity: 0.55 }
              50%      { transform: scale(1.45); opacity: 0 }
            }
          `}</style>
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
