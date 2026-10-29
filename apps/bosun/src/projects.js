// Which project Bosun runs: where it starts, where /move goes, and the ones it remembers. The folder
// helpers are the kit's (folders.js, which Locker and Hail use too); what counts as a project is Bosun's.
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COMPOSE_FILES } from './crew.js';
import { KEEP, folderChoices, remember, resolveFolder, samePath, siblings } from '@fleet/kit/folders.js';
import { pathArg } from '@fleet/kit/family.js';

export { KEEP, pathArg, remember, resolveFolder, samePath, siblings };

const isFolder = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Whether `dir` has something Bosun can run: a bosun.json, a Procfile, a compose file or a package.json (whose dev script it reads). */
export const hasCrew = (dir) => ['bosun.json', 'Procfile', ...COMPOSE_FILES, 'package.json'].some((f) => existsSync(join(dir, f)));

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

/** What /move offers: the projects run lately (that are still there), then the folders beside this one; not this one. */
export const choices = (dir, recent = []) => folderChoices(dir, recent, { has: hasCrew }).map(({ has, ...c }) => ({ ...c, crew: has }));
