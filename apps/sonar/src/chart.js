// A query's result drawn as a chart in Logs: a time series as a sparkline per series on one time axis,
// with each one's min, max and last; categories as horizontal bars with their values (a pie as bars
// with each one's share). Pure: which chart a result makes, and its lines of segments (colours read
// from the theme when they're made, as everything drawn does).
import { theme } from './theme.js';
import { fit, stringWidth } from '@fleet/kit/text.js';

/** The chart a query asks for with `| render …`: 'time' (timechart, linechart, areachart), 'bars' (columnchart, barchart) or 'pie'; null for none. */
export function renderKind(query) {
  const kind = /\|\s*render\s+(\w+)/i.exec(String(query ?? ''))?.[1]?.toLowerCase();
  if (!kind) return null;
  if (/^(timechart|linechart|areachart|scatterchart)$/.test(kind)) return 'time';
  if (/^(columnchart|barchart|stackedareachart)$/.test(kind)) return 'bars';
  if (kind === 'piechart') return 'pie';
  return null;
}

const NUMERIC = /^(long|int|real|decimal|double|float|number)$/i;
const isNumber = (c) => NUMERIC.test(c.type ?? '');
const isTime = (c) => /^(datetime|date|timestamp)$/i.test(c.type ?? '');
const MAX_SERIES = 8;
const MAX_BARS = 50;

/**
 * What `table` ({ columns, rows }) makes as a chart of `kind` (renderKind's, or null to work it out):
 * { type: 'time', stamps, series: [{ name, values: [number|null per stamp] }] }, or { type: 'bars',
 * pie, bars: [{ label, value }], more }, or { error } when it makes none (no number column, say).
 */
export function chartOf(table, kind = null) {
  const cols = (table?.columns ?? []).map((c, i) => ({ ...c, i }));
  const rows = table?.rows ?? [];
  const nums = cols.filter(isNumber);
  const time = cols.find(isTime);
  const words = cols.filter((c) => !isNumber(c) && !isTime(c));
  if (!rows.length) return { error: 'Nothing came back to draw.' };
  if (!nums.length) return { error: 'A chart needs a column of numbers: summarize count() by … makes one.' };
  if (time && kind !== 'bars' && kind !== 'pie') {
    const stamps = [...new Set(rows.map((r) => String(r[time.i])))].filter((s) => s && s !== 'null').sort();
    const at = new Map(stamps.map((s, i) => [s, i]));
    let series;
    // One number split by a name column: a series per name (the biggest few); else a series per number column.
    if (words.length && nums.length === 1) {
      const by = new Map();
      for (const r of rows) {
        const name = String(r[words[0].i] ?? '');
        const s = by.get(name) ?? { name, values: Array(stamps.length).fill(null), total: 0 };
        const v = Number(r[nums[0].i]);
        if (at.has(String(r[time.i])) && Number.isFinite(v)) {
          s.values[at.get(String(r[time.i]))] = (s.values[at.get(String(r[time.i]))] ?? 0) + v;
          s.total += v;
        }
        by.set(name, s);
      }
      series = [...by.values()].sort((a, b) => b.total - a.total);
    } else {
      series = nums.map((c) => {
        const values = Array(stamps.length).fill(null);
        for (const r of rows) {
          const v = Number(r[c.i]);
          if (at.has(String(r[time.i])) && Number.isFinite(v)) values[at.get(String(r[time.i]))] = (values[at.get(String(r[time.i]))] ?? 0) + v;
        }
        return { name: c.name, values };
      });
    }
    return { type: 'time', stamps, series: series.slice(0, MAX_SERIES).map(({ name, values }) => ({ name, values })), more: Math.max(0, series.length - MAX_SERIES) };
  }
  const label = words[0] ?? time ?? cols.find((c) => c !== nums[0]);
  const value = nums.find((c) => c !== label) ?? nums[0];
  const bars = rows.map((r) => ({ label: label ? String(r[label.i] ?? '') : '', value: Number(r[value.i]) || 0 }));
  return { type: 'bars', pie: kind === 'pie', bars: bars.slice(0, MAX_BARS), more: Math.max(0, bars.length - MAX_BARS), total: bars.reduce((n, b) => n + b.value, 0) };
}

/**
 * A chart (chartOf's) as Fleet's window draws it natively (the kit's GuiView, kind 'chart'): a time
 * series as lines, bars as bars, a pie as bars with each one's share. Null for none (an error).
 */
export function windowChart(chart) {
  if (!chart || chart.error) return null;
  if (chart.type === 'time') return { type: 'line', x: { kind: 'time', values: chart.stamps }, series: chart.series };
  return { type: 'bars', labels: chart.bars.map((b) => b.label), series: [{ name: 'value', values: chart.bars.map((b) => b.value) }], share: Boolean(chart.pie) };
}

/** A number short: 12, 3.46, 1.2k, 4.5M. */
export function short(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  if (Number.isInteger(v)) return String(v);
  return a >= 100 ? v.toFixed(0) : a >= 1 ? v.toFixed(2).replace(/\.?0+$/, '') : v.toPrecision(2);
}

const BARS = '▁▂▃▄▅▆▇█';

/**
 * Values in `width` buckets (consecutive ones joined when there are more: summed when they're whole
 * numbers, as counts are, else averaged), drawn against the series' own range.
 */
export function spark(values, width) {
  const n = values.length;
  const k = Math.max(1, Math.min(width, n));
  const whole = values.every((v) => v == null || Number.isInteger(v));
  const buckets = Array.from({ length: k }, (_, i) => {
    const part = values.slice(Math.floor((i * n) / k), Math.floor(((i + 1) * n) / k)).filter((v) => v != null);
    if (!part.length) return null;
    const sum = part.reduce((a, b) => a + b, 0);
    return whole ? sum : sum / part.length;
  });
  const present = buckets.filter((v) => v != null);
  const lo = Math.min(0, ...present);
  const hi = Math.max(...present, lo + 1e-9);
  return buckets.map((v) => (v == null ? ' ' : BARS[Math.min(7, Math.max(0, Math.round(((v - lo) / (hi - lo)) * 7)))])).join('');
}

const when = (s) => String(s).replace('T', ' ').replace(/:\d\d(\.\d+)?Z$|Z$/, '');

/** The chart as lines of segments `width` wide: what LogsView draws in place of the grid. */
export function chartLines(chart, width) {
  if (chart.error) return [[{ text: chart.error, color: theme.dim }]];
  if (chart.type === 'time') {
    const nameW = Math.min(24, Math.max(6, ...chart.series.map((s) => stringWidth(s.name))));
    const stats = (s) => {
      const vs = s.values.filter((v) => v != null);
      return `min ${short(Math.min(...vs))} · max ${short(Math.max(...vs))} · last ${short(vs.at(-1))}`;
    };
    const statW = Math.max(...chart.series.map((s) => stringWidth(stats(s))));
    const w = Math.max(8, Math.min(chart.stamps.length, width - nameW - statW - 6));
    const lines = chart.series.map((s, i) => [
      { text: `${fit(s.name, nameW)}  `, color: i ? theme.info : theme.accent, bold: true },
      { text: spark(s.values, w), color: i % 2 ? theme.info : theme.warn },
      { text: `  ${stats(s)}`, color: theme.dim },
    ]);
    const from = when(chart.stamps[0]);
    const to = when(chart.stamps.at(-1));
    const axis = from === to ? from : `${from}${' '.repeat(Math.max(1, w - stringWidth(from) - stringWidth(to)))}${to}`;
    lines.push([{ text: ' '.repeat(nameW + 2) }, { text: axis, color: theme.dim }]);
    lines.push([{ text: ' '.repeat(nameW + 2) }, { text: `${chart.stamps.length} points${chart.stamps.length > w ? `, ${Math.ceil(chart.stamps.length / w)} to a mark` : ''}${chart.more ? ` · ${chart.more} more series not drawn` : ''}`, color: theme.dim }]);
    return lines;
  }
  const max = Math.max(...chart.bars.map((b) => b.value), 0);
  const labelW = Math.min(30, Math.max(4, ...chart.bars.map((b) => stringWidth(b.label))));
  const said = (b) => (chart.pie ? `${short(b.value)} (${chart.total ? Math.round((b.value / chart.total) * 100) : 0}%)` : short(b.value));
  const valueW = Math.max(...chart.bars.map((b) => stringWidth(said(b))));
  const barW = Math.max(4, width - labelW - valueW - 6);
  const parts = ' ▏▎▍▌▋▊▉';
  const bar = (v) => {
    const cells = max > 0 ? (Math.max(0, v) / max) * barW : 0;
    const full = Math.floor(cells);
    return `${'█'.repeat(full)}${cells - full > 0.0625 ? parts[Math.round((cells - full) * 8)] ?? '' : ''}`;
  };
  const lines = chart.bars.map((b, i) => [
    { text: `${fit(b.label, labelW)}  `, bold: true },
    { text: fit(bar(b.value), barW), color: chart.pie ? [theme.accent, theme.info, theme.warn, theme.add, theme.del][i % 5] : theme.accent },
    { text: `  ${said(b).padStart(valueW)}`, color: theme.dim },
  ]);
  if (chart.more) lines.push([{ text: `… ${chart.more} more not drawn`, color: theme.dim }]);
  return lines;
}
