import { useLayoutEffect, useRef, useState } from 'react';
import { t } from './i18n.js';

// Small single-series charts. One hue (the accent), text in ink tokens,
// recessive gridlines, and a hover/focus tooltip on every mark.

export function useWidth() {
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
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={pad.l} x2={W - pad.r} y1={y(tick)} y2={y(tick)} className="grid" />
              <text x={pad.l - 6} y={y(tick) + 4} className="axis" textAnchor="end">{tick}</text>
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

export function BarList({ data, label, valueLabel, empty = t('No data in this range.') }) {
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

/**
 * Aging work in progress: one column per state, one dot per item at its age
 * (days since it started), with lines at the median and 85th percentile
 * cycle time of recently finished work. Dots past the 85th percentile are
 * the ones to ask about. Clicking a dot opens it.
 */
export function AgingChart({ items, states, p50, p85, label, onOpen, height = 240 }) {
  const [hover, setHover] = useState(null);
  const [ref, measured] = useWidth();
  const W = measured || 520;
  const H = height;
  const pad = { l: 40, r: 44, t: 10, b: 30 };
  const days = (h) => (h == null ? 0 : h / 24);
  const max = niceMax(Math.max(1, ...items.map((i) => days(i.ageHours)), days(p85) * 1.1));
  const y = (d) => pad.t + (H - pad.t - pad.b) * (1 - d / max);
  const cols = states.length ? states : [''];
  const bw = (W - pad.l - pad.r) / cols.length;
  // Spread dots sideways by id so equal ages don't hide each other (the same on every render).
  const jitter = (id) => ((((Number(id) || 0) * 2654435761) % 1000) / 1000 - 0.5) * Math.min(bw * 0.6, 60);
  const pos = (it) => ({ cx: pad.l + (cols.indexOf(it.state) + 0.5) * bw + jitter(it.id), cy: y(days(it.ageHours)) });
  const ticks = [0, max / 2, max];
  const refLine = (h, text) => h != null && (
    <g>
      <line x1={pad.l} x2={W - pad.r} y1={y(days(h))} y2={y(days(h))} className="ref-line" />
      <text x={W - pad.r + 4} y={y(days(h)) + 4} className="axis">{text}</text>
    </g>
  );
  return (
    <figure className="chart aging-chart">
      <figcaption className="chart-title">{label}</figcaption>
      <div className="chart-body" ref={ref}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="chart-svg">
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={pad.l} x2={W - pad.r} y1={y(tick)} y2={y(tick)} className="grid" />
              <text x={pad.l - 6} y={y(tick) + 4} className="axis" textAnchor="end">{t('{n}d', { n: Math.round(tick) })}</text>
            </g>
          ))}
          {refLine(p50, t('50%'))}
          {refLine(p85, t('85%'))}
          {cols.map((s, i) => <text key={s} x={pad.l + (i + 0.5) * bw} y={H - 10} className="axis" textAnchor="middle">{s}</text>)}
          {items.map((it, i) => {
            const { cx, cy } = pos(it);
            return (
              <circle
                key={`${it.org || ''}:${it.id}`} cx={cx} cy={cy} r={hover === i ? 7 : 5}
                className={`dot ${it.overP85 ? 'dot-bad' : it.overMedian ? 'dot-warn' : ''}`}
                tabIndex={0} role="button"
                aria-label={t('{title}: {n} days in progress', { title: it.title, n: Math.round(days(it.ageHours)) })}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                onClick={() => onOpen?.(it)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen?.(it)}
              />
            );
          })}
        </svg>
        {hover !== null && items[hover] && (
          <div className="tooltip" style={{ left: `${(pos(items[hover]).cx / W) * 100}%`, top: `${(pos(items[hover]).cy / H) * 100}%` }}>
            <strong>{t('{n} days', { n: Math.round(days(items[hover].ageHours)) })}</strong> {items[hover].state}
            <div className="muted">{items[hover].title}{items[hover].assignedTo ? ` · ${items[hover].assignedTo}` : ''}</div>
          </div>
        )}
      </div>
    </figure>
  );
}
