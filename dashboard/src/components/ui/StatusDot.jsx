const COLOR = { online: '#30D158', offline: '#FF453A', error: '#FF9F0A' };

export default function StatusDot({ status, size = 7 }) {
  const color = COLOR[status] ?? '#636366';
  return (
    <span style={{
      display:       'inline-block',
      width:          size,
      height:         size,
      borderRadius:  '50%',
      background:     color,
      boxShadow:      status === 'online' ? `0 0 6px ${color}88` : 'none',
      flexShrink:     0,
    }} />
  );
}
