import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../../api/client.js';

const HOUR_MS = 3_600_000;
const DAY_MS  = 86_400_000;

export default function Timeline({ cameraId, onSeek }) {
  const [clips,     setClips]     = useState([]);
  const [hovering,  setHovering]  = useState(false);
  const [hoverX,    setHoverX]    = useState(0);
  const [hoverTime, setHoverTime] = useState('');
  const [playhead,  setPlayhead]  = useState(null);   // 0..1 position
  const [dragging,  setDragging]  = useState(false);
  const [dayOffset, setDayOffset] = useState(0);      // 0 = today, -1 = yesterday…

  const railRef = useRef(null);

  // Date range for the displayed day
  const dayStart = useCallback(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    return d;
  }, [dayOffset]);

  const dayEnd = useCallback(() => {
    const d = dayStart();
    d.setDate(d.getDate() + 1);
    return d;
  }, [dayStart]);

  // Fetch clips for this day
  useEffect(() => {
    if (!cameraId) return;
    api.clips(cameraId, {
      from:  dayStart().toISOString(),
      to:    dayEnd().toISOString(),
      limit: 288,   // up to 288 × 5-min segments per day
    })
      .then(r => setClips(r.items))
      .catch(() => setClips([]));
  }, [cameraId, dayStart, dayEnd]);

  // Convert clip time range to 0..1 rail position
  function toFraction(isoStr) {
    const ts    = new Date(isoStr).getTime();
    const start = dayStart().getTime();
    return Math.max(0, Math.min(1, (ts - start) / DAY_MS));
  }

  // Mouse → position utilities
  function railFraction(clientX) {
    const rect = railRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function fractionToTime(frac) {
    const ts = dayStart().getTime() + frac * DAY_MS;
    return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function fractionToDate(frac) {
    return new Date(dayStart().getTime() + frac * DAY_MS);
  }

  // Mouse events
  function onMouseMove(e) {
    const frac = railFraction(e.clientX);
    setHoverX(frac * 100);
    setHoverTime(fractionToTime(frac));
    if (dragging) setPlayhead(frac);
  }

  function onMouseDown(e) {
    e.preventDefault();
    const frac = railFraction(e.clientX);
    setDragging(true);
    setPlayhead(frac);
  }

  function onMouseUp(e) {
    if (!dragging) return;
    const frac = railFraction(e.clientX);
    setPlayhead(frac);
    setDragging(false);
    const date = fractionToDate(frac);
    const clip = _clipAt(clips, date);
    onSeek?.({ date, clip });
  }

  // Hour tick labels
  const ticks = [0, 4, 8, 12, 16, 20, 24];

  return (
    <div style={{ padding: '0 20px 20px', userSelect: 'none' }}>

      {/* Day navigation */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <button
          onClick={() => setDayOffset(d => d - 1)}
          style={{ color: 'var(--accent)', fontSize: 13, padding: '2px 0' }}
        >
          ← Previous day
        </button>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
          {dayStart().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
        </span>
        <button
          onClick={() => setDayOffset(d => Math.min(0, d + 1))}
          style={{
            color:     dayOffset === 0 ? 'var(--text-tertiary)' : 'var(--accent)',
            fontSize:   13,
            padding:   '2px 0',
            cursor:     dayOffset === 0 ? 'not-allowed' : 'pointer',
          }}
          disabled={dayOffset === 0}
        >
          Next day →
        </button>
      </div>

      {/* Rail */}
      <div
        ref={railRef}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => { setHovering(false); if (dragging) { setDragging(false); } }}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        style={{
          position:     'relative',
          height:        36,
          borderRadius:  8,
          background:   'var(--surface-mid)',
          cursor:        'pointer',
          overflow:      'visible',
        }}
      >
        {/* Recorded segments */}
        {clips.map((clip) => {
          const left  = toFraction(clip.start_time) * 100;
          const right = toFraction(clip.end_time)   * 100;
          const width = right - left;
          if (width < 0.1) return null;
          return (
            <div
              key={clip.id}
              title={`${_fmtTime(clip.start_time)} – ${_fmtTime(clip.end_time)}`}
              onClick={(e) => {
                e.stopPropagation();
                const date = new Date(clip.start_time);
                setPlayhead(toFraction(clip.start_time));
                onSeek?.({ date, clip });
              }}
              style={{
                position:     'absolute',
                top:           4,
                bottom:        4,
                left:         `${left}%`,
                width:        `${width}%`,
                borderRadius:  4,
                background:   'var(--accent)',
                opacity:       0.7,
                cursor:        'pointer',
                transition:   'opacity 0.1s',
              }}
              onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = '0.7'; }}
            />
          );
        })}

        {/* Hover ghost line */}
        {hovering && !dragging && (
          <div style={{
            position:     'absolute',
            top:          -4,
            bottom:       -4,
            left:         `${hoverX}%`,
            width:         1,
            background:   'rgba(255,255,255,0.4)',
            pointerEvents: 'none',
          }}>
            <div style={{
              position:    'absolute',
              bottom:       'calc(100% + 6px)',
              left:        '50%',
              transform:   'translateX(-50%)',
              background:  'var(--surface-high)',
              borderRadius: 4,
              padding:     '3px 7px',
              fontSize:     11,
              fontWeight:   600,
              whiteSpace:  'nowrap',
              color:        'var(--text-primary)',
            }}>
              {hoverTime}
            </div>
          </div>
        )}

        {/* Playhead */}
        {playhead !== null && (
          <div style={{
            position:  'absolute',
            top:       -6,
            bottom:    -6,
            left:      `${playhead * 100}%`,
            width:      2,
            background: '#FFFFFF',
            borderRadius: 1,
            pointerEvents: 'none',
            boxShadow: '0 0 8px rgba(255,255,255,0.6)',
          }}>
            {/* Diamond handle */}
            <div style={{
              position:   'absolute',
              top:        '50%',
              left:       '50%',
              transform:  'translate(-50%, -50%) rotate(45deg)',
              width:       8,
              height:      8,
              background: '#FFFFFF',
              borderRadius: 1,
            }} />
          </div>
        )}

        {/* Hour tick marks */}
        {ticks.map(h => (
          <div key={h} style={{
            position:   'absolute',
            bottom:     -18,
            left:       `${(h / 24) * 100}%`,
            transform:  'translateX(-50%)',
            fontSize:    9,
            color:      'var(--text-tertiary)',
            fontWeight:  500,
            letterSpacing: '0.03em',
          }}>
            {h === 0 ? '00:00' : h === 24 ? '23:59' : `${String(h).padStart(2,'0')}:00`}
          </div>
        ))}
      </div>

      {/* Clip count */}
      <div style={{ marginTop: 28, fontSize: 11, color: 'var(--text-tertiary)' }}>
        {clips.length > 0
          ? `${clips.length} clip${clips.length !== 1 ? 's' : ''} · click or drag to seek`
          : 'No recordings for this day'}
      </div>
    </div>
  );
}

// Find the clip whose time range contains `date`, or null
function _clipAt(clips, date) {
  const ts = date.getTime();
  return clips.find(c =>
    new Date(c.start_time).getTime() <= ts && ts < new Date(c.end_time).getTime()
  ) ?? null;
}

function _fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
