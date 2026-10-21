// The Settings tab's rows and what each change saves, as pure functions (ui/SettingsView.jsx
// draws them). Projects, repos, merge defaults and the check interval are Keel's settings, shared
// with the web app through the data folder; organizations are orgs.json; the update setting goes in
// the .env file this computer's Keel reads.

export const MERGE_STRATEGIES = ['squash', 'noFastForward', 'rebase', 'rebaseMerge'];
export const MERGE_LABEL = { squash: 'Squash commit', noFastForward: 'Merge (no fast-forward)', rebase: 'Rebase and fast-forward', rebaseMerge: 'Semi-linear merge' };
export const UPDATE_MODES = ['install', 'tell', 'off'];
export const UPDATE_LABEL = { install: 'Install new versions by itself', tell: 'Only say a new version is out', off: "Don't check" };
const REFRESH_STEP = 15;

/** How the downloaded app treats new versions, from KEEL_CHECK_UPDATES and KEEL_AUTO_UPDATE. */
export function updateMode(env = process.env) {
  const off = (name) => /^(0|false|no|off)$/i.test(env[name] || '');
  return off('KEEL_CHECK_UPDATES') ? 'off' : off('KEEL_AUTO_UPDATE') ? 'tell' : 'install';
}

/** Whether the mouse is on: it is unless KEEL_MOUSE turns it off. */
export const mouseOn = (env = process.env) => !/^(0|false|no|off)$/i.test(env.KEEL_MOUSE || '');

/** The .env lines for an update mode (both keys, so an earlier choice never lingers). */
export const updateLines = (mode) => [`KEEL_CHECK_UPDATES=${mode === 'off' ? 0 : 1}`, `KEEL_AUTO_UPDATE=${mode === 'install' ? 1 : 0}`];

/** The next of `list` after `value`, round. */
export const cycle = (list, value) => list[(list.indexOf(value) + 1) % list.length];

// The web app's "When to flag things", in its order: [key, what it does, unit, most it goes to].
export const THRESHOLDS = [
  ['myReviewHours', 'Escalate a review waiting on me after', 'hours', 168],
  ['prNoReviewHours', 'Flag a PR with no approvals after', 'hours', 336],
  ['stalePrDays', 'Call a PR stale after', 'days', 90],
  ['itemStuckDays', 'Flag an in-progress item with no updates after', 'days', 90],
  ['buildLookbackDays', 'Judge pipeline health over the last', 'days', 90],
  ['maxInProgressPerPerson', 'Flag a person with more items in progress than', 'items', 50],
  ['maxPendingReviewsPerPerson', 'Flag a person owing more reviews than', 'reviews', 50],
];

/** A threshold one step up or down: one at a time, from 1 to its most. */
export const stepThreshold = (value, dir, max) => Math.min(max, Math.max(1, (Number(value) || 1) + dir));

/** The check interval one step up or down, within what the settings allow (15 to 600 seconds). */
export const stepRefresh = (seconds, dir) => Math.min(600, Math.max(15, (Math.round((Number(seconds) || 60) / REFRESH_STEP) + dir) * REFRESH_STEP));

const entryOf = (settings, p) => ({ name: p.name, repos: 'all', scopeToTeamArea: false, ...settings.projects?.[p.id] });

/** Settings' projects with `p` tracked or not. Its repo choice and teams stay as they were. */
export function withTracked(settings, p, tracked) {
  return { ...settings.projects, [p.id]: { ...entryOf(settings, p), tracked } };
}

/** Settings' projects with one repo of `p` in or out. Every repo picked again is "all repos". */
export function withRepo(settings, p, allRepoIds, repoId, on) {
  const cfg = entryOf(settings, p);
  const now = Array.isArray(cfg.repos) ? cfg.repos : allRepoIds;
  const next = on ? [...new Set([...now, repoId])] : now.filter((id) => id !== repoId);
  const all = allRepoIds.every((id) => next.includes(id));
  return { ...settings.projects, [p.id]: { ...cfg, repos: all ? 'all' : next } };
}

/** Settings' projects with `p` on all its repos, or on a list of them to pick from (all ticked to start). */
export function withAllRepos(settings, p, allRepoIds, all) {
  return { ...settings.projects, [p.id]: { ...entryOf(settings, p), repos: all ? 'all' : [...allRepoIds] } };
}

/** "all repos (12)", "3 of 12 repos", or the count alone before the repos are known. */
export function repoSummary(cfg, total) {
  if (!Array.isArray(cfg?.repos)) return total != null ? `all repos (${total})` : 'all repos';
  return total != null ? `${cfg.repos.length} of ${total} repos` : `${cfg.repos.length} repo${cfg.repos.length === 1 ? '' : 's'}`;
}

/**
 * Every row of the tab, top to bottom. `options` holds each opened project's repos
 * ({ repos } or { error }, or 'loading'); `open` the projects opened with ↵. Projects are
 * tracked ones first, then the rest, both by name, narrowed by `filter`. `pinned` (the projects
 * tracked when Settings opened) decides "first" instead, so rows don't move under the cursor.
 */
export function settingsRows({ view, orgs = [], options = {}, open = new Set(), filter = '', local = {}, pinned = null }) {
  const rows = [];
  // Each header starts a section (settingsSections); every row after it belongs to that section.
  let section = null;
  const header = (id, short, label) => {
    section = id;
    rows.push({ kind: 'header', section, short, label });
  };
  const add = (row) => rows.push({ section, ...row });
  if (!view) return rows;
  const { settings, projects } = view;
  const several = orgs.length > 1;
  const orgName = (key) => orgs.find((o) => o.key === key)?.name || key;
  const q = filter.trim().toLowerCase();
  const label = (p) => (several && p.org ? `${orgName(p.org)} · ${p.name}` : p.name);
  const tracked = (p) => !!settings.projects?.[p.id]?.tracked;
  const first = (p) => (pinned ? pinned.has(p.id) : tracked(p));
  const shown = projects
    .filter((p) => !q || label(p).toLowerCase().includes(q))
    .sort((a, b) => first(b) - first(a) || label(a).localeCompare(label(b)));

  header('projects', 'Projects', `Projects and repositories · ${projects.filter(tracked).length} tracked`);
  if (!shown.length) add({ kind: 'note', text: q ? `No project matches "${filter}". /find with nothing clears it.` : 'No projects to track.' });
  for (const p of shown) {
    const cfg = settings.projects?.[p.id];
    const opt = options[p.id];
    const repos = opt && opt !== 'loading' && !opt.error ? opt.repos : null;
    const isOpen = tracked(p) && open.has(p.id);
    add({ kind: 'project', project: p, label: label(p), tracked: tracked(p), open: isOpen, summary: tracked(p) ? repoSummary(cfg, repos?.length) : p.description || '' });
    if (!isOpen) continue;
    if (opt === 'loading' || !opt) add({ kind: 'note', text: '    Reading its repositories…' });
    else if (opt.error) add({ kind: 'note', text: `    Couldn't read its repositories: ${opt.error}`, error: true });
    else {
      const all = !Array.isArray(cfg?.repos);
      add({ kind: 'allRepos', project: p, on: all, count: repos.length });
      for (const r of repos) add({ kind: 'repo', project: p, repo: r, on: all || cfg.repos.includes(r.id), allRepoIds: repos.map((x) => x.id) });
    }
  }

  header('flags', 'When to flag things', 'When to flag things');
  for (const [key, label, unit, max] of THRESHOLDS) add({ kind: 'threshold', key, label, unit, max, value: settings.thresholds?.[key] ?? 1 });
  add({ kind: 'info', label: 'Blocked tag', text: `${settings.blockedTag || 'Blocked'} (a work item with this tag or state is blocked; set on the web)` });
  add({ kind: 'refresh', seconds: settings.refreshSeconds || 60 });

  header('prs', 'Merging', 'Merging pull requests');
  const ac = settings.autoComplete || {};
  add({ kind: 'merge', value: ac.mergeStrategy || 'squash' });
  add({ kind: 'deleteBranch', on: !!ac.deleteSourceBranch });
  add({ kind: 'transitionWorkItems', on: !!ac.transitionWorkItems });

  header('orgs', 'Organizations', `Organizations · ${orgs.length}`);
  for (const o of orgs) add({ kind: 'org', org: o });
  add({ kind: 'addOrg' });

  header('computer', 'This computer', 'This computer');
  add({ kind: 'info', label: 'Settings file', text: local.envFile || '' });
  add({ kind: 'info', label: 'Signed in with', text: signInText(local) });
  add({ kind: 'mouse', on: mouseOn(local.env), available: !!local.mouseAvailable, why: local.mouseAvailable ? '' : "this terminal can't report it (on Windows it needs Node 22.17 or later, or the downloaded app)" });
  if (local.compiled) add({ kind: 'updates', mode: updateMode(local.env) });
  else add({ kind: 'info', label: 'Updates', text: 'from a checkout: git pull' });
  return rows;
}

/** The rows by section, as Settings shows them: `{ id, short, label, rows }`, each without its header. */
export function settingsSections(rows) {
  return rows.filter((r) => r.kind === 'header').map((h) => ({ id: h.section, short: h.short, label: h.label, rows: rows.filter((r) => r.section === h.section && r.kind !== 'header') }));
}

/** How this computer's Keel signs in, for the "Signed in with" row. */
function signInText(local) {
  if (local.signIn === 'keel') return `your Keel account${local.account?.email ? ` (${local.account.email})` : ''} at ${local.server} · /logout signs out`;
  return local.signIn === 'demo' ? 'the demo organization (no sign-in)' : local.signIn === 'pat' ? 'a personal access token (AZDO_PAT)' : 'your Azure CLI sign-in (az login)';
}

/** Whether a row can be selected (headers, notes and plain information can't). */
export const selectable = (row) => row && !['header', 'note'].includes(row.kind);
