// First, so the kit knows which app this is before anything asks (configureApp).
import './app.js';
import React from 'react';
import { render } from 'ink';
import { resolve } from 'node:path';
import { COMPILED, VERSION } from './app.js';
import { loadConfig } from './config.js';
import { applyTheme } from './theme.js';
import { App } from './ui/App.jsx';
import { checkForUpdate, installUpdate, removeOldExecutables } from '@fleet/kit/update.js';
import { ask } from './claude.js';
import { copyToClipboard } from '@fleet/kit/clipboard.js';
import { terminalMouse } from '@fleet/kit/mouse.js';
import { appTerminal } from '@fleet/kit/hosted.js';
import { notification } from './notify.js';
import { familyDir } from '@fleet/kit/family.js';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  console.log(`splice ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`splice [path]

A keyboard-driven git client. Opens the repository at [path] (default: the
current folder). If that isn't a repository, it lists the ones it finds there;
with no [path], it opens the repository you had open last instead.

Inside: press ? for shortcuts, / for commands, ! to run any git command.`);
  process.exit(0);
}

// The terminal, or inside Fleet the host's pipes made to look like one (the kit's hosted.js).
const { stdin, stdout, hosted } = appTerminal();
if (!stdin.isTTY || !stdout.isTTY) {
  console.error('splice needs an interactive terminal.');
  process.exit(1);
}

const config = loadConfig();
applyTheme(config);

// Draw on the alternate screen, like a full-screen app, and give the terminal back untouched on exit.
// The window title is saved on the terminal's title stack and popped on exit. Terminals without one
// (Windows Terminal) take an empty title as "back to the default" instead.
process.stdout.write('\x1b[?1049h\x1b[H\x1b[22;0t');
process.on('exit', () => process.stdout.write('\x1b]0;\x07\x1b[23;0t\x1b[?1049l'));
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
const path = args.find((x) => !x.startsWith('-'));
// Started without a path outside a repository, Splice reopens the last one; a path given means look there.
const app = render(
  <App
    initialPath={resolve(path ?? process.cwd())}
    reopenLast={!path}
    config={config}
    checkUpdate={checkUpdate}
    installUpdate={updates ? installUpdate : undefined}
    askClaude={ask}
    familyHome={familyDir()}
    setTitle={setTitle}
    mouse={mouse}
    copy={copy}
    // The bell and a desktop notification, written straight to the terminal (they draw nothing).
    notify={(title, body) => process.stdout.write(notification(title, body))}
  />,
  // Through the mouse's stdout, which watches the frames to select text from.
  { exitOnCtrlC: false, stdin, stdout: mouse?.stdout ?? stdout },
);
await app.waitUntilExit();
process.exit(0);
