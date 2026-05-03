import { useRef, useState } from 'react';
import CameraCell from './CameraCell.jsx';

export default function CameraRow({ label, cameras, onOpenCamera, onFeature }) {
  const scrollRef = useRef(null);
  const [showLeft,  setShowLeft]  = useState(false);
  const [showRight, setShowRight] = useState(true);

  function updateArrows() {
    const el = scrollRef.current;
    if (!el) return;
    setShowLeft(el.scrollLeft > 20);
    setShowRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 20);
  }

  function scroll(dir) {
    scrollRef.current?.scrollBy({ left: dir * 500, behavior: 'smooth' });
  }

  if (!cameras.length) return null;

  return (
    <div style={{ marginBottom: 12, position: 'relative' }}>
      {/* Row header */}
      <div style={{
        display:      'flex',
        alignItems:   'center',
        gap:           10,
        padding:      '0 44px',
        marginBottom:  16,
      }}>
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.025em' }}>{label}</span>
        <span style={{
          fontSize:   11,
          fontWeight:  600,
          color:      'var(--text-tertiary)',
          padding:    '2px 8px',
          borderRadius: 20,
          background: 'var(--surface-mid)',
        }}>
          {cameras.length}
        </span>
      </div>

      {/* Prev arrow */}
      {showLeft && (
        <ArrowBtn side="left" onClick={() => scroll(-1)} />
      )}
      {/* Next arrow */}
      {showRight && cameras.length > 4 && (
        <ArrowBtn side="right" onClick={() => scroll(1)} />
      )}

      {/* Scroll shelf */}
      <div
        ref={scrollRef}
        onScroll={updateArrows}
        style={{
          display:         'flex',
          gap:              14,
          padding:         '6px 44px 32px',
          overflowX:       'auto',
          overflowY:       'visible',
          scrollbarWidth:  'none',
          msOverflowStyle: 'none',
          scrollSnapType:  'x mandatory',
        }}
      >
        {cameras.map(cam => (
          <div key={cam.id} style={{ scrollSnapAlign: 'start', flexShrink: 0, width: 264 }}>
            <CameraCell
              camera={cam}
              onOpen={onOpenCamera}
              onFeature={onFeature}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ArrowBtn({ side, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position:       'absolute',
        top:            '50%',
        [side]:          6,
        transform:      'translateY(-30%)',
        zIndex:          20,
        width:           34,
        height:          76,
        borderRadius:    6,
        background:      hovered ? 'rgba(30,30,30,0.98)' : 'rgba(20,20,20,0.88)',
        backdropFilter: 'blur(12px)',
        border:         '1px solid rgba(255,255,255,0.07)',
        color:           hovered ? '#fff' : 'rgba(255,255,255,0.6)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        cursor:         'pointer',
        transition:     'background 0.15s, color 0.15s',
      }}
    >
      {side === 'left'
        ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
        : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M9 18l6-6-6-6"/></svg>
      }
    </button>
  );
}
