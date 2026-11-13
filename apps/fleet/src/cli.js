// The host's command line: `fleet [app] [args…]`. First, so the kit knows this process is Fleet.
import './app.js';
import { COMPILED, VERSION } from './app.js';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkForUpdate, checksDisabled, installUpdate, removeOldExecutables } from '@fleet/kit/update.js';
import { keepVtInput } from '@fleet/kit/mouse.js';
import { plainOutput } from '@fleet/kit/glyphs.js';
import { Host, LEAVE } from './host.js';
import { DEFAULT_PREFIX, prefixByte } from './keys.js';
import { appSpawner } from './launch.js';
import { SPACES, customSpaces, spaceCommand, spaceForFile, spaceNamed } from './spaces.js';
import { loadState, saveState } from './state.js';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  console.log(`fleet ${VERSION}`);
  process.exit(0);
}

if (args[0] === '-h' || args[0] === '--help') {
  console.log(`fleet [app] [args…]

The family's apps in one terminal: ${SPACES.map((s) => s.title).join(', ')}.
Each runs as it does by itself, one on screen at a time; the bar at the bottom
shows them all. fleet <app> opens that one (and starts it with args…);
fleet alone opens the one you used last. fleet <file> opens a file in the app
for it: .sql in Trawl, .http in Hail.

  ctrl+b 1-9 or a letter      switch: 1-9 the apps in the bar, the letters any app
                              (s t o b h l u g c d k i j v z y: o is Sonar, u Mooring,
                              g Bilge, d Wharf, k Keel, i Helm, j Lantern, v Drill,
                              z Ballast, y Lookout)
  ctrl+b a                    choose which apps the bar shows (kept in ~/.fleet/host.json)
  ctrl+b ] / n / p            next, previous
  ctrl+b | / tab / x          split in two, the other pane, one again
  ctrl+b m                    move every app to another folder
  ctrl+b r                    runbooks: steps handed to the apps
  ctrl+b R                    record a runbook from what the apps run (again: stop)
  ctrl+b f                    follow a request across the apps
  ctrl+b e                    the project's environment (.fleet/project.json)
  ctrl+b w                    what changed lately, and Claude on why it broke
  ctrl+b P                    Claude's proposals: ↵ types one into its app
  ctrl+b S                    security: every app's check for the project
  ctrl+b ctrl+b               send ctrl+b to the app
  ctrl+b q                    quit, stopping every app
  ctrl+b ?                    the keys

ctrl+] works as ctrl+b does. "prefix": "ctrl+a" in ~/.fleet/host.json (or
FLEET_PREFIX=ctrl+a) makes another key the prefix: ctrl and a letter, or
ctrl+], ctrl+\, ctrl+^, ctrl+_, ctrl+space.

An app starts the first time you switch to it. A line an app copies "for
Trawl" (or any sibling) goes straight to that app's prompt.

fleet mcp [--project <dir>] runs Fleet as an MCP server for Claude Code, which
reads every app's world through it, read-only but for proposing a line for you
to hand to an app (claude mcp add fleet -- fleet mcp).

fleet security [folder] [--only bilge,splice] [--json] [--sarif [file]] [--fail-on level]
runs every app's security check for the project as one overview, without the screen.`);
  process.exit(0);
}

let named = args[0] && !args[0].startsWith('-') ? spaceNamed(args[0]) : undefined;
// fleet <file>: the app that opens that kind of file, given its path (what Explorer's "Open with" runs).
let appArgs = args.slice(1);
if (args[0] && !args[0].startsWith('-') && !named && existsSync(args[0]) && statSync(args[0]).isFile()) {
  named = spaceForFile(args[0]);
  appArgs = [resolve(args[0]), ...args.slice(1)];
}
if (args[0] && !args[0].startsWith('-') && !named) {
  console.error(`fleet: there's no app called ${args[0]}; the apps are ${SPACES.map((s) => s.id).join(', ')}.`);
  process.exit(1);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('fleet needs an interactive terminal.');
  process.exit(1);
}

const state = loadState();
// The prefix: FLEET_PREFIX, else host.json's "prefix", else ctrl+b (one Fleet can't use is said, and ctrl+b taken).
const prefixWanted = process.env.FLEET_PREFIX || state.prefix;
const prefix = prefixByte(prefixWanted ?? DEFAULT_PREFIX) ?? prefixByte(DEFAULT_PREFIX);
// A team's own tools, as tabs beside the family's (host.json's "spaces"); an entry that isn't right is said.
const tools = customSpaces(state.spaces);
for (const problem of tools.problems) console.error(`fleet: ${problem}`);
const spaces = [...SPACES, ...tools.spaces];
const first = named ?? spaceNamed(state.last) ?? spaces.find((s) => s.id === state.last) ?? SPACES[0];
const depth = process.stdout.getColorDepth?.() ?? 24;

// Windows only sends the mouse as text in VT input mode, which Node sets with raw mode and the Bun
// build through its FFI (the kit's mouse.js); the host passes the reports on to the app.
if (process.platform === 'win32' && typeof Bun !== 'undefined') await keepVtInput(process.stdin).catch(() => {});
process.stdin.setRawMode(true);
process.stdin.resume();
// In Windows' own console, the characters its font lacks are swapped for ones it has, the apps' too.
plainOutput(process.stdout);

const host = new Host({
  input: process.stdin,
  output: process.stdout,
  spaces,
  spawn: appSpawner({ compiled: COMPILED, depth, command: spaceCommand(spaces) }),
  args: named ? { [named.id]: appArgs } : {},
  truecolor: depth >= 24,
  // The bell when a tab gets a badge: FLEET_NO_BELL=1, or "bell": false in host.json, keeps it quiet.
  bell: process.env.FLEET_NO_BELL !== '1' && state.bell !== false,
  onSwitch: (id) => saveState({ last: id }),
  prefix,
  // The folders moved to lately, for the move's list (newest first).
  folders: Array.isArray(state.folders) ? state.folders.filter((f) => typeof f === 'string') : [],
  onFolders: (folders) => saveState({ folders }),
  // The apps the bar shows (the prefix and a), every one until a choice is made.
  chosen: Array.isArray(state.apps) ? state.apps : null,
  onChosen: (apps) => saveState({ apps }),
  // The desktop window's settings: the bell, and the prefix from the next start.
  onSettings: (settings) => saveState(settings),
  onUpdate: () => updateFleet(true),
  // Fleet's desktop window (desktop/) sets this: it draws the bar itself, from the state the host sends.
  desktop: process.env.FLEET_DESKTOP === '1',
  // A window that doesn't say FLEET_DESKTOP_ROWS=all is from before the apps drew every row, and its
  // terminal has a hidden row at the bottom (an installed Fleet updates itself before its window does).
  hiddenRow: process.env.FLEET_DESKTOP === '1' && process.env.FLEET_DESKTOP_ROWS !== 'all',
});

// However the host ends, the apps end with it and the terminal is given back.
let left = false;
const leave = () => {
  if (left) return;
  left = true;
  host.killAll();
  try {
    process.stdout.write(LEAVE);
    process.stdin.setRawMode(false);
  } catch {
    // The terminal has gone.
  }
};
process.on('exit', leave);
process.on('SIGTERM', () => host.quit().then(() => process.exit(0)));
process.on('SIGHUP', () => process.exit(0));
process.on('uncaughtException', (e) => {
  leave();
  console.error(e?.stack ?? e);
  process.exit(1);
});

// Only the downloaded executable updates itself, as one: the apps inside it don't (hosted mode). At
// start it's the daily check; an app's /update asks for one now (`asked`), whatever the last one said.
let updating = false;
async function updateFleet(asked) {
  if (!COMPILED) return asked && host.notice(`This Fleet (${VERSION}) runs from a checkout: git pull updates it`);
  if (checksDisabled(state)) return asked && host.notice('Update checks are off for Fleet');
  if (updating) return asked && host.notice('Fleet is being updated already');
  updating = true;
  try {
    if (asked) host.notice('Looking for a new version of Fleet');
    const { checked, newer } = await checkForUpdate(asked ? null : state.update);
    state.update = checked;
    saveState({ update: checked });
    if (!newer) return asked && host.notice(`Fleet ${VERSION} is the latest version`);
    // fleet.ico is the installer's shortcuts' icon, which a new executable alone wouldn't change.
    host.notice(`Installing Fleet ${checked.latest}…`, 120_000);
    await installUpdate(checked.latest, { extras: ['fleet.ico'] });
    host.notice(`Fleet ${checked.latest} is installed: it runs from the next start`);
  } catch (e) {
    if (asked) host.notice(`Couldn't update Fleet: ${String(e.message).split('\n')[0]}`);
  } finally {
    updating = false;
  }
}
if (COMPILED) removeOldExecutables();
updateFleet(false);

const running = host.start(first.id);
if (prefixWanted && !prefixByte(prefixWanted)) host.notice(`"${prefixWanted}" can't be Fleet's prefix: ctrl+b is (see fleet -h)`);
await running;
left = true;
process.stdin.setRawMode(false);
process.exit(0);
