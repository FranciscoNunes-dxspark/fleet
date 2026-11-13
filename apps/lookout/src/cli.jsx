// First, so the kit knows which app this is before anything asks (configureApp).
import './app.js';
import React from 'react';
import { render } from 'ink';
import { resolve } from 'node:path';
import { COMPILED, VERSION } from './app.js';
import { loadConfig } from './config.js';
import { applyTheme } from './theme.js';
import { App } from './ui/App.jsx';
import { createLookout } from './provider.js';
import { demoLookout } from './demo.js';
import { HEADLESS, runHeadless } from './headless.js';
import { checkForUpdate, installUpdate, removeOldExecutables } from '@fleet/kit/update.js';
import { copyToClipboard } from '@fleet/kit/clipboard.js';
import { terminalMouse } from '@fleet/kit/mouse.js';
import { appTerminal } from '@fleet/kit/hosted.js';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const demo = args.includes('--demo');
const portAt = args.indexOf('--port');
const portArg = portAt >= 0 ? Number(args[portAt + 1]) : null;
const rest = args.filter((a, i) => a !== '--demo' && (portAt < 0 || (i !== portAt && i !== portAt + 1)));

if (args.includes('-v') || args.includes('--version')) {
  console.log(`lookout ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`lookout [folder] [--demo] [--port n]
lookout security [capture.har] [--fail-on critical|high|medium|low|none] [--json] [--sarif [file]]
lookout ca [--pem]
lookout env [--port n]

A local HTTP and HTTPS proxy that records what a browser, an emulator or your own server sends and
receives. It listens on 127.0.0.1:8888 (this machine only); point HTTP_PROXY and HTTPS_PROXY at it.
HTTPS is a tunnel recorded by its host name, until /intercept on: then Lookout answers with
certificates from a certificate authority of its own, made once in ~/.lookout (its key never leaves
it), which you trust once. Any request it saw becomes a request in a .http file, opened in Hail (h).
Authorization, cookies, API keys and anything that looks like a secret are hidden on screen until
shown, and written to .http files as variables ({{token}}).

  --demo     a made-up session, to look around (nothing listens, nothing is written)
  --port n   listen on another port (the setting's, else 8888)

lookout security reports what the traffic says (tokens over plain HTTP, cookies without Secure,
credentials in a query string), from a HAR file or the last session; exits 1 when a finding is as bad
as --fail-on (high by default). lookout ca makes the certificate authority and says how to trust it
on this system (--pem prints the certificate). lookout env prints the proxy settings.

Inside: press ? for shortcuts, / for commands, ! to run a shell command.`);
  process.exit(0);
}

const config = loadConfig();

if (HEADLESS.includes(rest[0])) {
  // --port belongs to env as much as to the app.
  const code = await runHeadless(portArg ? [...rest, '--port', String(portArg)] : rest, { provider: demo ? demoLookout() : createLookout(), config, version: VERSION, demo });
  process.exit(code);
}

// The terminal, or inside Fleet the host's pipes made to look like one (the kit's hosted.js).
const { stdin, stdout, hosted } = appTerminal();
if (!stdin.isTTY || !stdout.isTTY) {
  console.error('lookout needs an interactive terminal (lookout security, ca and env run without one).');
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
  <App config={config} port={portArg} provider={demo ? demoLookout() : createLookout()} cwd={resolve(rest[0] ?? '.')} openUrl={openUrl} checkUpdate={checkUpdate} installUpdate={updates ? installUpdate : undefined} setTitle={setTitle} mouse={mouse} copy={copy} />,
  // Through the mouse's stdout, which watches the frames to select text from.
  { exitOnCtrlC: false, incrementalRendering: true, stdin, stdout: mouse?.stdout ?? stdout },
);
await app.waitUntilExit();
process.exit(0);
