// What Lantern hands its siblings and the reports it writes: a request for Hail, the comparison of two
// pages (or two runs of one), and the audit as Markdown. Pure.
import { countFindings, findingsLine } from '@fleet/kit/findings.js';
import { CATEGORIES, CATEGORY_LABEL, METRICS, bytes, formatMetric, vitalsLine } from './audit.js';

const SEVERITY_LABEL = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW', unknown: '?' };

/**
 * A request from the Waterfall as Hail's `request` context: the method and URL, and what came back.
 * No headers: the browser's carried the session's cookies, and nothing secret goes in a context.
 */
export function requestContext(req) {
  return {
    method: req.method ?? 'GET',
    url: req.url,
    headers: {},
    body: '',
    name: `${req.type} ${req.url.split('?')[0].split('/').filter(Boolean).at(-1) ?? req.url}`,
    app: 'lantern',
    ...(req.status ? { response: { status: req.status, ...(req.end !== null && req.end !== undefined ? { ms: req.end - req.start } : {}) } } : {}),
  };
}

/** A page's label in a comparison: its environment, else its host, and "earlier" for an older run of the same. */
export function sideLabel(result, other) {
  const base = result.env ?? (() => {
    try {
      return new URL(result.url).host;
    } catch {
      return result.url;
    }
  })();
  if (other && other.url === result.url && other.at !== result.at) return result.at < other.at ? `${base}, earlier` : `${base}, latest`;
  return base;
}

/** The difference from `a` to `b` as words: "+1.1 s (61% slower)", "−0.08 (better)", "same". */
export function delta(id, a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return '';
  const d = b - a;
  if (Math.abs(d) < (id === 'cls' ? 0.005 : 10)) return 'about the same';
  const size = id === 'cls' ? Math.abs(d).toFixed(2) : id === 'weight' ? bytes(Math.abs(d)) : formatMetric(id, Math.abs(d));
  const pct = a ? ` (${Math.round((Math.abs(d) / a) * 100)}% ${d > 0 ? (id === 'weight' ? 'heavier' : 'worse') : id === 'weight' ? 'lighter' : 'better'})` : '';
  return `${d > 0 ? '+' : '−'}${size}${pct}`;
}

/** The rows of Compare: each metric, the weight, the requests and each category's findings, a against b. */
export function compareRows(a, b) {
  const rows = METRICS.map((m) => ({ id: m.id, label: m.label, a: formatMetric(m.id, a.vitals?.[m.id]), b: formatMetric(m.id, b.vitals?.[m.id]), delta: delta(m.id, a.vitals?.[m.id], b.vitals?.[m.id]), worse: (b.vitals?.[m.id] ?? 0) > (a.vitals?.[m.id] ?? 0) }));
  rows.push({ id: 'weight', label: 'Weight', a: a.weight ? bytes(a.weight.total) : '—', b: b.weight ? bytes(b.weight.total) : '—', delta: delta('weight', a.weight?.total, b.weight?.total), worse: (b.weight?.total ?? 0) > (a.weight?.total ?? 0) });
  rows.push({ id: 'requests', label: 'Requests', a: a.weight ? String(a.weight.count) : '—', b: b.weight ? String(b.weight.count) : '—', delta: a.weight && b.weight ? (b.weight.count - a.weight.count ? `${b.weight.count > a.weight.count ? '+' : '−'}${Math.abs(b.weight.count - a.weight.count)}` : 'the same') : '', worse: (b.weight?.count ?? 0) > (a.weight?.count ?? 0) });
  for (const c of CATEGORIES) {
    const na = a.findings.filter((f) => f.category === c);
    const nb = b.findings.filter((f) => f.category === c);
    rows.push({ id: c, label: CATEGORY_LABEL[c], a: findingsLine(countFindings(na)) || 'none', b: findingsLine(countFindings(nb)) || 'none', delta: nb.length - na.length ? `${nb.length > na.length ? '+' : '−'}${Math.abs(nb.length - na.length)}` : '', worse: nb.length > na.length });
  }
  return rows;
}

/** One sentence: "staging LCP is 1.8 s, prod 2.9 s", with the next metric that differs most when it's a quarter apart or more. */
export function compareSentence(a, b) {
  const la = sideLabel(a, b);
  const lb = sideLabel(b, a);
  if (!a.vitals || !b.vitals) return `${la}: ${vitalsLine(a.vitals)}; ${lb}: ${vitalsLine(b.vitals)}.`;
  const parts = [`${la} LCP is ${formatMetric('lcp', a.vitals.lcp)}, ${lb} ${formatMetric('lcp', b.vitals.lcp)}`];
  const ratio = (id) => {
    const x = a.vitals[id];
    const y = b.vitals[id];
    if (typeof x !== 'number' || typeof y !== 'number' || Math.max(x, y) === 0) return 0;
    return Math.abs(y - x) / Math.max(x, y, id === 'cls' ? 0.01 : 1);
  };
  const next = ['cls', 'inp', 'ttfb', 'fcp'].sort((x, y) => ratio(y) - ratio(x))[0];
  if (ratio(next) >= 0.25) parts.push(`${METRICS.find((m) => m.id === next).label} ${formatMetric(next, a.vitals[next])} against ${formatMetric(next, b.vitals[next])}`);
  return `${parts.join('; ')} (lab numbers).`;
}

/** The audited pages as Markdown, for a pull request or a ticket: each page's vitals, then its findings worst first. */
export function markdownReport(results, { name = 'the site', when = new Date() } = {}) {
  const lines = [`# Lantern: ${name}`, '', `${results.length} page${results.length === 1 ? '' : 's'} audited, ${when.toISOString().slice(0, 10)}. Lab numbers: a headless Chrome on one machine, the median of its runs, not visitors' field data.`, ''];
  lines.push('| Page | LCP | CLS | INP | TTFB | Weight | Found |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results) lines.push(`| ${r.env ? `${r.env} ` : ''}${r.url} | ${['lcp', 'cls', 'inp', 'ttfb'].map((m) => formatMetric(m, r.vitals?.[m])).join(' | ')} | ${r.weight ? bytes(r.weight.total) : '—'} | ${findingsLine(countFindings(r.findings)) || 'nothing'} |`);
  for (const r of results) {
    lines.push('', `## ${r.env ? `${r.env}: ` : ''}${r.url}`, '');
    if (r.note) lines.push(`_${r.note}_`, '');
    if (!r.findings.length) lines.push('Nothing found.');
    else {
      lines.push('| Severity | Category | Finding | Element | Fix |', '| --- | --- | --- | --- | --- |');
      const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      for (const f of r.findings) lines.push(`| ${SEVERITY_LABEL[f.severity]} | ${f.category} | ${cell(f.title)}${f.wcag ? ` (${f.wcag})` : ''} | ${f.selector ? `\`${cell(f.selector)}\`` : ''} | ${cell(f.fix)} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}
