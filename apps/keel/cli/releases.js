// How classic release pipelines read in the terminal (ui/ReleasesView.jsx): each stage's latest
// deployment, what's deploying or waiting for approval now, and the recent releases. Below them, the
// GitHub releases of tracked repos with their files. Pure, so the tests can check it. The data is
// service.releases() and service.repoReleases(), the web app's Releases tab.
import { theme } from './theme.js';
import { relTime } from './text.js';

const ago = (iso, now) => (iso ? relTime(Date.parse(iso), now) : '');

export const STAGE_STATUS = {
  succeeded: { icon: '✓', color: theme.ok, label: 'succeeded' },
  partiallySucceeded: { icon: '◐', color: theme.warn, label: 'partially succeeded' },
  rejected: { icon: '✗', color: theme.del, label: 'rejected' },
  failed: { icon: '✗', color: theme.del, label: 'failed' },
  canceled: { icon: '⊘', color: theme.dim, label: 'canceled' },
  inProgress: { icon: '●', color: theme.accent, label: 'deploying' },
  queued: { icon: '○', color: theme.dim, label: 'queued' },
  scheduled: { icon: '○', color: theme.dim, label: 'scheduled' },
  notStarted: { icon: '·', color: theme.dim, label: 'not deployed' },
};
const NEVER = { icon: '·', color: theme.dim, label: 'never deployed' };
export const stageStatus = (status) => (status ? STAGE_STATUS[status] ?? { icon: '?', color: theme.dim, label: status } : NEVER);

export const RELEASE_HEALTH = {
  failing: { icon: '✗', color: theme.del, label: 'last deployment failed' },
  healthy: { icon: '✓', color: theme.ok, label: 'healthy' },
  unknown: { icon: '?', color: theme.dim, label: 'never deployed' },
};
export const releaseHealth = (d) => RELEASE_HEALTH[d.health] ?? RELEASE_HEALTH.unknown;

/** The approvals (service.approvals) waiting on a stage of this release pipeline. */
export function approvalsFor(def, approvals = []) {
  return approvals.filter((a) => a.kind === 'release' && a.projectId === def.projectId && a.pipeline === def.name && (!def.org || !a.org || a.org === def.org));
}

const matches = (d, text) => {
  const q = text.trim().toLowerCase();
  return !q || [d.name, d.projectName, d.path, ...d.stages.map((s) => s.name), ...d.releases.slice(0, 1).map((r) => r.name)].some((s) => String(s ?? '').toLowerCase().includes(q));
};

const RANK = { failing: 0, healthy: 1, unknown: 2 };

/** Release pipelines: deploying or waiting first, then failing, then by name. */
export function releaseRows(data, filter = '') {
  const busy = (d) => d.stages.some((s) => s.active) || approvalsFor(d, data?.approvals).length > 0;
  return (data?.definitions ?? [])
    .filter((d) => matches(d, filter))
    .sort((x, y) => Number(busy(y)) - Number(busy(x)) || (RANK[x.health] ?? 2) - (RANK[y.health] ?? 2) || x.name.localeCompare(y.name));
}

/** The stages in a row: "QA ✓  Staging ✓  Production ●", each by its latest deployment, or what's deploying now. */
export function stageStrip(def) {
  const segs = [];
  for (const s of [...def.stages].sort((a, b) => a.rank - b.rank)) {
    const st = stageStatus(s.active?.status ?? s.latest?.status);
    segs.push({ text: `${s.name} `, color: theme.dim }, { text: `${st.icon}  `, color: st.color });
  }
  return segs;
}

/** One stage: its latest deployment, then what's deploying now and any approval it waits on. */
function stageLines(s, waiting, now) {
  const st = stageStatus(s.latest?.status);
  const lines = [[
    { text: `  ${st.icon} `, color: st.color },
    { text: s.name, bold: true },
    { text: s.latest ? `  ${s.latest.releaseName} ${st.label} · ${ago(s.latest.at, now)} ago${s.latest.requestedFor?.displayName ? ` · ${s.latest.requestedFor.displayName}` : s.latest.reason === 'automated' ? ' · automatically' : ''}` : '  never deployed', color: theme.dim },
  ]];
  if (s.active) {
    const a = stageStatus(s.active.status);
    lines.push([{ text: '      ' }, { text: `${a.icon} ${s.active.releaseName} ${a.label}`, color: a.color }, { text: ` since ${ago(s.active.at, now)} ago`, color: theme.dim }]);
  }
  for (const a of waiting) {
    lines.push([{ text: '      ' }, { text: `● ${a.run?.name ?? 'A release'} waits for approval`, color: theme.warn }, { text: a.canDecide ? ' · a approves, x rejects' : ` · ${(a.approvers ?? []).map((p) => p.displayName).join(', ') || 'someone else'} decides`, color: theme.dim }]);
    if (a.instructions) lines.push([{ text: '      ' }, { text: `"${a.instructions}"`, color: theme.dim, italic: true }]);
  }
  return lines;
}

/** A recent release: its name, who created it when, and how each stage went. */
function releaseLine(r, now) {
  const segs = [{ text: `  ${r.name} `, bold: true }, { text: `${ago(r.createdOn, now)} ago${r.createdBy?.displayName ? ` · ${r.createdBy.displayName}` : ''}  `, color: theme.dim }];
  for (const s of r.stages) {
    const st = s.waiting ? { icon: '‖', color: theme.warn } : stageStatus(s.status);
    segs.push({ text: `${s.name} `, color: theme.dim }, { text: `${st.icon} `, color: st.color });
  }
  return segs;
}

/** The pane beside the list: the pipeline, its stages and its recent releases. */
export function releaseDetail(def, approvals = [], { now = Date.now(), recent = 8 } = {}) {
  const h = releaseHealth(def);
  const waiting = approvalsFor(def, approvals);
  const artifact = def.artifacts?.find((a) => a.isPrimary) ?? def.artifacts?.[0];
  const lines = [
    [{ text: def.name, bold: true }],
    [{ text: `${def.projectName}${def.path && def.path !== '\\' ? ` · ${def.path.replace(/^\\/, '')}` : ''}${artifact?.sourceName ? ` · from ${artifact.sourceName}` : ''}`, color: theme.dim }],
    '',
    [{ text: `${h.icon} ${h.label}`, color: h.color, bold: true }],
    '',
    [{ text: 'Stages', bold: true }, { text: '  latest deployment', color: theme.dim }],
  ];
  for (const s of [...def.stages].sort((a, b) => a.rank - b.rank)) lines.push(...stageLines(s, waiting.filter((a) => a.stage === s.name), now));
  lines.push('', [{ text: 'Recent releases', bold: true }]);
  if (!def.releases.length) lines.push([{ text: '  None yet: n creates one from the latest artifacts.', color: theme.dim }]);
  for (const r of def.releases.slice(0, recent)) lines.push(releaseLine(r, now));
  return lines;
}

/** Everything about a release pipeline, as plain text for the viewer. */
export function releaseFullText(def, approvals = [], now = Date.now()) {
  const text = (line) => (typeof line === 'string' ? line : line.map((s) => s.text).join(''));
  const out = releaseDetail(def, approvals, { now, recent: def.releases.length }).map(text);
  if (def.webUrl) out.push('', def.webUrl);
  return out.join('\n');
}

/** The releases `stage` can get, newest first, each with how it went there ("Release-58 · deploying"). */
export function deployChoices(def, stage) {
  return def.releases.slice(0, 8).map((r) => {
    const there = r.stages.find((s) => s.definitionEnvironmentId === stage.id);
    const st = there?.waiting ? { label: 'waiting for approval' } : stageStatus(there?.status);
    return { release: r, environmentId: there?.id, label: `${r.name} · ${st.label} there · created ${relTime(Date.parse(r.createdOn))} ago` };
  }).filter((c) => c.environmentId != null);
}

// ---- GitHub releases (service.repoReleases): a row per repo, below the release pipelines.

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** 1536 → "1.5 KB", as the web app shows sizes. */
export function bytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i ? v.toFixed(v < 10 ? 1 : 0) : v} ${units[i]}`;
}

export const isGithubRelease = (row) => row?.kind === 'github';

const githubMatches = (repo, text) => {
  const q = text.trim().toLowerCase();
  return !q || [repo.repoName, repo.projectName, ...repo.releases.flatMap((r) => [r.tag, r.name, ...r.assets.map((a) => a.name)])]
    .some((s) => String(s ?? '').toLowerCase().includes(q));
};

/** Repos with releases, as rows (kind 'github'), the one released most lately first. */
export function githubRows(repos = [], filter = '') {
  const newest = (repo) => Date.parse(repo.releases[0]?.publishedAt ?? '') || 0;
  return repos
    .filter((repo) => repo.releases.length && githubMatches(repo, filter))
    .map((repo) => ({ ...repo, kind: 'github', key: `github:${repo.repoId}`, name: repo.repoName }))
    .sort((x, y) => newest(y) - newest(x) || x.name.localeCompare(y.name));
}

/** The repo's latest release, else its newest. */
const headline = (repo) => repo.releases.find((r) => r.latest) ?? repo.releases[0];
const labels = (r) => [r.latest && 'latest', r.prerelease && 'pre-release', r.draft && 'draft'].filter(Boolean);

/** A repo's row after its name: "v2.4.0 · 4 files · 6d ago", and a newer pre-release or draft after it. */
export function githubStrip(repo, now = Date.now()) {
  const r = headline(repo);
  const segs = [
    { text: `${r.tag} `, bold: true },
    { text: `· ${plural(r.assets.length, 'file')}${r.publishedAt ? ` · ${ago(r.publishedAt, now)} ago` : ''}`, color: theme.dim },
  ];
  const newer = repo.releases.slice(0, repo.releases.indexOf(r));
  if (newer.length) segs.push({ text: `  ${newer[0].tag} ${labels(newer[0]).join(', ')}`, color: theme.warn });
  return segs;
}

/** One release: its name (and tag), labels, when and who, then each file with its size and downloads. */
function githubReleaseLines(r, now, { urls = false } = {}) {
  const lines = [[
    { text: r.name, bold: true },
    { text: r.name.includes(r.tag) ? '' : ` (${r.tag})`, color: theme.dim },
    { text: labels(r).length ? `  ${labels(r).join(', ')}` : '', color: r.latest ? theme.ok : theme.warn },
    { text: `${r.publishedAt ? ` · ${ago(r.publishedAt, now)} ago` : ''}${r.author?.displayName ? ` · ${r.author.displayName}` : ''}`, color: theme.dim },
  ]];
  if (!r.assets.length) lines.push([{ text: '  No files attached', color: theme.dim }]);
  for (const a of r.assets) {
    lines.push([{ text: `  ${a.name}` }, { text: `  ${[bytes(a.size), plural(a.downloads ?? 0, 'download')].filter(Boolean).join(' · ')}`, color: theme.dim }]);
    if (urls && a.url) lines.push([{ text: `    ${a.url}`, color: theme.dim }]);
  }
  return lines;
}

/** The pane beside the list for a GitHub repo: its recent releases, newest first, with their files. */
export function githubDetail(repo, { now = Date.now(), urls = false } = {}) {
  const lines = [
    [{ text: repo.repoName, bold: true }],
    [{ text: `${repo.projectName} · GitHub releases · D downloads a file`, color: theme.dim }],
  ];
  for (const r of repo.releases) lines.push('', ...githubReleaseLines(r, now, { urls }));
  return lines;
}

/** Everything about a repo's releases, with each file's download link, as plain text for the viewer. */
export function githubFullText(repo, now = Date.now()) {
  const text = (line) => (typeof line === 'string' ? line : line.map((s) => s.text).join(''));
  const out = githubDetail(repo, { now, urls: true }).map(text);
  out[1] = `${repo.projectName} · GitHub releases`;
  if (repo.webUrl) out.push('', repo.webUrl);
  return out.join('\n');
}

/**
 * What g can download: the releases with files, newest first ("v2.4.0 · latest · 4 files · 6d ago"),
 * each with its files ("api-2.4.0-linux-x64.tar.gz · 18 MB · 342 downloads"), picked in two steps.
 */
export function downloadChoices(repo, now = Date.now()) {
  return repo.releases
    .map((r) => ({ release: r, files: r.assets.filter((a) => a.url) }))
    .filter((c) => c.files.length)
    .map(({ release: r, files }) => ({
      release: r,
      label: [r.tag, ...labels(r), plural(files.length, 'file'), r.publishedAt ? `${ago(r.publishedAt, now)} ago` : ''].filter(Boolean).join(' · '),
      files: files.map((a) => ({ asset: a, label: [a.name, bytes(a.size), plural(a.downloads ?? 0, 'download')].filter(Boolean).join(' · ') })),
    }));
}
