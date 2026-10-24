// Which project Bosun runs: where it starts, where /move goes, and the ones it remembers. Pure apart
// from looking at folders.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { COMPOSE_FILES } from './crew.js';

/** How many projects the config remembers, newest first. */
export const KEEP = 8;

const isFolder = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Whether `dir` has something Bosun can run: a bosun.json, a Procfile, a compose file or a package.json (whose dev script it reads). */
export const hasCrew = (dir) => ['bosun.json', 'Procfile', ...COMPOSE_FILES, 'package.json'].some((f) => existsSync(join(dir, f)));

/** Paths compared as the OS does: without case on Windows. */
export const samePath = (a, b, win = process.platform === 'win32') => (win ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/**
 * Where Bosun starts: the folder it was given; else the one it's in, when that has a crew; else the
 * last project it ran (opened from somewhere with nothing to run, such as a launcher's folder); else
 * the one it's in, to say there's nothing there.
 */
export function startFolder(given, cwd, recent = []) {
  if (given) return resolve(cwd, given);
  if (hasCrew(cwd)) return cwd;
  return recent.find((d) => isFolder(d) && hasCrew(d)) ?? cwd;
}

/**
 * The folder `/move <name>` means, from the project in `dir`: a path as given (absolute, or with
 * `..`), else a project beside this one, else a folder inside it. Null when there's no such folder.
 */
export function resolveFolder(dir, name) {
  const n = pathArg(name);
  if (!n) return null;
  const tries = isAbsolute(n) ? [n] : [resolve(dirname(dir), n), resolve(dir, n)];
  return tries.find(isFolder) ?? null;
}

/** The folders beside the project in `dir` (its parent's, without hidden ones), by name. */
export function siblings(dir) {
  const parent = dirname(dir);
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => join(parent, e.name))
      .sort((a, b) => basename(a).localeCompare(basename(b), undefined, { sensitivity: 'base' }));
  } catch {
    return [];
  }
}

/** What /move offers: the projects run lately (that are still there), then the folders beside this one; not this one. */
export function choices(dir, recent = []) {
  const seen = [dir];
  const out = [];
  for (const path of [...recent.filter(isFolder), ...siblings(dir)]) {
    if (seen.some((s) => samePath(s, path))) continue;
    seen.push(path);
    out.push({ path, name: basename(path), crew: hasCrew(path), recent: recent.includes(path) });
  }
  return out;
}

/** `recent` with `dir` first, as many as KEEP. */
export function remember(recent = [], dir) {
  return [dir, ...recent.filter((d) => !samePath(d, dir))].slice(0, KEEP);
}

import { pathArg } from '@fleet/kit/family.js';
export { pathArg };
