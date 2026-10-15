import { useLayoutEffect, useRef, useState } from 'react';

// Small single-series charts. One hue (the accent), text in ink tokens,
// recessive gridlines, and a hover/focus tooltip on every mark.

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export function ColumnChart({ data, label, valueLabel, formatX = (x) => x, height = 180 }) {
  const [hover, setHover] = useState(null);
  const [ref, measured] = useWidth();
  const max = Math.max(1, ...data.map((d) => d.value));
  const nice = niceMax(max);
  const ticks = [0, nice / 2, nice];
  const W = measured || 480;
  const H = height;
  const pad = { l: 32, r: 8, t: 8, b: 26 };
  const bw = (W - pad.l - pad.r) / data.length;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / nice);

  return (
    <figure className="chart">
      <figcaption className="chart-title">{label}</figcaption>
      <div className="chart-body" ref={ref}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="chart-svg">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
              <text x={pad.l - 6} y={y(t) + 4} className="axis" textAnchor="end">{t}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = pad.l + i * bw + bw * 0.2;
            const w = Math.max(2, bw * 0.6);
            const top = y(d.value);
            const h = H - pad.b - top;
            return (
              <g key={d.key}>
                {h > 0 && <path d={roundedTop(x, top, w, h, Math.min(4, w / 2, h))} className="bar" />}
                <rect
                  x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b}
                  className="hit" tabIndex={0}
                  aria-label={`${formatX(d.key)}: ${d.value} ${valueLabel}`}
                  onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                />
                {(i % Math.ceil(data.length / Math.max(1, Math.floor(W / 90))) === 0) && (
                  <text x={pad.l + i * bw + bw / 2} y={H - 8} className="axis" textAnchor="middle">{formatX(d.key)}</text>
                )}
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div className="tooltip" style={{ left: `${((pad.l + (hover + 0.5) * bw) / W) * 100}%`, top: `${(y(data[hover].value) / H) * 100}%` }}>
            <strong>{data[hover].value}</strong> {valueLabel}
            <div className="muted">{formatX(data[hover].key)}{data[hover].note ? ` · ${data[hover].note}` : ''}</div>
          </div>
        )}
      </div>
    </figure>
  );
}

export function BarList({ data, label, valueLabel, empty = 'No data in this range.' }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <figure className="chart">
      <figcaption className="chart-title">{label}</figcaption>
      {!data.length ? <p className="muted small">{empty}</p> : (
        <ul className="barlist">
          {data.map((d) => (
            <li key={d.key} title={`${d.label}: ${d.value} ${valueLabel}${total ? ` (${Math.round((d.value / total) * 100)}%)` : ''}${d.note ? ` · ${d.note}` : ''}`}>
              <span className="barlist-label truncate">{d.label}</span>
              <span className="barlist-track">{d.value > 0 && <span className="barlist-bar" style={{ width: `${(d.value / max) * 100}%` }} />}</span>
              <span className="barlist-value">{d.value}{d.note && <span className="muted"> · {d.note}</span>}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 4, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function roundedTop(x, y, w, h, r) {
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}
