import React from 'react';
import { render } from 'ink';
import { COMPILED, VERSION } from './version.js';
import { loadConfig } from './config.js';
import { applyTheme } from './theme.js';
import { App } from './ui/App.jsx';
import { createAzure } from './azure/arm.js';
import { currentSubscription, token } from './azure/az.js';
import { demoAzure } from './demo.js';
import { checkForUpdate, installUpdate, removeOldExecutables } from './update.js';
import { copyToClipboard } from './clipboard.js';
import { terminalMouse } from './mouse.js';

const args = process.argv.slice(2);

if (args.includes('-v') || args.includes('--version')) {
  console.log(`sonar ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`sonar [--demo] [--sub <name|id>] [--app <app[/slot]> | --url <address>] [--insights <appId|name>] [--logs [--kql <query>] | --problems]

An Azure console for the terminal: App Service and Functions, their logs and their
problems. It signs in through the Azure CLI (az login) and starts on the subscription
az has selected; --demo shows a made-up one instead.

  --sub        start on this subscription
  --app        start on this app (or app/slot)
  --url        start on the app that serves this address (its own, or a custom domain)
  --insights   look in this Application Insights (its AppId or name)
  --logs       open Logs about it (its latest requests, or --kql's query)
  --problems   open Problems about it

Keel's terminal app opens Sonar this way from a production monitor (S).

Inside: press ? for shortcuts, / for commands, t to change the time span.`);
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('sonar needs an interactive terminal.');
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
const checkUpdate = COMPILED ? checkForUpdate : undefined;
// What an earlier update moved aside; quietly, and it doesn't hold up the start.
if (COMPILED) removeOldExecutables();
// Clicks and the wheel, where the terminal can report them; App turns reporting on unless the setting is off.
// Set up before rendering, so mouse reports never reach Ink as keys.
const mouse = await terminalMouse(process.stdin, process.stdout);
// y copies: to the system clipboard, or through the terminal (OSC 52) over SSH or when that fails.
const copy = (text) => copyToClipboard(text);
const demo = args.includes('--demo');
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};
const open = { sub: value('--sub'), app: value('--app'), url: value('--url'), insights: value('--insights'), kql: value('--kql'), view: args.includes('--problems') ? 'problems' : args.includes('--logs') || args.includes('--kql') ? 'logs' : undefined };
const opening = Object.values(open).some(Boolean) ? open : undefined;
const provider = demo ? demoAzure() : { ...createAzure({ token }), currentSubscription };
const app = render(
  <App config={config} provider={provider} open={opening} checkUpdate={checkUpdate} installUpdate={COMPILED ? installUpdate : undefined} setTitle={setTitle} mouse={mouse} copy={copy} />,
  // Through the mouse's stdout, which watches the frames to select text from.
  { exitOnCtrlC: false, stdout: mouse?.stdout ?? process.stdout },
);
await app.waitUntilExit();
process.exit(0);
