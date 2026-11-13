// First, so the kit knows which app this is before anything asks (configureApp).
import './app.js';
import React from 'react';
import { render } from 'ink';
import { resolve } from 'node:path';
import { COMPILED, VERSION } from './app.js';
import { loadConfig } from './config.js';
import { applyTheme } from './theme.js';
import { App } from './ui/App.jsx';
import { createDrill } from './provider.js';
import { demoDrill } from './demo.js';
import { HEADLESS, runHeadless } from './headless.js';
import { checkForUpdate, installUpdate, removeOldExecutables } from '@fleet/kit/update.js';
import { copyToClipboard } from '@fleet/kit/clipboard.js';
import { terminalMouse } from '@fleet/kit/mouse.js';
import { appTerminal } from '@fleet/kit/hosted.js';

const args = process.argv.slice(2);
const demo = args.includes('--demo');
const rest = args.filter((a) => a !== '--demo');

if (args.includes('-v') || args.includes('--version')) {
  console.log(`drill ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`drill [folder] [--demo]
drill run [folder] [--runner vitest|jest|node|playwright|dotnet] [--changed] [--fail-on any|not-flaky|none] [--json [--all]]
drill list [folder] [--json]

A project's tests, failures first: Vitest, Jest, node --test, Playwright and dotnet test (xUnit, NUnit,
MSTest), found from package.json, the runners' config files and .NET test projects (a drill.json says
otherwise). Each failure with its assertion, the diff of expected and actual, and the stack cut to the
project's own frames; the runner's own output beside it.

  --demo   run against a made-up project, to look around (nothing is read or run)

drill run runs them without the screen: the failures, then the counts. It exits 0 when everything
passed, 1 when a test failed (--fail-on not-flaky leaves out tests known to be flaky, none never
fails), 2 when it couldn't run. --changed runs only the tests touching what git says changed; --json
prints the result as JSON (--all adds every test). drill list says which suites it found.
End-to-end tests run only when the app they test answers (Bosun runs it; Drill never starts a copy).

Inside: press ? for shortcuts, / for commands, ! to run a shell command.`);
  process.exit(0);
}

const config = loadConfig();

if (HEADLESS.includes(rest[0])) {
  const code = await runHeadless(rest, { provider: demo ? demoDrill() : createDrill() });
  process.exit(code);
}

// The terminal, or inside Fleet the host's pipes made to look like one (the kit's hosted.js).
const { stdin, stdout, hosted } = appTerminal();
if (!stdin.isTTY || !stdout.isTTY) {
  console.error('drill needs an interactive terminal (drill run runs without one).');
  process.exit(1);
}

// The Theme setting (dark, light, or auto from COLORFGBG) and the accent over it.
applyTheme(config);

// Draw on the alternate screen, like a full-screen app, and give the terminal back untouched on exit.
// The window title is saved on the terminal's title stack and popped on exit. Terminals without one
// (Windows Terminal) take an empty title as "back to the default" instead.
process.stdout.write('\x1b[?1049h\x1b[H\x1b[22;0t');
process.on('exit', () => process.stdout.write('\x1b]0;\x07\x1b[23;0t\x1b[?1049l'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
const setTitle = (title) => process.stdout.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`);

// Only the downloaded executables look for updates and install them: a checkout updates with git pull,
// and its package.json version is behind the releases (the Release workflow sets the version as it builds).
// Inside Fleet, Fleet updates itself as a whole.
const updates = COMPILED && !hosted;
const checkUpdate = updates ? checkForUpdate : undefined;
// What an earlier update moved aside; quietly, and it doesn't hold up the start.
if (updates) removeOldExecutables();
// Clicks and the wheel, where the terminal can report them; App turns reporting on unless the setting is off.
// Set up before rendering, so mouse reports never reach Ink as keys.
const mouse = await terminalMouse(stdin, stdout);
// y copies: to the system clipboard, or through the terminal (OSC 52) over SSH or when that fails.
const copy = (text) => copyToClipboard(text);
const app = render(
  <App config={config} provider={demo ? demoDrill() : createDrill()} cwd={resolve(rest[0] ?? '.')} checkUpdate={checkUpdate} installUpdate={updates ? installUpdate : undefined} setTitle={setTitle} mouse={mouse} copy={copy} />,
  // Through the mouse's stdout, which watches the frames to select text from.
  { exitOnCtrlC: false, incrementalRendering: true, stdin, stdout: mouse?.stdout ?? stdout },
);
await app.waitUntilExit();
process.exit(0);
