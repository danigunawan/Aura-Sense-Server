import { useState } from 'react';

const OPTIONS = [4, 8, 16];

const ICON = {
  4:  <Grid2 />,
  8:  <Grid4x2 />,
  16: <Grid4 />,
};

export default function GridToggle({ value, onChange }) {
  return (
    <div style={{
      display:       'flex',
      gap:            2,
      background:    'var(--surface)',
      borderRadius:  'var(--radius-sm)',
      padding:        2,
    }}>
      {OPTIONS.map((n) => (
        <button
          key={n}
          onClick={() => onChange(n)}
          title={`${n} cameras`}
          style={{
            display:        'flex',
            alignItems:     'center',
            gap:             5,
            padding:        '5px 10px',
            borderRadius:   4,
            fontSize:        12,
            fontWeight:      500,
            color:           value === n ? 'var(--text-primary)' : 'var(--text-secondary)',
            background:      value === n ? 'var(--surface-mid)' : 'transparent',
            transition:     'background 0.15s var(--ease), color 0.15s var(--ease)',
          }}
        >
          {ICON[n]}
          {n}
        </button>
      ))}
    </div>
  );
}

function Grid2() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <rect x="0" y="0" width="6" height="6" rx="1" />
      <rect x="8" y="0" width="6" height="6" rx="1" />
      <rect x="0" y="8" width="6" height="6" rx="1" />
      <rect x="8" y="8" width="6" height="6" rx="1" />
    </svg>
  );
}

function Grid4x2() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      {[0,1,2,3].map(i => <rect key={i} x={i * 3.5} y="0" width="2.5" height="6" rx="0.8" />)}
      {[0,1,2,3].map(i => <rect key={i+4} x={i * 3.5} y="8" width="2.5" height="6" rx="0.8" />)}
    </svg>
  );
}

function Grid4() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      {[0,1,2,3].map(row =>
        [0,1,2,3].map(col =>
          <rect key={`${row}-${col}`} x={col*3.5} y={row*3.5} width="2.5" height="2.5" rx="0.6" />
        )
      )}
    </svg>
  );
}
