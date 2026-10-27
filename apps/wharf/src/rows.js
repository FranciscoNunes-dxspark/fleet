// What the lists draw, worked out from the provider's data: pure, so it's tested without the UI.

/** Standalone containers' heading; compose projects are headed by their own name. */
export const STANDALONE = 'Standalone';

const byName = (a, b) => a.name.localeCompare(b.name);

/**
 * The Containers list's rows: a heading per compose project (alphabetical, standalone containers last)
 * and its containers under it, running ones first. `onlyRunning` leaves out the stopped; `query` keeps
 * names, images and projects that contain it. A row is { heading, members } or { c }.
 */
export function containerRows(containers, { onlyRunning = false, query = '' } = {}) {
  const q = query.trim().toLowerCase();
  const groups = new Map();
  for (const c of containers) {
    if (onlyRunning && c.state !== 'running') continue;
    if (q && ![c.name, c.image, c.project ?? ''].some((s) => s.toLowerCase().includes(q))) continue;
    const key = c.project ?? STANDALONE;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const names = [...groups.keys()].sort((a, b) => (a === STANDALONE) - (b === STANDALONE) || a.localeCompare(b));
  const rows = [];
  for (const heading of names) {
    const members = groups.get(heading).sort((a, b) => (b.state === 'running') - (a.state === 'running') || byName(a, b));
    rows.push({ heading, members }, ...members.map((c) => ({ c })));
  }
  return rows;
}

/** The container a name, an id (or its start), or `project/service` points at; null when none or ambiguous. */
export function findContainer(containers, name) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  const exact = containers.filter((c) => c.name === n || c.id === n || (c.project && `${c.project}/${c.service}` === n));
  if (exact.length === 1) return exact[0];
  if (exact.length) return null;
  const starts = containers.filter((c) => c.name.startsWith(n) || c.id.startsWith(n));
  return starts.length === 1 ? starts[0] : null;
}

/** The containers a target means: 'all', a compose project's name, or one container. */
export function targetsOf(containers, target) {
  const t = String(target ?? '').trim();
  if (!t) return [];
  if (t === 'all') return containers;
  const project = containers.filter((c) => c.project === t);
  if (project.length && !containers.some((c) => c.name === t)) return project;
  const one = findContainer(containers, t);
  return one ? [one] : [];
}

/** A state as a row shows it: "running", "exited 1", "unhealthy". */
export function stateLabel(c) {
  if (c.health === 'unhealthy') return 'unhealthy';
  if (c.state === 'exited' && c.exitCode) return `exited ${c.exitCode}`;
  if (c.health === 'starting') return 'starting';
  return c.state;
}

/** The name of the colour (a key of theme) a state is drawn in. */
export function stateTone(c) {
  if (c.health === 'unhealthy' || c.state === 'dead' || (c.state === 'exited' && c.exitCode > 0)) return 'del';
  if (c.state === 'running' && c.health !== 'starting') return 'add';
  if (['restarting', 'paused', 'created', 'removing'].includes(c.state) || c.health === 'starting') return 'warn';
  return 'dim';
}

/** 1536 → "1.5K", 3.4e8 → "324M": a few characters for a column. */
export function shortBytes(n) {
  if (n == null) return '';
  const units = ['B', 'K', 'M', 'G', 'T'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

/** A CPU percentage for a column: "0.3%", "12%", "340%". */
export const shortCpu = (p) => (p == null ? '' : `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`);

/** Whether a log line looks like trouble: an error, exception, fatal or panic (a whole word, not part of one). */
export const isTrouble = (line) => /\b(error|exception|fatal|panic|critical|traceback|failed)\b/i.test(line);

/** The image's name as a row shows it: repo:tag, or its id when it has neither. */
export const imageName = (i) => (i.repo ? `${i.repo}${i.tag ? `:${i.tag}` : ''}` : `<none> ${i.id}`);

/** A log line as the viewer shows it: Docker's long timestamp cut to the time ("09:00:07 …"); other lines as they are. */
export const logLine = (line) => line.replace(/^\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)(?:\.\d+)?Z? /, '$1 ');

/** The name of the colour (a key of theme) a log line is drawn in, or undefined for the text colour. */
export function logTone(line) {
  if (isTrouble(line)) return 'del';
  if (/\b(warn|warning)\b/i.test(line)) return 'warn';
  return undefined;
}

/** The Pods list's rows: a heading per namespace (alphabetical) and its pods under it, the ones that are not well first. */
export function podRows(pods, { query = '' } = {}) {
  const q = query.trim().toLowerCase();
  const groups = new Map();
  for (const p of pods) {
    if (q && ![p.name, p.namespace, p.status].some((s) => s.toLowerCase().includes(q))) continue;
    if (!groups.has(p.namespace)) groups.set(p.namespace, []);
    groups.get(p.namespace).push(p);
  }
  const rows = [];
  for (const heading of [...groups.keys()].sort()) {
    const members = groups.get(heading).sort((a, b) => (podTone(a) === 'del' ? 0 : 1) - (podTone(b) === 'del' ? 0 : 1) || a.name.localeCompare(b.name));
    rows.push({ heading, members }, ...members.map((p) => ({ p })));
  }
  return rows;
}

/** The name of the colour (a key of theme) a pod's status is drawn in. */
export function podTone(p) {
  if (p.status === 'Running') return p.readyCount < p.total ? 'warn' : 'add';
  if (['Succeeded', 'Completed'].includes(p.status)) return 'dim';
  if (['Pending', 'ContainerCreating', 'PodInitializing', 'Terminating', 'Init:0/1'].includes(p.status) || p.status.startsWith('Init:')) return 'warn';
  return 'del';
}

/** The pod a name (or `namespace/name`, or a unique prefix) points at; null when none or ambiguous. */
export function findPod(pods, text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const exact = pods.filter((p) => p.name === t || `${p.namespace}/${p.name}` === t);
  if (exact.length === 1) return exact[0];
  if (exact.length) return null;
  const starts = pods.filter((p) => p.name.startsWith(t));
  return starts.length === 1 ? starts[0] : null;
}
