// What changed an app, as marks on whatever Sonar draws over time (the problems' sparklines, a chart in
// Logs, the metrics in Resources, the rows of a result): its deployments, the slot swaps, settings saved
// and restarts the Azure activity log has for it, and what the family's apps did for this project
// (Keel's pipelines, Splice's pushes, Locker's changes, an environment switched). Pure: the provider
// reads deployments and changes, App the family's activity log; this says where each mark goes.
import { theme } from './theme.js';
import { cellText } from './insights.js';
import { relTime } from '@fleet/kit/text.js';
import { APP_NAMES } from '@fleet/kit/family.js';

const MINUTE = 60_000;

/**
 * The kinds of mark, in the order they win a cell they share: a letter, the word for the legend, its
 * colour (read while drawing). Deployments, swaps and settings are what a problem is "first seen after".
 */
export const MARKER_KINDS = {
  deploy: { letter: 'D', word: 'deployment', color: () => theme.accent },
  swap: { letter: 'S', word: 'slot swap', color: () => theme.warn },
  setting: { letter: 'C', word: 'setting change', color: () => theme.info },
  restart: { letter: 'R', word: 'restart', color: () => theme.del },
  pipeline: { letter: 'K', word: 'Keel pipeline', color: () => theme.add },
  push: { letter: 'P', word: 'Splice push', color: () => theme.add },
  secret: { letter: 'L', word: 'Locker change', color: () => theme.add },
  env: { letter: 'E', word: 'environment switch', color: () => theme.add },
  family: { letter: 'F', word: "a sibling's change", color: () => theme.add },
};
const ORDER = Object.keys(MARKER_KINDS);
const CAUSES = ['deploy', 'swap', 'setting'];

/** A commit's hash in a deployment: Kudu names a git deployment by it, and a message may say "Commit <hash>". */
export function commitOf(d) {
  const name = String(d?.name ?? '');
  if (/^[0-9a-f]{40}$/i.test(name)) return name.toLowerCase();
  const message = String(d?.message ?? '');
  const said = /\bcommit(?:\s+id)?[:\s]+'?([0-9a-f]{7,40})\b/i.exec(message)?.[1] ?? /\b([0-9a-f]{40})\b/i.exec(message)?.[1];
  return said ? said.toLowerCase() : null;
}

/** What an activity log operation did to an app or slot: 'swap', 'setting', 'restart' (a stop or start too), or null for the rest. */
export function changeKind(operation) {
  const op = String(operation ?? '').toLowerCase();
  if (/^microsoft\.web\/sites(\/slots)?\/(slotsswap|applyslotconfig)\/action$/.test(op)) return 'swap';
  if (/^microsoft\.web\/sites(\/slots)?\/config\/write$/.test(op)) return 'setting';
  if (/^microsoft\.web\/sites(\/slots)?\/(restart|stop|start)\/action$/.test(op)) return 'restart';
  return null;
}

const appIdOf = (id) => String(id ?? '').replace(/\/slots\/[^/]+$/i, '');

/**
 * The activity log's events for `target` as changes: [{ at, kind, what, who, resourceId }], oldest first,
 * one per operation (an operation logs Started, then Succeeded; only what succeeded changed anything).
 * A slot's own events are its; an app's are its own, and the swaps of its slots into it.
 */
export function changesFrom(events, target) {
  const mine = String(target.id).toLowerCase();
  const app = appIdOf(target.id).toLowerCase();
  const seen = new Set();
  const out = [];
  for (const e of events ?? []) {
    const op = e.operationName?.value ?? e.operationName ?? '';
    const kind = changeKind(op);
    if (!kind || String(e.status?.value ?? e.status ?? '').toLowerCase() !== 'succeeded') continue;
    const id = String(e.resourceId ?? '').toLowerCase();
    const own = id === mine;
    const swapIn = kind === 'swap' && !target.slot && appIdOf(id) === app;
    if (!own && !swapIn) continue;
    const key = e.correlationId ? `${e.correlationId}|${op}` : `${e.eventTimestamp}|${op}|${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const slot = /\/slots\/([^/]+)$/i.exec(e.resourceId ?? '')?.[1] ?? null;
    const verb = /\/stop\/action$/i.test(op) ? 'stopped' : /\/start\/action$/i.test(op) ? 'started' : null;
    const what = kind === 'swap' ? `${slot ? `${slot} swapped into production` : 'a slot swapped into production'}` : kind === 'setting' ? 'settings saved' : verb ?? 'restarted';
    out.push({ at: e.eventTimestamp ?? e.submissionTimestamp ?? null, kind, what, who: e.caller ?? '', resourceId: e.resourceId ?? '' });
  }
  return out.filter((c) => c.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const familyKind = (e) => {
  const text = String(e.text ?? '');
  if (/^switched\b/i.test(text)) return 'env';
  if (e.app === 'keel') return 'pipeline';
  if (e.app === 'splice') return e.kind === 'push' ? 'push' : null;
  if (e.app === 'locker') return e.kind !== 'info' && !/^copied\b/i.test(text) ? 'secret' : null;
  if (e.app === 'chart') return /^deployed\b/i.test(text) ? 'family' : null;
  return null;
};

/**
 * The marks over an app: its deployments that went through (deployments.js's list), the changes the
 * activity log has (changesFrom's), and the family's activity for the project (family.js readActivity's
 * entries); each { at (ms), kind, title, who, commit, where, source }, oldest first, between `from` and `to` (ms) when given.
 */
export function markersFrom({ deployments = [], changes = [], activity = [], from = -Infinity, to = Infinity } = {}) {
  const out = [];
  for (const d of deployments) {
    if (d.status !== 'succeeded' || !d.start) continue;
    out.push({ at: Date.parse(d.start), kind: 'deploy', title: String(d.message ?? '').split('\n')[0] || `deployment ${d.name}`, who: d.author ?? '', through: d.deployer ?? '', commit: d.commit ?? commitOf(d), id: d.name, source: 'App Service' });
  }
  for (const c of changes) out.push({ at: Date.parse(c.at), kind: c.kind, title: c.what, who: c.who ?? '', where: c.resourceId, source: 'the activity log' });
  for (const e of activity) {
    const kind = familyKind(e);
    if (kind) out.push({ at: Number(e.at), kind, title: e.text, who: APP_NAMES[e.app] ?? e.app, source: `${APP_NAMES[e.app] ?? e.app}, in the family's activity` });
  }
  return out.filter((m) => Number.isFinite(m.at) && m.at >= from && m.at <= to).sort((a, b) => a.at - b.at);
}

/**
 * Which marks fall in each of a drawing's cells: `stamps` the start of each time it has (ISO or ms,
 * oldest first), `cells` how many it's drawn in (consecutive stamps joined, as chart.js spark does
 * when there are more), `step` how long the last one lasts (else the shortest gap between them). A
 * mark in a gap goes to the stamp before it; one before the first or after the last one's end is left out.
 */
export function placeMarkers(markers, stamps, { cells = stamps.length, step } = {}) {
  const at = stamps.map((s) => (typeof s === 'number' ? s : Date.parse(s)));
  const n = at.length;
  const out = Array.from({ length: Math.max(0, Math.min(cells, n)) }, () => []);
  if (!n || !out.length) return out;
  const gaps = at.slice(1).map((t, i) => t - at[i]).filter((g) => g > 0);
  const last = step ?? (gaps.length ? Math.min(...gaps) : MINUTE);
  const k = out.length;
  for (const m of markers) {
    if (m.at < at[0] || m.at >= at[n - 1] + last) continue;
    let j = n - 1;
    while (j > 0 && at[j] > m.at) j--;
    // Cell i holds stamps floor(i*n/k) up to floor((i+1)*n/k).
    let i = Math.min(k - 1, Math.floor((j * k) / n));
    while (i > 0 && Math.floor((i * n) / k) > j) i--;
    while (i < k - 1 && Math.floor(((i + 1) * n) / k) <= j) i++;
    out[i].push(m);
  }
  return out;
}

/** The kind that shows for marks sharing a cell: the first in MARKER_KINDS' order. */
const lead = (list) => list.reduce((best, m) => (ORDER.indexOf(m.kind) < ORDER.indexOf(best.kind) ? m : best), list[0]);

/** placeMarkers's cells as a line of segments, one character each: the lead mark's letter in its colour, `blank` where there's none. */
export function markerSegments(cells, { blank = '·' } = {}) {
  return cells.map((list) => (list.length ? { text: MARKER_KINDS[lead(list).kind].letter, color: MARKER_KINDS[lead(list).kind].color(), bold: true } : { text: blank, color: theme.border }));
}

/** The legend for the kinds among `markers`: "D deployment  C setting change", as segments. */
export function legendSegments(markers) {
  const kinds = ORDER.filter((k) => markers.some((m) => m.kind === k));
  return kinds.flatMap((k, i) => [{ text: `${i ? '  ' : ''}${MARKER_KINDS[k].letter}`, color: MARKER_KINDS[k].color(), bold: true }, { text: ` ${MARKER_KINDS[k].word}`, color: theme.dim }]);
}

/** A mark in a few words: "deployment Release 2.14.0 by Ana Silva (9b1c7e2)". */
export function markerWords(m) {
  const what = m.kind === 'deploy' ? `deployment ${m.title}` : m.kind === 'setting' ? 'a setting change' : m.kind === 'swap' ? `a slot swap (${m.title})` : m.kind === 'restart' ? `a restart (${m.title})` : m.title;
  const who = m.who && !['pipeline', 'push', 'secret', 'env', 'family'].includes(m.kind) ? ` by ${m.who}` : '';
  return `${what}${who}${m.commit ? ` (${m.commit.slice(0, 7)})` : ''}`;
}

/**
 * The deployment, swap or setting change that came shortly before a problem was first seen (`first`, ISO
 * or ms): { marker, minutes } for the latest one in the `within` minutes before, else null. Only when the
 * problem was first seen at least that long into the span (`since`, ms): one first seen at its start may
 * have been there before it.
 */
export function firstSeenAfter(first, markers, { within = 120, since = -Infinity } = {}) {
  const t = typeof first === 'number' ? first : Date.parse(first ?? '');
  if (!Number.isFinite(t) || t - since < within * MINUTE) return null;
  const before = markers.filter((m) => CAUSES.includes(m.kind) && m.at <= t && t - m.at <= within * MINUTE);
  const marker = before.at(-1);
  return marker ? { marker, minutes: Math.max(0, Math.round((t - marker.at) / MINUTE)) } : null;
}

/** firstSeenAfter's answer as a sentence: "first seen 17 min after a setting change by Rui Costa". */
export const firstSeenText = (f) => (f ? `first seen ${f.minutes} min after ${markerWords(f.marker)}` : '');

/** A mark whole, for the viewer: { title, text, lines }. */
export function markerDetail(m, now = Date.now()) {
  const ago = relTime(m.at, now);
  const when = `${cellText(new Date(m.at).toISOString(), 'datetime')} (${ago === 'now' ? 'just now' : `${ago} ago`})`;
  const rows = [
    ['what', MARKER_KINDS[m.kind].word],
    ['when', when],
    ...(m.who ? [['who', m.who]] : []),
    ...(m.through ? [['through', m.through]] : []),
    ...(m.commit ? [['commit', m.commit]] : []),
    ...(m.id ? [['id', m.id]] : []),
    ...(m.where ? [['resource', m.where]] : []),
    ['from', m.source],
  ];
  const title = `${MARKER_KINDS[m.kind].letter} ${m.title}`;
  return {
    title,
    text: [m.title, '', ...rows.map(([k, v]) => `${k.padEnd(9)}${v}`)].join('\n'),
    lines: [[{ text: m.title, bold: true }], [], ...rows.map(([k, v]) => [{ text: k.padEnd(9), color: theme.dim }, { text: v, color: k === 'commit' ? theme.accent : undefined }])],
  };
}

/**
 * Where marks go between a result's rows (newest first or oldest first) by `column`, the index of a
 * time: the row nearest after each mark in time gets it, by index: { [row]: [marks] }.
 */
export function rowMarkers(markers, rows, column) {
  const times = rows.map((r) => Date.parse(r[column] ?? ''));
  if (!markers.length || times.length < 2 || times.some((t) => !Number.isFinite(t))) return {};
  const out = {};
  for (const m of markers) {
    // The first row, in time, at or after the mark: and only when a row came before it, so it's between rows.
    let best = -1;
    for (let i = 0; i < times.length; i++) if (times[i] >= m.at && (best < 0 || times[i] < times[best])) best = i;
    if (best < 0 || !times.some((t) => t < m.at)) continue;
    (out[best] ??= []).push(m);
  }
  return out;
}
