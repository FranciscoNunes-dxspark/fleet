// First, so the kit knows which app this is before anything asks (configureApp).
import './app.js';
import React from 'react';
import { render } from 'ink';
import { COMPILED, VERSION } from './app.js';
import { loadConfig } from './config.js';
import { applyTheme } from './theme.js';
import { App } from './ui/App.jsx';
import { createDocker } from './docker.js';
import { createKube } from './kube.js';
import { demoDocker, demoShell } from './demo.js';
import { demoKube } from './demokube.js';
import { checkForUpdate, installUpdate, removeOldExecutables } from '@fleet/kit/update.js';
import { copyToClipboard } from '@fleet/kit/clipboard.js';
import { terminalMouse } from '@fleet/kit/mouse.js';
import { appTerminal } from '@fleet/kit/hosted.js';
import { MOUSE_OFF, MOUSE_ON } from '@fleet/kit/mouse.js';
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  console.log(`wharf ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`wharf [--demo]

Containers and pods in the terminal: what's running (a compose project's together), CPU and memory,
live logs, and starting, stopping, restarting and removing them. It talks to Docker and kubectl
through their command lines, so whatever they are set to (a docker context, DOCKER_HOST, kubectl's
current context) is what Wharf shows.

  --demo   run against an in-memory Docker and cluster, to look around (nothing is touched)

Quitting leaves every container as it was.

Inside: press ? for shortcuts, / for commands, ! to run a shell command.`);
  process.exit(0);
}

// The terminal, or inside Fleet the host's pipes made to look like one (the kit's hosted.js).
const { stdin, stdout, hosted } = appTerminal();
if (!stdin.isTTY || !stdout.isTTY) {
  console.error('wharf needs an interactive terminal.');
  process.exit(1);
}

const config = loadConfig();

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

// e, a shell in a container or pod: the terminal is handed over to it and taken back when it ends.
// spawnSync, because while it blocks Node reads nothing from the terminal, so every key goes to the
// shell (a paused stream would still read ahead and take some). Ink is left as it is, and draws its
// whole frame again on the 'resize' afterwards. Inside Fleet there's no terminal to hand over: App
// runs the shell in its line-mode pane instead. The demo has nothing to go into, so it's a pretend
// shell in that pane.
const demo = args.includes('--demo');
const runInTerminal =
  hosted || demo
    ? undefined
    : (command, cmdArgs, { mouse: mouseOn = false } = {}) => {
        const mouseWasOn = mouseOn && Boolean(mouse);
        if (mouseWasOn) stdout.write(MOUSE_OFF);
        stdin.setRawMode?.(false);
        // Off the alternate screen, the cursor shown, to the terminal's own screen and settings.
        stdout.write('\x1b[?25h\x1b[?1049l');
        const r = spawnSync(command, cmdArgs, { stdio: 'inherit', windowsHide: false });
        stdout.write('\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l');
        stdin.setRawMode?.(true);
        if (mouseWasOn) stdout.write(MOUSE_ON);
        stdout.emit('resize');
        return r;
      };
const app = render(
  <App config={config} provider={demo ? demoDocker() : createDocker()} kube={demo ? demoKube() : createKube()} openUrl={openUrl} checkUpdate={checkUpdate} installUpdate={updates ? installUpdate : undefined} setTitle={setTitle} mouse={mouse} copy={copy} runInTerminal={runInTerminal} {...(demo ? { spawnShell: demoShell() } : {})} />,
  // Through the mouse's stdout, which watches the frames to select text from.
  { exitOnCtrlC: false, stdin, stdout: mouse?.stdout ?? stdout },
);
await app.waitUntilExit();
process.exit(0);
