// First, so the kit knows which app this is before anything asks (configureApp).
import './app.js';
import React from 'react';
import { render } from 'ink';
import { resolve } from 'node:path';
import { COMPILED, VERSION } from './app.js';
import { loadConfig } from './config.js';
import { applyTheme } from './theme.js';
import { App } from './ui/App.jsx';
import { createBilge } from './provider.js';
import { demoBilge } from './demo.js';
import { runHeadless } from './headless.js';
import { checkForUpdate, installUpdate, removeOldExecutables } from '@fleet/kit/update.js';
import { copyToClipboard } from '@fleet/kit/clipboard.js';
import { terminalMouse } from '@fleet/kit/mouse.js';
import { appTerminal } from '@fleet/kit/hosted.js';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const demo = args.includes('--demo');
const rest = args.filter((a) => a !== '--demo');

if (args.includes('-v') || args.includes('--version')) {
  console.log(`bilge ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`bilge [folder] [--demo]
bilge audit [folder] [--fail-on critical|high|medium|low|none] [--json]
bilge sbom [folder] [-o file]

What a project depends on: the packages in its npm and NuGet lock files (package-lock.json,
packages.lock.json, a .csproj's PackageReferences), the advisories OSV (osv.dev) knows against
their versions, their licences, how far behind they are, and a fix for each: the command that moves
a package to the version that fixes it, run where its manifest is (asked first).

  --demo   run against an in-memory project, to look around (nothing is read, asked or run)

bilge audit prints the findings and exits 1 when one is as bad as --fail-on (high by default), for
a pipeline; bilge sbom writes a CycloneDX bill of materials. Only the packages' names and versions
leave the machine, to api.osv.dev (and, for /outdated, the npm and NuGet registries).

Inside: press ? for shortcuts, / for commands, ! to run a shell command.`);
  process.exit(0);
}

const config = loadConfig();

if (rest[0] === 'audit' || rest[0] === 'sbom') {
  const code = await runHeadless(rest, { provider: demo ? demoBilge() : createBilge(), config, version: VERSION });
  process.exit(code);
}

// The terminal, or inside Fleet the host's pipes made to look like one (the kit's hosted.js).
const { stdin, stdout, hosted } = appTerminal();
if (!stdin.isTTY || !stdout.isTTY) {
  console.error('bilge needs an interactive terminal (bilge audit runs without one).');
  process.exit(1);
}

// o: the browser, through what the OS opens addresses with.
const openUrl = (url) => {
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
};

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
  <App config={config} provider={demo ? demoBilge() : createBilge()} cwd={resolve(rest[0] ?? '.')} openUrl={openUrl} checkUpdate={checkUpdate} installUpdate={updates ? installUpdate : undefined} setTitle={setTitle} mouse={mouse} copy={copy} />,
  // Through the mouse's stdout, which watches the frames to select text from.
  { exitOnCtrlC: false, stdin, stdout: mouse?.stdout ?? stdout },
);
await app.waitUntilExit();
process.exit(0);
