import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (args.includes('-h') || args.includes('--help')) {
  console.log(`keel [--demo]

Keel in the terminal: the Inbox, pull requests and pipelines of the Azure DevOps
organization in Keel's .env, with the same tracked projects and settings as the web app.

  --demo   the demo organization, no credentials needed

Signs in with AZDO_PAT from .env, or else with the Azure CLI (az login).
Inside: press ? for shortcuts, / for commands.`);
  process.exit(0);
}

// The server's config reads the environment once, on import, so settle it first: .env, then
// demo data or, with no PAT, the Azure CLI's sign-in (AZDO_AUTH=az).
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env file: the real environment only.
}
const demo = args.includes('--demo') || args.includes('--mock');
if (demo) process.env.AZDO_MOCK = '1';
else if (!process.env.AZDO_ORG_URL?.trim() && !/^(1|true|yes)$/i.test(process.env.AZDO_MOCK || '')) {
  console.error('No Azure DevOps organization: set AZDO_ORG_URL in .env (see .env.example), or try keel --demo.');
  process.exit(1);
} else if (!process.env.AZDO_PAT?.trim()) process.env.AZDO_AUTH ||= 'az';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('keel needs an interactive terminal.');
  process.exit(1);
}

const { captureConsole } = await import('./log.js');
captureConsole();
const { openKeel } = await import('./service.js');
let keel;
try {
  keel = openKeel();
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}

const { default: React } = await import('react');
const { render } = await import('ink');
const { App } = await import('./ui/App.jsx');

// Draw on the alternate screen, like a full-screen app, and give the terminal back untouched on exit.
process.stdout.write('\x1b[?1049h\x1b[H');
process.on('exit', () => process.stdout.write('\x1b[?1049l'));

const app = render(React.createElement(App, { keel }), { exitOnCtrlC: false, patchConsole: false });
await app.waitUntilExit();
process.exit(0);
