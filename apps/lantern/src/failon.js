// `lantern audit --fail-on`: when a pipeline should fail. A comma-separated list, any term failing the
// run: a severity for every finding (`high`), a category at a level (`a11y:serious`, `security:medium`;
// axe's words critical, serious, moderate, minor are critical, high, medium, low), or a lab metric past a
// value (`perf:lcp>2.5s`, `perf:cls>0.1`, `perf:inp>200ms`, `perf:weight>2mb`). `none` never fails. Pure.
import { CATEGORIES, METRICS, formatMetric } from './audit.js';

const LEVELS = { critical: 'critical', high: 'high', serious: 'high', medium: 'medium', moderate: 'medium', low: 'low', minor: 'low' };
const ORDER = ['critical', 'high', 'medium', 'low'];
const ALIASES = { sec: 'security', performance: 'perf', accessibility: 'a11y', basics: 'seo' };
const UNITS = { s: 1000, ms: 1, kb: 1000, mb: 1_000_000, b: 1, '': 1 };

/** The terms of a --fail-on value: [{ level, category? } | { metric, over }], or { error }. */
export function parseFailOn(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === 'none') return { terms: [] };
  const terms = [];
  for (const raw of text.split(',').map((t) => t.trim()).filter(Boolean)) {
    const metric = /^(?:perf:)?(lcp|cls|inp|ttfb|fcp|weight)\s*>\s*([\d.]+)\s*(s|ms|kb|mb|b)?$/.exec(raw);
    if (metric) {
      const n = Number(metric[2]);
      if (Number.isNaN(n)) return { error: `${raw}: ${metric[2]} isn't a number` };
      const unit = metric[3] ?? (metric[1] === 'cls' ? '' : metric[1] === 'weight' ? 'b' : 'ms');
      terms.push({ metric: metric[1], over: metric[1] === 'cls' ? n : n * UNITS[unit], text: raw });
      continue;
    }
    const [a, b] = raw.split(':');
    const category = b === undefined ? null : ALIASES[a] ?? a;
    const level = LEVELS[b ?? a];
    if (category && !CATEGORIES.includes(category)) return { error: `${raw}: the categories are ${CATEGORIES.join(', ')}` };
    if (!level) return { error: `${raw}: a level is critical, high (serious), medium (moderate) or low (minor), or a metric such as perf:lcp>2.5s` };
    terms.push({ level, ...(category ? { category } : {}), text: raw });
  }
  return { terms };
}

/** What fails in `result` (a page's) under `terms`: sentences, empty when it passes. */
export function failures(result, terms) {
  const out = [];
  for (const t of terms) {
    if (t.metric) {
      const v = t.metric === 'weight' ? result.weight?.total : result.vitals?.[t.metric];
      if (typeof v === 'number' && v > t.over) out.push(`${METRICS.find((m) => m.id === t.metric)?.label ?? 'weight'} ${formatMetric(t.metric, v)} > ${formatMetric(t.metric, t.over)} (${t.text})`);
      continue;
    }
    const n = result.findings.filter((f) => (!t.category || f.category === t.category) && ORDER.includes(f.severity) && ORDER.indexOf(f.severity) <= ORDER.indexOf(t.level)).length;
    if (n) out.push(`${n} finding${n === 1 ? '' : 's'} at ${t.text}`);
  }
  return out;
}
