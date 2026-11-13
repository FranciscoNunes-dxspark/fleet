// First, so the kit knows which app this is before anything asks (configureApp).
import './app.js';
import React from 'react';
import { render } from 'ink';
import { resolve } from 'node:path';
import { COMPILED, VERSION } from './app.js';
import { loadConfig } from './config.js';
import { applyTheme } from './theme.js';
import { App } from './ui/App.jsx';
import { createLantern } from './provider.js';
import { demoLantern } from './demo.js';
import { HEADLESS, runHeadless } from './headless.js';
import { checkForUpdate, installUpdate, removeOldExecutables } from '@fleet/kit/update.js';
import { copyToClipboard } from '@fleet/kit/clipboard.js';
import { terminalMouse } from '@fleet/kit/mouse.js';
import { appTerminal } from '@fleet/kit/hosted.js';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const demo = args.includes('--demo');
const rest = args.filter((a) => a !== '--demo');

if (args.includes('-v') || args.includes('--version')) {
  console.log(`lantern ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`lantern [folder] [--demo]
lantern audit [url…|folder] [--runs n] [--fail-on terms] [--json] [--sarif [file]] [--env name|--all] [--no-links]
lantern security [url…|folder] [--fail-on critical|high|medium|low|none] [--json] [--sarif [file]]
lantern domains [host…|folder] [--fail-on critical|high|medium|low|none] [--json] [--sarif [file]]

A web page audited: it opens the page in a headless Chrome it finds on this machine (Chrome, Edge or
Chromium; LANTERN_CHROME or /chrome names another), measures it three times and lists what is wrong,
worst first: Core Web Vitals (LCP, CLS, INP from a scripted click, TTFB; lab numbers, the median),
weight, render-blocking resources and images; accessibility with axe-core; title, description,
canonical, robots, lang, broken links and console errors; and security headers, cookies, mixed content,
source maps served, and the TLS certificate. Without a browser, the header, certificate and domain
checks still run. The pages come from lantern.json or .fleet/project.json's environments
("lantern": { "url": "https://…" }).

  --demo   run against a made-up shop and its staging copy (nothing is fetched)

lantern audit exits 1 when --fail-on fails (high by default): a level for every finding (high), a
category at a level (a11y:serious, security:medium, seo:low), or a lab metric past a value
(perf:lcp>2.5s, perf:cls>0.1, perf:inp>200ms, perf:weight>2mb), comma-separated. lantern security
prints the family's security JSON with --json; lantern domains checks DNS (A, AAAA, CNAME, CAA, MX),
the redirects from http:// and the bare domain, https and the certificate's days left.

Inside: press ? for shortcuts, / for commands, ! to run a shell command.`);
  process.exit(0);
}

const config = loadConfig();

if (HEADLESS.includes(rest[0])) {
  const code = await runHeadless(rest, { provider: demo ? demoLantern() : createLantern(), config, version: VERSION });
  process.exit(code);
}

// The terminal, or inside Fleet the host's pipes made to look like one (the kit's hosted.js).
const { stdin, stdout, hosted } = appTerminal();
if (!stdin.isTTY || !stdout.isTTY) {
  console.error('lantern needs an interactive terminal (lantern audit runs without one).');
  process.exit(1);
}

// o: the browser, through what the OS opens addresses with.
const openUrl = (url) => {
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
};

applyTheme(config);

// Draw on the alternate screen, like a full-screen app, and give the terminal back untouched on exit.
process.stdout.write('\x1b[?1049h\x1b[H\x1b[22;0t');
process.on('exit', () => process.stdout.write('\x1b]0;\x07\x1b[23;0t\x1b[?1049l'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
const setTitle = (title) => process.stdout.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`);

// Only the downloaded executables look for updates and install them; inside Fleet, Fleet updates itself as a whole.
const updates = COMPILED && !hosted;
const checkUpdate = updates ? checkForUpdate : undefined;
if (updates) removeOldExecutables();
const mouse = await terminalMouse(stdin, stdout);
const copy = (text) => copyToClipboard(text);
const app = render(
  <App config={config} provider={demo ? demoLantern() : createLantern()} cwd={resolve(rest[0] ?? '.')} openUrl={openUrl} checkUpdate={checkUpdate} installUpdate={updates ? installUpdate : undefined} setTitle={setTitle} mouse={mouse} copy={copy} />,
  { exitOnCtrlC: false, incrementalRendering: true, stdin, stdout: mouse?.stdout ?? stdout },
);
await app.waitUntilExit();
process.exit(0);
