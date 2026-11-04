// `pilot changes`: what git says changed, and the pages each change reaches, so whoever reviews or
// tests a UI change knows which screens to open. Changed views, partials, layouts, scripts and
// stylesheets reach pages through the graph (dependents); a changed controller reaches its actions.
import { execFileSync } from 'node:child_process';
import { actionLabel, urlOf } from './queries.js';

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const STATUS = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'changed', U: 'conflicted', '?': 'untracked' };

/**
 * The files changed under `root`, relative to it: uncommitted ones against HEAD and untracked ones,
 * and with `base` (a branch, tag or commit) also everything committed since the branch left it.
 * [{ file, status }]. `run` stands in for execFileSync in tests.
 */
export function gitChanges(root, { base = null, run = execFileSync } = {}) {
  const git = (...args) => run('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  let prefix;
  try {
    prefix = git('rev-parse', '--show-prefix').trim();
  } catch {
    throw Object.assign(new Error(`${root} isn't in a git repository.`), { usage: true });
  }
  const out = new Map();
  const add = (path, status) => {
    if (!path.startsWith(prefix)) return;
    const rel = path.slice(prefix.length);
    if (rel && !out.has(rel)) out.set(rel, status);
  };
  const nameStatus = (text) => {
    for (const line of text.split('\n').filter(Boolean)) {
      const [code, a, b] = line.split('\t');
      add(b ?? a, STATUS[code[0]] ?? code);
    }
  };
  let head = true;
  try {
    git('rev-parse', '--verify', 'HEAD');
  } catch {
    head = false;
  }
  if (base) {
    try {
      nameStatus(git('diff', '--name-status', '-M', `${base}...HEAD`));
    } catch {
      throw Object.assign(new Error(`git doesn't know "${base}": give a branch, tag or commit.`), { usage: true });
    }
  }
  if (head) nameStatus(git('diff', '--name-status', '-M', 'HEAD'));
  for (const f of git('ls-files', '--others', '--exclude-standard', '--full-name').split('\n').filter(Boolean)) add(f, 'untracked');
  return [...out].map(([file, status]) => ({ file, status }));
}

/** The pages (actions) a changed file reaches, and how many views lie between. */
export function pagesReached(idx, rel) {
  const f = idx.files.get(rel);
  const actions = new Set();
  if (f?.kind === 'cs') {
    // A controller's own actions are its pages; a view component's class reaches through its views.
    for (const c of idx.controllers.values()) if (c.file === rel) for (const a of c.actions) actions.add(idx.actionId(c, a.name));
  }
  const deps = idx.dependents(rel);
  for (const d of deps) if (idx.nodes.get(d.id)?.kind === 'action') actions.add(d.id);
  const pages = [...actions].filter((id) => {
    const n = idx.nodes.get(id);
    return n && !n.action.childOnly && !n.controller.api;
  });
  return { pages, views: deps.filter((d) => idx.files.get(d.id)?.kind === 'view').length };
}

/** `pilot changes`: changed files → the pages to check. `files` replaces asking git (tests, MCP). */
export function changes(idx, { base = null, files = null, run } = {}) {
  const changed = files ? files.map((f) => (typeof f === 'string' ? { file: f, status: 'modified' } : f)) : gitChanges(idx.root, { base, run });
  const rows = [];
  const byPage = new Map();
  for (const c of changed) {
    const f = idx.file(c.file);
    if (!f) {
      rows.push({ ...c, kind: null, pages: [], views: 0, note: c.status === 'deleted' ? 'deleted: anything that used it is in problems' : 'not a file Pilot reads' });
      continue;
    }
    const { pages, views } = pagesReached(idx, f.rel);
    rows.push({ ...c, file: f.rel, kind: f.kind, pages, views });
    for (const p of pages) {
      if (!byPage.has(p)) byPage.set(p, []);
      byPage.get(p).push(f.rel);
    }
  }
  const pages = [...byPage]
    .map(([id, because]) => ({ action: id, url: urlOf(idx, id), label: actionLabel(idx, id), because }))
    .sort((a, b) => b.because.length - a.because.length || a.url.localeCompare(b.url));
  const read = rows.filter((r) => r.kind);
  const lines = [`${plural(changed.length, 'changed file')}${base ? ` since ${base}` : ''} (${read.length} Pilot reads) reach ${plural(pages.length, 'page')}.`];
  if (pages.length) lines.push('', 'Pages to check (most changes first):', ...pages.slice(0, 80).map((p) => `  ${(p.url ?? '').padEnd(30)} ${p.label}  ← ${p.because.slice(0, 3).join(', ')}${p.because.length > 3 ? ` +${p.because.length - 3}` : ''}`));
  if (pages.length > 80) lines.push(`  … ${pages.length - 80} more`);
  lines.push('', 'Changed files:');
  for (const r of rows) lines.push(`  ${r.status.padEnd(10)} ${r.file}${r.kind ? `  → ${plural(r.pages.length, 'page')}, ${plural(r.views, 'view')}` : `  (${r.note})`}`);
  const broad = read.filter((r) => r.pages.length >= 20);
  if (broad.length) lines.push('', `Shared files reaching many pages: ${broad.map((r) => `${r.file} (${r.pages.length})`).join(', ')}. Check a few pages of each kind, not all.`);
  return { data: { base, files: rows, pages }, text: lines.join('\n') };
}
