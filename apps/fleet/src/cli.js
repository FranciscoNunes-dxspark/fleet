// The host's command line: `fleet [app] [args…]`. First, so the kit knows this process is Fleet.
import './app.js';
import { COMPILED, VERSION } from './app.js';
import { checkForUpdate, checksDisabled, installUpdate, removeOldExecutables } from '@fleet/kit/update.js';
import { keepVtInput } from '@fleet/kit/mouse.js';
import { plainOutput } from '@fleet/kit/glyphs.js';
import { Host, LEAVE } from './host.js';
import { appSpawner } from './launch.js';
import { SPACES, spaceNamed } from './spaces.js';
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
fleet alone opens the one you used last.

  ctrl+] 1-7 or s t o b h k w switch (o is Sonar)
  ctrl+] ] / n / p            next, previous
  ctrl+] ctrl+]               send ctrl+] to the app
  ctrl+] q                    quit, stopping every app
  ctrl+] ?                    the keys

An app starts the first time you switch to it. A line an app copies "for
Trawl" (or any sibling) goes straight to that app's prompt.`);
  process.exit(0);
}

const named = args[0] && !args[0].startsWith('-') ? spaceNamed(args[0]) : undefined;
if (args[0] && !args[0].startsWith('-') && !named) {
  console.error(`fleet: there's no app called ${args[0]}; the apps are ${SPACES.map((s) => s.id).join(', ')}.`);
  process.exit(1);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('fleet needs an interactive terminal.');
  process.exit(1);
}

const state = loadState();
const first = named ?? spaceNamed(state.last) ?? SPACES[0];
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
  spawn: appSpawner({ compiled: COMPILED, depth }),
  args: named ? { [named.id]: args.slice(1) } : {},
  truecolor: depth >= 24,
  // The bell when a tab gets a badge: FLEET_NO_BELL=1, or "bell": false in host.json, keeps it quiet.
  bell: process.env.FLEET_NO_BELL !== '1' && state.bell !== false,
  onSwitch: (id) => saveState({ last: id }),
  onUpdate: () => updateFleet(true),
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

await host.start(first.id);
left = true;
process.stdin.setRawMode(false);
process.exit(0);
