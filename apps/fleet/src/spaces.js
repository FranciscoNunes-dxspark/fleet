// The spaces: one per app of the family, each with the letter that switches to it and the accent its
// own theme.js comes with (the bar marks the active tab in it). Sonar's letter is o: s is Splice's;
// Mooring's is u, as m asks for a folder; Bilge's is g, as b is Bosun's; Wharf's is d (docker), Keel's
// k and Helm's i (for the ISE it is like); Lantern's j, Drill's v (verify), Ballast's z (gzip) and
// Lookout's y, the letters Fleet's own keys left. Which of them the bar shows is the person's choice
// (host.json's "apps", the prefix and a): the numbers 1 to 9 go to the ones shown, in this order.
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
  { id: 'bilge', title: 'Bilge', letter: 'g', accent: '#9ccc65' },
  { id: 'chart', title: 'Chart', letter: 'c', accent: '#7986cb' },
  { id: 'wharf', title: 'Wharf', letter: 'd', accent: '#3fb8b0' },
  { id: 'keel', title: 'Keel', letter: 'k', accent: '#ff8a65' },
  { id: 'helm', title: 'Helm', letter: 'i', accent: '#4fc3f7' },
  { id: 'lantern', title: 'Lantern', letter: 'j', accent: '#ffb74d' },
  { id: 'drill', title: 'Drill', letter: 'v', accent: '#ff8c42' },
  { id: 'ballast', title: 'Ballast', letter: 'z', accent: '#d4875a' },
  { id: 'lookout', title: 'Lookout', letter: 'y', accent: '#f4a259' },
];

export const IDS = SPACES.map((s) => s.id);

// The accents a team's own tool takes in turn when its entry names none.
const TOOL_ACCENTS = ['#9aa5b8', '#c3a6ff', '#7fd1c7', '#e6c07b', '#f29e9e'];

/**
 * A team's own tools as spaces, from host.json's "spaces":
 *   [{ "id": "deploys", "title": "Deploys", "command": ["node", "/opt/tools/deploys.js"], "accent": "#9aa5b8" }]
 * Each runs as an app does, hosted (docs/hosted-apps.md says what it must do there). Every letter is the
 * family's or Fleet's own, so a tool has none: its number in the bar, a click on its tab and the
 * desktop window's palette reach it. Returns { spaces, problems }, an entry that isn't right said in
 * `problems` and left out.
 */
export function customSpaces(list, taken = IDS) {
  const spaces = [];
  const problems = [];
  const ids = new Set(taken);
  for (const [i, entry] of (Array.isArray(list) ? list : []).entries()) {
    const where = `host.json's spaces[${i}]`;
    const id = String(entry?.id ?? '');
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) {
      problems.push(`${where}: "id" must be a short lower-case name`);
      continue;
    }
    if (ids.has(id)) {
      problems.push(`${where}: there's already a space called ${id}`);
      continue;
    }
    const command = entry.command;
    if (!Array.isArray(command) || !command.length || !command.every((a) => typeof a === 'string' && a)) {
      problems.push(`${where}: "command" must be the program and its arguments, as a list of strings`);
      continue;
    }
    const accent = /^#[0-9a-f]{6}$/i.test(entry.accent ?? '') ? entry.accent : TOOL_ACCENTS[spaces.length % TOOL_ACCENTS.length];
    ids.add(id);
    spaces.push({ id, title: String(entry.title || id).slice(0, 24), letter: null, accent, command, custom: true });
  }
  return { spaces, problems };
}

/** A `command` for launch.js's appSpawner over `spaces`: a tool's own command, else launchCommand's. */
export const spaceCommand = (spaces) => (id, args = [], opts = {}) => {
  const tool = spaces.find((s) => s.id === id && s.command);
  return tool ? [tool.command[0], [...tool.command.slice(1), ...args]] : launchCommand(id, args, opts);
};

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
const ENTRIES = { splice: 'splice/bin/splice.js', trawl: 'trawl/bin/trawl.js', sonar: 'sonar/bin/sonar.js', bosun: 'bosun/bin/bosun.js', hail: 'hail/bin/hail.js', keel: 'keel/bin/keel.js', wharf: 'wharf/bin/wharf.js', locker: 'locker/bin/locker.js', mooring: 'mooring/bin/mooring.js', bilge: 'bilge/bin/bilge.js', chart: 'chart/bin/chart.js', helm: 'helm/bin/helm.js', lantern: 'lantern/bin/lantern.js', drill: 'drill/bin/drill.js', ballast: 'ballast/bin/ballast.js', lookout: 'lookout/bin/lookout.js' };

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
