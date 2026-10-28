// First, so the kit knows which app this is before anything asks (configureApp).
import './app.js';
import React from 'react';
import { render } from 'ink';
import { COMPILED, VERSION } from './app.js';
import { clearAfter, loadConfig } from './config.js';
import { applyTheme } from './theme.js';
import { App } from './ui/App.jsx';
import { createAzure } from './azure/arm.js';
import { currentSubscription, token } from './azure/az.js';
import { createLocal } from './local.js';
import { demoAzure, demoLocal } from './demo.js';
import { notification } from './notify.js';
import { clipGuard } from './clipguard.js';
import { checkForUpdate, installUpdate, removeOldExecutables } from '@fleet/kit/update.js';
import { copyToClipboard, readClipboard } from '@fleet/kit/clipboard.js';
import { terminalMouse } from '@fleet/kit/mouse.js';
import { appTerminal } from '@fleet/kit/hosted.js';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  console.log(`locker ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`locker [--demo]

Secrets and configuration in the terminal: the folder's .env files, appsettings*.json, .NET user
secrets and Hail's env files side by side with an App Service app's settings and a key vault, by
key, marking what is missing and what differs (by hash: values are never shown unless you ask);
Key Vault references checked; secrets and certificates about to expire. Azure is read with the
Azure CLI's sign-in (az login).

  --demo   a made-up project and Azure, to look around (nothing is touched)

Inside: press ? for shortcuts, / for commands, ctrl+p for the palette.`);
  process.exit(0);
}

// The terminal, or inside Fleet the host's pipes made to look like one (the kit's hosted.js).
const { stdin, stdout, hosted } = appTerminal();
if (!stdin.isTTY || !stdout.isTTY) {
  console.error('locker needs an interactive terminal.');
  process.exit(1);
}

const config = loadConfig();
const demo = args.includes('--demo');

// o: the portal, through what the OS opens addresses with.
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
const setTitle = (title) => process.stdout.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`);

// Only the downloaded executables look for updates and install them: a checkout updates with git pull.
// Inside Fleet, Fleet updates itself as a whole.
const updates = COMPILED && !hosted;
const checkUpdate = updates ? checkForUpdate : undefined;
if (updates) removeOldExecutables();
// Clicks and the wheel, where the terminal can report them; set up before rendering, so mouse reports never reach Ink as keys.
const mouse = await terminalMouse(stdin, stdout);
// Plain text (a line for a sibling) to the clipboard; a value through the guard, which empties the
// clipboard again after the clearClipboard setting's seconds, and on quitting.
const copy = (text) => copyToClipboard(text);
let settings = config;
const guard = clipGuard({ copy, read: () => readClipboard(), after: () => clearAfter(settings) });
const provider = demo ? demoAzure() : { ...createAzure({ token }), currentSubscription };
const local = demo ? demoLocal() : createLocal({ dir: process.cwd() });

const app = render(
  <App
    config={config}
    provider={provider}
    local={local}
    cwd={local.dir}
    demo={demo}
    guard={guard}
    copy={copy}
    // A secret about to run out, said once on start: the bell and the terminal's notification.
    notify={(title, body) => process.stdout.write(notification(title, body))}
    openUrl={openUrl}
    checkUpdate={checkUpdate}
    installUpdate={updates ? installUpdate : undefined}
    setTitle={setTitle}
    mouse={mouse}
    onConfig={(c) => (settings = c)}
  />,
  // Through the mouse's stdout, which watches the frames to select text from.
  { exitOnCtrlC: false, stdin, stdout: mouse?.stdout ?? stdout },
);

// However it ends, a value still waiting to be cleared goes from the clipboard first.
const leave = async () => {
  await guard.flush().catch(() => {});
  process.exit(0);
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, leave);
await app.waitUntilExit();
await leave();
