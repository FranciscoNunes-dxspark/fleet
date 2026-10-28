// The native views the apps can ask the window for (the kit's ui/GuiView.jsx), drawn here, pure: each
// kind's data and its size in pixels → SVG. The window adds hovering (where.js's job is `pointAt`).
//
// 'chart' data:
//   { type: 'line', title?, x: { kind: 'time' | 'number', values }, series: [{ name, values }] }
//   { type: 'bars', title?, labels, series: [{ name, values }], share? }   (share: a pie, as bars with each one's %)
//   { type: 'scatter', title?, xName?, yName?, points: [[x, y], …] }
//   { type: 'histogram', title?, name?, values }

export const SERIES_COLOURS = ['#7ab8ff', '#76c776', '#f0a24a', '#d695ea', '#66d2dd', '#ef6b73', '#f0cb74', '#a0a8b8'];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A number as an axis label: 1.2k, 3.4M, 0.25. */
export function shortNumber(v) {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}G`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}k`;
  if (a >= 100 || Number.isInteger(v)) return String(Math.round(v));
  return String(+v.toPrecision(3));
}

/** Round numbers between `min` and `max`, about `count` of them: { min, max, ticks }. */
export function niceScale(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad / 2;
    max += pad / 2;
  }
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(+t.toPrecision(12));
  return { min: lo, max: hi, ticks };
}

const timeOf = (v) => (typeof v === 'number' ? v : Date.parse(v));

const MIN = 60_000;
const TIME_STEPS = [MIN, 5 * MIN, 15 * MIN, 30 * MIN, 60 * MIN, 2 * 60 * MIN, 3 * 60 * MIN, 6 * 60 * MIN, 12 * 60 * MIN, 24 * 60 * MIN, 2 * 24 * 60 * MIN, 7 * 24 * 60 * MIN, 30 * 24 * 60 * MIN];

/** Ticks on round times between `min` and `max` (ms), about `count` of them: on the hour, the day… in local time. */
export function timeTicks(min, max, count = 5) {
  const step = TIME_STEPS.find((s) => (max - min) / s <= count) ?? TIME_STEPS.at(-1);
  // Local midnight, so hours and days fall where a clock says they do.
  const day = new Date(min);
  day.setHours(0, 0, 0, 0);
  const origin = step >= 24 * 60 * MIN ? day.getTime() : day.getTime() + Math.ceil((min - day.getTime()) / step) * step;
  const out = [];
  for (let t = origin; t <= max; t += step) if (t >= min) out.push(t);
  return out;
}

/** A time as an axis label, as fine as the span needs. */
function timeLabel(ms, span) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  if (span <= 2 * 86400_000) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (span <= 120 * 86400_000) return `${d.getDate()}/${d.getMonth() + 1}`;
  return `${d.getMonth() + 1}/${d.getFullYear()}`;
}

/** Histogram bins for `values`: [{ from, to, count }], about the square root of their number. */
export function bins(values, count = Math.min(40, Math.max(5, Math.round(Math.sqrt(values.length))))) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return [];
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const width = (max - min) / count || 1;
  const out = Array.from({ length: count }, (_, i) => ({ from: min + i * width, to: min + (i + 1) * width, count: 0 }));
  for (const v of nums) out[Math.min(count - 1, Math.floor((v - min) / width))].count++;
  return out;
}

/**
 * A chart's layout at `width`×`height` pixels: the plot's box, its scales and its marks, which both
 * the SVG and the hover read. Null when there's nothing to draw.
 */
export function chartLayout(data, width, height) {
  if (!data || width < 60 || height < 40) return null;
  const legend = (data.series?.length ?? 0) > 1 ? 18 : 0;
  const title = data.title ? 20 : 0;
  const box = { left: 52, right: width - 14, top: 10 + title + legend, bottom: height - 26 };
  if (box.right - box.left < 20 || box.bottom - box.top < 20) return null;
  const px = (v, s) => box.left + ((v - s.min) / (s.max - s.min || 1)) * (box.right - box.left);
  const py = (v, s) => box.bottom - ((v - s.min) / (s.max - s.min || 1)) * (box.bottom - box.top);
  const range = (vs) => {
    const ok = vs.filter(Number.isFinite);
    return ok.length ? [Math.min(...ok), Math.max(...ok)] : [0, 1];
  };

  if (data.type === 'line') {
    const xs = (data.x?.values ?? []).map((v) => (data.x?.kind === 'time' ? timeOf(v) : Number(v)));
    const [x0, x1] = range(xs);
    const xs2 = { min: x0, max: x1 === x0 ? x0 + 1 : x1 };
    const all = data.series.flatMap((s) => s.values).filter(Number.isFinite);
    const y = niceScale(Math.min(0, ...all), Math.max(...all, 0));
    const lines = data.series.map((s) => ({ name: s.name, points: s.values.map((v, i) => (Number.isFinite(v) && Number.isFinite(xs[i]) ? [px(xs[i], xs2), py(v, y), v, i] : null)) }));
    const span = xs2.max - xs2.min;
    const count = Math.max(2, Math.floor((box.right - box.left) / 90));
    const xticks = data.x?.kind === 'time' ? timeTicks(xs2.min, xs2.max, count) : niceScale(xs2.min, xs2.max, count).ticks.filter((t) => t >= xs2.min && t <= xs2.max);
    return { type: 'line', box, y, lines, xs, xLabel: (v) => (data.x?.kind === 'time' ? timeLabel(v, span) : shortNumber(v)), xticks: xticks.map((t) => [px(t, xs2), t]), yAt: (v) => py(v, y) };
  }
  if (data.type === 'bars') {
    const labels = data.labels ?? [];
    const n = labels.length || 1;
    const all = data.series.flatMap((s) => s.values).filter(Number.isFinite);
    const y = niceScale(Math.min(0, ...all), Math.max(...all, 0));
    const slot = (box.right - box.left) / n;
    const k = data.series.length || 1;
    const bw = Math.max(1, (slot * 0.78) / k);
    const bars = [];
    labels.forEach((label, i) => {
      data.series.forEach((s, j) => {
        const v = s.values[i];
        if (!Number.isFinite(v)) return;
        const x = box.left + i * slot + slot * 0.11 + j * bw;
        const top = py(Math.max(0, v), y);
        const bottom = py(Math.min(0, v), y);
        bars.push({ i, j, x, w: bw, top, h: Math.max(1, bottom - top), v, label });
      });
    });
    return { type: 'bars', box, y, bars, slot, labels, yAt: (v) => py(v, y) };
  }
  if (data.type === 'scatter') {
    const pts = (data.points ?? []).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    const xsc = niceScale(...range(pts.map((p) => p[0])));
    const ysc = niceScale(...range(pts.map((p) => p[1])));
    return { type: 'scatter', box, y: ysc, x: xsc, dots: pts.map(([a, b], i) => [px(a, xsc), py(b, ysc), a, b, i]), xticks: xsc.ticks.map((t) => [px(t, xsc), t]), xLabel: shortNumber, yAt: (v) => py(v, ysc) };
  }
  if (data.type === 'histogram') {
    const bs = bins(data.values ?? []);
    if (!bs.length) return null;
    const y = niceScale(0, Math.max(...bs.map((b) => b.count)));
    const xsc = { min: bs[0].from, max: bs.at(-1).to };
    const bars = bs.map((b, i) => ({ i, j: 0, x: px(b.from, xsc) + 0.5, w: Math.max(1, px(b.to, xsc) - px(b.from, xsc) - 1), top: py(b.count, y), h: Math.max(0, py(0, y) - py(b.count, y)), v: b.count, label: `${shortNumber(b.from)}–${shortNumber(b.to)}` }));
    const ticks = niceScale(xsc.min, xsc.max, 5).ticks.filter((t) => t >= xsc.min && t <= xsc.max);
    return { type: 'histogram', box, y, bars, xticks: ticks.map((t) => [px(t, xsc), t]), xLabel: shortNumber, yAt: (v) => py(v, y) };
  }
  return null;
}

/** The chart as SVG, `width`×`height` pixels; `colours` for the axes and text. */
export function chartSvg(data, width, height, { text = '#8b93a3', grid = '#2a303c', palette = SERIES_COLOURS } = {}) {
  const L = chartLayout(data, width, height);
  if (!L) return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`;
  const { box } = L;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="system-ui, sans-serif" font-size="11">`;
  if (data.title) out += `<text x="${box.left}" y="16" fill="${text}" font-size="12" font-weight="600">${esc(data.title)}</text>`;
  if ((data.series?.length ?? 0) > 1) {
    let x = box.left;
    const ly = (data.title ? 20 : 0) + 18;
    data.series.forEach((s, i) => {
      out += `<rect x="${x}" y="${ly - 9}" width="10" height="10" rx="2" fill="${palette[i % palette.length]}"/><text x="${x + 14}" y="${ly}" fill="${text}">${esc(s.name)}</text>`;
      x += 24 + String(s.name).length * 6.4;
    });
  }
  // The value axis: its grid and labels.
  for (const t of L.y.ticks) {
    const y = L.yAt(t);
    if (y < box.top - 0.5 || y > box.bottom + 0.5) continue;
    out += `<line x1="${box.left}" x2="${box.right}" y1="${y}" y2="${y}" stroke="${grid}" ${t === 0 ? '' : 'stroke-dasharray="2 3"'}/>`;
    out += `<text x="${box.left - 6}" y="${y + 4}" fill="${text}" text-anchor="end">${esc(shortNumber(t))}</text>`;
  }
  for (const [x, t] of L.xticks ?? []) out += `<text x="${x}" y="${box.bottom + 16}" fill="${text}" text-anchor="middle">${esc(L.xLabel(t))}</text>`;
  if (L.type === 'line') {
    L.lines.forEach((line, i) => {
      const colour = palette[i % palette.length];
      // A gap in the values is a gap in the line.
      let d = '';
      let pen = false;
      for (const p of line.points) {
        if (!p) {
          pen = false;
          continue;
        }
        d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
        pen = true;
      }
      if (L.lines.length === 1) {
        const pts = line.points.filter(Boolean);
        if (pts.length > 1) out += `<path d="M${pts[0][0]},${L.yAt(Math.max(L.y.min, 0))}${pts.map((p) => `L${p[0]},${p[1]}`).join('')}L${pts.at(-1)[0]},${L.yAt(Math.max(L.y.min, 0))}Z" fill="${colour}" opacity=".12"/>`;
      }
      out += `<path d="${d}" fill="none" stroke="${colour}" stroke-width="1.8" stroke-linejoin="round"/>`;
    });
  } else if (L.type === 'bars' || L.type === 'histogram') {
    for (const b of L.bars) out += `<rect x="${b.x.toFixed(1)}" y="${b.top.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="2" fill="${palette[b.j % palette.length]}" data-i="${b.i}"/>`;
    if (L.type === 'bars') {
      const every = Math.max(1, Math.ceil(L.labels.length / Math.max(1, Math.floor((box.right - box.left) / 70))));
      L.labels.forEach((label, i) => {
        if (i % every) return;
        const x = box.left + i * L.slot + L.slot / 2;
        const short = String(label).length > 12 ? `${String(label).slice(0, 11)}…` : String(label);
        out += `<text x="${x}" y="${box.bottom + 16}" fill="${text}" text-anchor="middle">${esc(short)}</text>`;
      });
    }
  } else if (L.type === 'scatter') {
    for (const [x, y] of L.dots) out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${palette[0]}" opacity=".8"/>`;
  }
  out += `<line x1="${box.left}" x2="${box.left}" y1="${box.top}" y2="${box.bottom}" stroke="${grid}"/>`;
  return `${out}</svg>`;
}

/**
 * What's under the pointer at (`x`, `y`) pixels in a chart: { x, y, lines: [text…] } for a read-out, or
 * null. Lines: the nearest stamp's value of each series; bars: the bar under it; scatter: the nearest dot.
 */
export function pointAt(data, width, height, x, y) {
  const L = chartLayout(data, width, height);
  if (!L || x < L.box.left - 4 || x > L.box.right + 4) return null;
  if (L.type === 'line') {
    let best = null;
    for (const line of L.lines) for (const p of line.points) if (p && (!best || Math.abs(p[0] - x) < Math.abs(best[0] - x))) best = p;
    if (!best) return null;
    const i = best[3];
    const head = L.xLabel(L.xs[i]);
    const full = data.x?.kind === 'time' ? new Date(L.xs[i]).toLocaleString() : head;
    return { x: best[0], y: best[1], lines: [full, ...data.series.map((s) => `${s.name}: ${Number.isFinite(s.values[i]) ? shortNumber(s.values[i]) : '—'}`)] };
  }
  if (L.type === 'bars' || L.type === 'histogram') {
    const b = L.bars.find((bar) => x >= bar.x && x <= bar.x + bar.w);
    if (!b) return null;
    const name = L.type === 'bars' && data.series.length > 1 ? `${data.series[b.j].name}: ` : '';
    const share = data.share && data.type === 'bars' ? ` (${((b.v / data.series[b.j].values.reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0)) * 100).toFixed(1)}%)` : '';
    return { x: b.x + b.w / 2, y: b.top, lines: [String(b.label), `${name}${b.v.toLocaleString()}${share}`] };
  }
  if (L.type === 'scatter') {
    let best = null;
    let dist = Infinity;
    for (const d of L.dots) {
      const dd = (d[0] - x) ** 2 + (d[1] - y) ** 2;
      if (dd < dist) {
        dist = dd;
        best = d;
      }
    }
    if (!best || dist > 400) return null;
    return { x: best[0], y: best[1], lines: [`${data.xName ?? 'x'}: ${shortNumber(best[2])}`, `${data.yName ?? 'y'}: ${shortNumber(best[3])}`] };
  }
  return null;
}
