// First, so the kit knows which app this is before anything asks (configureApp).
import './app.js';
import React from 'react';
import { render } from 'ink';
import { VERSION } from './app.js';
import { App } from './ui/App.jsx';
import { createSession, locate } from './powershell.js';
import { appTerminal } from '@fleet/kit/hosted.js';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  console.log(`helm ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`helm [script.ps1]

A PowerShell script editor in the terminal, like the ISE: a script pane on top, the output of what
ran below it, and a console prompt under that, all over one PowerShell session (pwsh when it is
installed, else Windows PowerShell), so variables and functions stay from one run to the next.

Inside: F5 runs the script, F8 the current line, ctrl+s saves, ctrl+o opens, ctrl+t moves between
the script and the console, esc stops a run, ctrl+q quits.`);
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
const session = bin ? createSession({ bin, cwd }) : null;

// Draw on the alternate screen, and give the terminal back untouched on exit.
process.stdout.write('\x1b[?1049h\x1b[H\x1b[22;0t');
process.on('exit', () => process.stdout.write('\x1b]0;\x07\x1b[23;0t\x1b[?1049l'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
const setTitle = (title) => process.stdout.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`);

const app = render(<App session={session} file={args.find((a) => !a.startsWith('-'))} cwd={cwd} setTitle={setTitle} />, { exitOnCtrlC: false, stdin, stdout });
await app.waitUntilExit();
session?.close();
process.exit(0);
