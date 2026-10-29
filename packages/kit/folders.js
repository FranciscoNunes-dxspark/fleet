// Moving an app to another folder (Bosun's, Locker's and Hail's /move): the folder a name means, the
// folders beside this one, what the picker offers (the ones used lately first) and the list the app's
// config remembers. Pure apart from looking at folders.
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathArg } from './family.js';

/** How many folders an app remembers, newest first. */
export const KEEP = 8;

/** Whether `path` is a folder. */
export const isFolder = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Paths compared as the OS does: without case on Windows. */
export const samePath = (a, b, win = process.platform === 'win32') => (win ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/**
 * The folder `/move <name>` means, from `dir`: a path as given (absolute, or with `..`; `~` is the
 * home folder), else a folder beside this one, else one inside it. Null when there's no such folder.
 */
export function resolveFolder(dir, name, { home = process.env.HOME ?? process.env.USERPROFILE } = {}) {
  let n = pathArg(name);
  if (!n) return null;
  if (home && (n === '~' || /^~[\\/]/.test(n))) n = join(home, n.slice(1));
  const tries = isAbsolute(n) ? [n] : [resolve(dirname(dir), n), resolve(dir, n)];
  return tries.find(isFolder) ?? null;
}

/** The folders beside `dir` (its parent's, without hidden ones), by name. */
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

/**
 * What /move offers: the folders used lately (that are still there), then the ones beside `dir`; not
 * `dir` itself. Each { path, name, recent, has }, `has` what the app's `has(path)` says (that the
 * folder has something for it).
 */
export function folderChoices(dir, recent = [], { has = () => true } = {}) {
  const seen = [dir];
  const out = [];
  for (const path of [...recent.filter(isFolder), ...siblings(dir)]) {
    if (seen.some((s) => samePath(s, path))) continue;
    seen.push(path);
    out.push({ path, name: basename(path), recent: recent.some((r) => samePath(r, path)), has: has(path) });
  }
  return out;
}

/** `recent` with `dir` first, as many as `keep`. */
export function remember(recent = [], dir, keep = KEEP) {
  return [dir, ...(recent ?? []).filter((d) => !samePath(d, dir))].slice(0, keep);
}
