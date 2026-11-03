// Syncing a folder of this machine with a server's (/sync, /watch): what each side has (size and
// modification time, a sha256 when asked), what changed since the last sync, and the plan that makes
// them match. Pure but for `walkTree` (which lists through the side's own object) and the last sync's
// state, kept in Mooring's folder per host and pair of folders so "both changed" can be told.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './config.js';

/** Never synced, whatever .mooringignore says. */
export const DEFAULT_IGNORE = ['.git', 'node_modules'];
/** The file in the local folder whose lines name more to leave alone, as .gitignore's do (without negation). */
export const IGNORE_FILE = '.mooringignore';

// Two copies whose times are this close are the same time: SFTP keeps seconds, some disks two.
const SLACK_MS = 2000;

/** The patterns of a .mooringignore's text, after the defaults: comments, blanks and `!` lines left out. */
export function ignoreList(text = '') {
  const own = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
  return [...DEFAULT_IGNORE, ...own];
}

const globRe = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\0/g, '.*')}$`);

/**
 * Whether `rel` (a path inside the folder, with `/`) is left alone: a pattern without a slash matches
 * any one name on the way (`node_modules`, `*.log`), one with a slash the path from the folder's top
 * (`dist/cache`, `/build`) and everything under it. A trailing `/` is dropped: folders and files alike.
 */
export function isIgnored(patterns, rel) {
  const parts = rel.split('/');
  for (const raw of patterns) {
    const p = raw.replace(/\/+$/, '');
    if (!p) continue;
    if (p.includes('/')) {
      const re = globRe(p.replace(/^\//, ''));
      for (let i = 1; i <= parts.length; i++) if (re.test(parts.slice(0, i).join('/'))) return true;
    } else {
      const re = globRe(p);
      if (parts.some((name) => re.test(name))) return true;
    }
  }
  return false;
}

/**
 * Every file under `root` through `side` ({ list(dir), join(dir, name) }: a session or a local), as a
 * Map from its path inside `root` (with `/`) to { size, modified }; folders in `dirs`. Ignored paths are
 * not gone into; links and special files are skipped, never followed, as a copy skips them.
 */
export async function walkTree(side, root, patterns, { signal } = {}) {
  const files = new Map();
  const dirs = new Set();
  const visit = async (dir, rel) => {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    for (const e of await side.list(dir)) {
      const sub = rel ? `${rel}/${e.name}` : e.name;
      if (isIgnored(patterns, sub)) continue;
      if (e.kind === 'dir') {
        dirs.add(sub);
        await visit(side.join(dir, e.name), sub);
      } else if (e.kind === 'file') files.set(sub, { size: e.size, modified: e.modified ?? null });
    }
  };
  await visit(root, '');
  return { files, dirs };
}

/** Whether two copies differ by what a listing says: the size, or the time by more than the slack. */
export function differs(a, b) {
  if (a.size !== b.size) return true;
  return a.modified != null && b.modified != null && Math.abs(a.modified - b.modified) >= SLACK_MS;
}

/** The files a checksum could show to be the same: on both sides, the same size, different times. */
export const checksumCandidates = (local, remote) => [...local.keys()].filter((rel) => remote.has(rel) && local.get(rel).size === remote.get(rel).size && differs(local.get(rel), remote.get(rel)));

/** `sha256sum` run over `rels` in `root`, as one command line for the server. */
export const checksumCommand = (root, rels, quote) => `cd ${quote(root)} && sha256sum -- ${rels.map(quote).join(' ')}`;

/** sha256sum's output as a Map from path to hash (a `\` first marks a name it had to escape: those are left out). */
export function parseChecksums(text) {
  const out = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.replace(/\r$/, ''));
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/**
 * The plan: [{ rel, action, why, size }] in path order, `action` one of upload, download,
 * delete-local, delete-remote, conflict, or extra (only on one side, and kept: deleting needs
 * `deletes`). `direction` up makes the server like this machine, down this machine like the server,
 * both carries each side's changes to the other: with the last sync's `base` (Map rel → { size,
 * modified }) a file changed on both sides is a conflict and a file gone from one side was deleted
 * there; without one the newer copy wins, and copies of the same time but not the same size conflict.
 * `same` holds paths a checksum showed to be the same.
 */
export function planSync({ local, remote, base = null, direction = 'both', deletes = false, same = new Set() }) {
  const plan = [];
  const add = (rel, action, why, size) => plan.push({ rel, action, why, size: size ?? null });
  const extra = (rel, side, size) => add(rel, deletes ? `delete-${side}` : 'extra', side === 'local' ? 'only on this machine' : 'only on the server', size);
  for (const rel of [...new Set([...local.keys(), ...remote.keys()])].sort()) {
    const L = local.get(rel);
    const R = remote.get(rel);
    const B = base?.get(rel);
    if (L && R) {
      if (!differs(L, R) || same.has(rel)) continue;
      if (direction === 'up') add(rel, 'upload', 'changed', L.size);
      else if (direction === 'down') add(rel, 'download', 'changed', R.size);
      else if (B) {
        const [cl, cr] = [differs(L, B), differs(R, B)];
        if (cl && cr) add(rel, 'conflict', 'changed on both sides', L.size);
        else if (cr) add(rel, 'download', 'changed on the server', R.size);
        else add(rel, 'upload', 'changed here', L.size);
      } else if (L.modified != null && R.modified != null && Math.abs(L.modified - R.modified) >= SLACK_MS) {
        L.modified > R.modified ? add(rel, 'upload', 'newer here', L.size) : add(rel, 'download', 'newer on the server', R.size);
      } else add(rel, 'conflict', 'not the same, and neither is newer', L.size);
    } else if (L) {
      if (direction === 'up') add(rel, 'upload', 'new', L.size);
      else if (direction === 'down') extra(rel, 'local', L.size);
      else if (B && !differs(L, B)) deletes ? add(rel, 'delete-local', 'deleted on the server', L.size) : add(rel, 'extra', 'deleted on the server', L.size);
      else add(rel, 'upload', 'new', L.size);
    } else {
      if (direction === 'down') add(rel, 'download', 'new', R.size);
      else if (direction === 'up') extra(rel, 'remote', R.size);
      else if (B && !differs(R, B)) deletes ? add(rel, 'delete-remote', 'deleted here', R.size) : add(rel, 'extra', 'deleted here', R.size);
      else add(rel, 'download', 'new', R.size);
    }
  }
  return plan;
}

/** How many of each action a plan has: { upload, download, 'delete-local', 'delete-remote', conflict, extra }. */
export function planCounts(plan) {
  const n = { upload: 0, download: 0, 'delete-local': 0, 'delete-remote': 0, conflict: 0, extra: 0 };
  for (const p of plan) n[p.action]++;
  return n;
}

/** The folders a path's parents are, shallow first ("a/b/c.txt" → ["a", "a/b"]). */
export function parentsOf(rels) {
  const out = new Set();
  for (const rel of rels) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/'));
  }
  return [...out].sort((x, y) => x.split('/').length - y.split('/').length || x.localeCompare(y));
}

// The last sync's state, per host and pair of folders: what each synced file was, so a later sync can
// tell which side changed it. Only sizes and times: nothing of a file's contents.
const stateFile = () => join(configDir(), 'sync.json');
export const pairKey = (host, localRoot, remoteRoot) => `${host}\n${localRoot}\n${remoteRoot}`;

function readAllState() {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** The last sync's Map for this pair of folders, or null when they've never been synced. */
export function loadBase(key) {
  const entry = readAllState()[key];
  return entry ? new Map(Object.entries(entry.files ?? {})) : null;
}

/** Keeps `files` (Map rel → { size, modified }) as this pair's last sync. */
export function saveBase(key, files, now = Date.now()) {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ ...readAllState(), [key]: { at: now, files: Object.fromEntries(files) } }));
  } catch {
    // A read-only home folder: the next sync just can't tell which side changed.
  }
}
