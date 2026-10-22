import React from 'react';
import { render } from 'ink';
import { COMPILED, VERSION } from './version.js';
import { loadConfig } from './config.js';
import { setAccent } from './theme.js';
import { App } from './ui/App.jsx';
import { checkForUpdate, installUpdate, removeOldExecutables } from './update.js';
import { copyToClipboard } from './clipboard.js';
import { terminalMouse } from './mouse.js';
import { killEverything } from './supervisor.js';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  console.log(`bosun ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`bosun [folder] [--profile <name>] [--no-start]

Runs a project's processes for you in the terminal, each with its own log, port and health.
It reads them from bosun.json in the folder (the current one unless given), else from
package.json's dev script, split into its commands when it's a concurrently line.

  --profile    start with this profile from bosun.json
  --no-start   open without starting anything (R starts them all)

Quitting stops every process it started, and what those started.

Inside: press ? for shortcuts, / for commands, ! to run a shell command.`);
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('bosun needs an interactive terminal.');
  process.exit(1);
}

const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};
const folder = args.find((x, i) => !x.startsWith('-') && args[i - 1] !== '--profile');
const dir = resolve(folder ?? '.');
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`bosun: ${dir} isn't a folder.`);
  process.exit(1);
}
// However Bosun ends (q, a crash, the terminal closing), what it started doesn't outlive it.
process.on('exit', killEverything);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));

// o: the browser, through what the OS opens addresses with.
const openUrl = (url) => {
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
};

const config = loadConfig();
setAccent(config.accent);

// Draw on the alternate screen, like a full-screen app, and give the terminal back untouched on exit.
// The window title is saved on the terminal's title stack and popped on exit. Terminals without one
// (Windows Terminal) take an empty title as "back to the default" instead.
process.stdout.write('\x1b[?1049h\x1b[H\x1b[22;0t');
process.on('exit', () => process.stdout.write('\x1b]0;\x07\x1b[23;0t\x1b[?1049l'));
const setTitle = (title) => process.stdout.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`);

// Only the downloaded executables look for updates and install them: a checkout updates with git pull,
// and its package.json version is behind the releases (the Release workflow sets the version as it builds).
const checkUpdate = COMPILED ? checkForUpdate : undefined;
// What an earlier update moved aside; quietly, and it doesn't hold up the start.
if (COMPILED) removeOldExecutables();
// Clicks and the wheel, where the terminal can report them; App turns reporting on unless the setting is off.
// Set up before rendering, so mouse reports never reach Ink as keys.
const mouse = await terminalMouse(process.stdin, process.stdout);
// y copies: to the system clipboard, or through the terminal (OSC 52) over SSH or when that fails.
const copy = (text) => copyToClipboard(text);
const app = render(
  <App config={config} dir={dir} profile={value('--profile') ?? null} autostart={!args.includes('--no-start')} openUrl={openUrl} checkUpdate={checkUpdate} installUpdate={COMPILED ? installUpdate : undefined} setTitle={setTitle} mouse={mouse} copy={copy} />,
  // Through the mouse's stdout, which watches the frames to select text from.
  { exitOnCtrlC: false, stdout: mouse?.stdout ?? process.stdout },
);
await app.waitUntilExit();
process.exit(0);
