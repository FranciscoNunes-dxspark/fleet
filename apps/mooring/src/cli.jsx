// First, so the kit knows which app this is before anything asks (configureApp).
import './app.js';
import React from 'react';
import { render } from 'ink';
import { COMPILED, VERSION } from './app.js';
import { loadConfig } from './config.js';
import { applyTheme } from './theme.js';
import { App } from './ui/App.jsx';
import { createLocal } from './local.js';
import { createSession } from './session.js';
import { demoLocal, demoSession } from './demo.js';
import { createKeygen } from './keygen.js';
import { createHostKeys } from './hostkeys.js';
import { runSecurity } from './headless.js';
import { checkForUpdate, installUpdate, removeOldExecutables } from '@fleet/kit/update.js';
import { copyToClipboard } from '@fleet/kit/clipboard.js';
import { terminalMouse } from '@fleet/kit/mouse.js';
import { appTerminal } from '@fleet/kit/hosted.js';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  console.log(`mooring ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`mooring [host] [--demo]
mooring security <host> [--json] [--fail-on critical|high|medium|low|none]

Files and shells on a server, in the terminal: this machine's folder beside a server's, uploads and
downloads in a queue with their progress, over the system's ssh (SFTP). It signs in with a key or your
ssh agent only: there is no password prompt, and the host must be in known_hosts already.

  host     a saved host to open at start (/add saves one)
  --demo   a made-up host and machine, to look around (nothing is touched)

mooring security checks how a Linux server is hardened, reading only (open ports, sshd's settings,
pending security updates, the firewall, accounts and sudo rules, SUID and world-writable files, the
system's end of life), prints the findings (or --json) and exits 1 when one is as bad as --fail-on
(high by default), 2 when it couldn't run. The host is a saved one or user@host[:port], signing in
with a key or the agent (a host saved with a password can't be checked without a terminal).

Inside: press ? for shortcuts, / for commands, ctrl+p for the palette.`);
  process.exit(0);
}

// mooring security: no terminal needed, so before the check for one.
if (args[0] === 'security') {
  const config = loadConfig();
  const demo = args.includes('--demo');
  if (demo) config.hosts = [{ name: 'demo', host: 'demo.example.com', user: 'demo' }];
  const code = await runSecurity(args.slice(1), { config, makeSession: demo ? () => demoSession() : (host) => createSession(host) });
  process.exit(code);
}

// The terminal, or inside Fleet the host's pipes made to look like one (the kit's hosted.js).
const { stdin, stdout, hosted } = appTerminal();
if (!stdin.isTTY || !stdout.isTTY) {
  console.error('mooring needs an interactive terminal.');
  process.exit(1);
}

const demo = args.includes('--demo');
const config = loadConfig();
if (demo) config.hosts = [{ name: 'demo', host: 'demo.example.com', user: 'demo' }];
const named = args.find((a) => !a.startsWith('-'));

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
if (updates) removeOldExecutables();
// Clicks and the wheel, where the terminal can report them; set up before rendering, so mouse reports never reach Ink as keys.
const mouse = await terminalMouse(stdin, stdout);

const app = render(
  <App
    config={config}
    local={demo ? demoLocal() : createLocal({ dir: process.cwd() })}
    makeSession={demo ? () => demoSession() : (host, options) => createSession(host, options)}
    connectTo={demo ? 'demo' : named}
    persist={!demo}
    hostKeys={demo ? undefined : createHostKeys()}
    keygen={demo ? undefined : createKeygen()}
    demo={demo}
    copy={(text) => copyToClipboard(text)}
    checkUpdate={updates ? checkForUpdate : undefined}
    installUpdate={updates ? installUpdate : undefined}
    setTitle={setTitle}
    mouse={mouse}
  />,
  // Through the mouse's stdout, which watches the frames to select text from.
  { exitOnCtrlC: false, incrementalRendering: true, stdin, stdout: mouse?.stdout ?? stdout },
);

// However it ends, the connection and what is transferring are closed by App's cleanup.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
await app.waitUntilExit();
process.exit(0);
