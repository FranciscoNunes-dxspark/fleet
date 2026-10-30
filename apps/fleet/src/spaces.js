// The seven spaces: one per app of the family, in the order of their keys (ctrl+] 1 to 7), each with the
// letter that also switches to it and the accent its own theme.js comes with (the bar marks the
// active tab in it). Sonar's letter is o: s is Splice's; Mooring's is u, as m asks for a folder.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPACES = [
  { id: 'splice', title: 'Splice', letter: 's', accent: '#5fd787' },
  { id: 'trawl', title: 'Trawl', letter: 't', accent: '#5fafff' },
  { id: 'sonar', title: 'Sonar', letter: 'o', accent: '#b48cff' },
  { id: 'bosun', title: 'Bosun', letter: 'b', accent: '#ff6b6b' },
  { id: 'hail', title: 'Hail', letter: 'h', accent: '#e8445a' },
  { id: 'locker', title: 'Locker', letter: 'l', accent: '#d9a441' },
  { id: 'mooring', title: 'Mooring', letter: 'u', accent: '#f78fb3' },
];

export const IDS = SPACES.map((s) => s.id);

/** The space `name` names: its id, title or letter, any case; undefined when none. */
export function spaceNamed(name) {
  const n = String(name ?? '').toLowerCase();
  return SPACES.find((s) => s.id === n || s.letter === n);
}

// The app that opens a file, by its extension: what `fleet query.sql` and the file association use.
const FILE_APPS = { '.sql': 'trawl', '.http': 'hail' };

export function spaceForFile(file) {
  const dot = String(file ?? '').lastIndexOf('.');
  return dot < 0 ? undefined : spaceNamed(FILE_APPS[file.slice(dot).toLowerCase()]);
}

// Each app's entry point in the checkout, relative to apps/: what its own `npm start` runs.
const ENTRIES = { splice: 'splice/bin/splice.js', trawl: 'trawl/bin/trawl.js', sonar: 'sonar/bin/sonar.js', bosun: 'bosun/bin/bosun.js', hail: 'hail/bin/hail.js', keel: 'keel/bin/keel.js', wharf: 'wharf/bin/wharf.js', locker: 'locker/bin/locker.js', mooring: 'mooring/bin/mooring.js' };

/** apps/ in the checkout this file is in. */
export const APPS_DIR = fileURLToPath(new URL('../../', import.meta.url));

/**
 * How to start app `id` with `args`: [file, args]. The compiled build is every app in one executable,
 * so it starts itself with the hidden `--run <app>` (src/main.js); a checkout starts the app's own
 * entry point with this Node, as its `npm start` does.
 */
export function launchCommand(id, args = [], { compiled, execPath = process.execPath, appsDir = APPS_DIR } = {}) {
  if (!ENTRIES[id]) throw new Error(`There's no app called ${id}.`);
  return compiled ? [execPath, ['--run', id, ...args]] : [execPath, [join(appsDir, ENTRIES[id]), ...args]];
}
