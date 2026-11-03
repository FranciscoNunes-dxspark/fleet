// Every build Ballast has read, kept as a summary (compare.js's) per project and commit, so a build can
// be compared with the last one, or with main's: <home>/runs/<project>-<hash>.json, the newest
// first, a commit's newest summary only. `home` is Ballast's folder (BALLAST_HOME for tests).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const KEEP_RUNS = 100;

/** The file a project's runs are kept in: its folder's name, and a hash of its whole path to tell two apart. */
export function runsFile(home, root) {
  const abs = resolve(root);
  const id = createHash('sha1').update(process.platform === 'win32' ? abs.toLowerCase() : abs).digest('hex').slice(0, 10);
  const name = (basename(abs) || 'project').replace(/[^\w.-]+/g, '_');
  return join(home, 'runs', `${name}-${id}.json`);
}

/** The project's summaries, newest first; [] when there are none (or the file can't be read). */
export function loadRuns(home, root) {
  try {
    const list = JSON.parse(readFileSync(runsFile(home, root), 'utf8')).runs;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Keeps `summary` first, in place of an earlier one with the same key; returns the list. */
export function saveRun(home, root, summary) {
  const runs = [summary, ...loadRuns(home, root).filter((r) => r.key !== summary.key)].slice(0, KEEP_RUNS);
  try {
    mkdirSync(join(home, 'runs'), { recursive: true });
    writeFileSync(runsFile(home, root), `${JSON.stringify({ project: resolve(root), runs }, null, 1)}\n`);
  } catch {
    // A read-only home: comparisons just won't have this one next time.
  }
  return runs;
}

/** The newest run that isn't `key` (this build's): what "the last build" means. */
export const lastRun = (runs, key) => runs.find((r) => r.key !== key) ?? null;

/** The newest run at `commit` (a full hash, or the start of one), a clean one before one with changes. */
export function runAt(runs, commit) {
  if (!commit) return null;
  const at = runs.filter((r) => r.commit && (r.commit.startsWith(commit) || commit.startsWith(r.commit)));
  return at.find((r) => !r.dirty) ?? at[0] ?? null;
}
