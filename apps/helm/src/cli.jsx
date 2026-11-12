// First, so the kit knows which app this is before anything asks (configureApp).
import './app.js';
import React from 'react';
import { render } from 'ink';
import { VERSION } from './app.js';
import { App } from './ui/App.jsx';
import { locate } from './powershell.js';
import { openTerminal } from './terminal.js';
import { appTerminal } from '@fleet/kit/hosted.js';
import { terminalMouse } from '@fleet/kit/mouse.js';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  console.log(`helm ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`helm [script.ps1]

A PowerShell script editor in the terminal, like the ISE: a Script view (the script over the console)
and a Console view (PowerShell itself, with a terminal: its own completion, history and Ctrl+C), all one
PowerShell session (pwsh when it is installed, else Windows PowerShell), so variables and functions stay
from one run to the next.

Inside: F5 runs the script, F8 the current line, ctrl+s saves, ctrl+o opens, ctrl+t moves between
the views, ctrl+f finds, F1 lists the keys, esc stops a run, ctrl+q quits.`);
  process.exit(0);
}

// The terminal, or inside Fleet the host's pipes made to look like one (the kit's hosted.js).
const { stdin, stdout } = appTerminal();
if (!stdin.isTTY || !stdout.isTTY) {
  console.error('helm needs an interactive terminal.');
  process.exit(1);
}

const cwd = process.cwd();
const bin = await locate();
// PowerShell with a terminal of its own (terminal.js), opened by App at the console's size.
const shell = bin ? { name: bin, open: (options) => openTerminal({ bin, ...options }) } : null;

// Draw on the alternate screen, and give the terminal back untouched on exit.
process.stdout.write('\x1b[?1049h\x1b[H\x1b[22;0t');
process.on('exit', () => process.stdout.write('\x1b]0;\x07\x1b[23;0t\x1b[?1049l'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
const setTitle = (title) => process.stdout.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`);

// Clicks and the wheel, where the terminal can report them; set up before rendering, so mouse reports never reach Ink as keys.
const mouse = await terminalMouse(stdin, stdout);

const app = render(<App shell={shell} file={args.find((a) => !a.startsWith('-'))} cwd={cwd} setTitle={setTitle} mouse={mouse} />, { exitOnCtrlC: false, stdin, stdout: mouse?.stdout ?? stdout });
await app.waitUntilExit();
process.exit(0);
