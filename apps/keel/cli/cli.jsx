import path from 'node:path';
import { ROOT } from '../server/root.js';

const args = process.argv.slice(2);
const ENV_FILE = path.join(ROOT, '.env');

if (args.includes('-v') || args.includes('--version')) {
  const { VERSION } = await import('./open.js');
  console.log(`keel ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`keel [--demo]

Keel in the terminal: the Inbox, pull requests and pipelines of the Azure DevOps
organization in ${ENV_FILE}, with the same tracked projects and settings as the web app.

  --demo   the demo organization, no credentials needed

Signs in with AZDO_PAT from that file, or else with the Azure CLI (az login).
With no organization set, it asks for one on start and saves it there.
Inside: press ? for shortcuts, / for commands.`);
  process.exit(0);
}

// The server's config reads the environment once, on import, so settle it first: .env, then
// demo data or, with no PAT, the Azure CLI's sign-in (AZDO_AUTH=az).
try {
  process.loadEnvFile(ENV_FILE);
} catch {
  // No .env file: the real environment only.
}
const interactive = process.stdin.isTTY && process.stdout.isTTY;
const demo = args.includes('--demo') || args.includes('--mock');
if (demo) process.env.AZDO_MOCK = '1';
else if (!process.env.AZDO_ORG_URL?.trim() && !/^(1|true|yes)$/i.test(process.env.AZDO_MOCK || '')) {
  if (!interactive) {
    console.error(`No Azure DevOps organization: set AZDO_ORG_URL=https://dev.azure.com/<org> in ${ENV_FILE}, or try keel --demo.`);
    process.exit(1);
  }
  // First run: ask, and save the answers for next time (setup.js). Left empty, it's the demo.
  const { firstRunSetup } = await import('./setup.js');
  try {
    if ((await firstRunSetup({ envFile: ENV_FILE })) === 'demo') process.env.AZDO_MOCK = '1';
  } catch (e) {
    if (e.cancelled) process.exit(130);
    console.error(`Couldn't save the settings: ${e.message}`);
    process.exit(1);
  }
}
if (!/^(1|true|yes)$/i.test(process.env.AZDO_MOCK || '') && !process.env.AZDO_PAT?.trim()) process.env.AZDO_AUTH ||= 'az';

if (!interactive) {
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

// Only the downloaded executables look for updates and install them (update.js): a checkout updates
// with git pull, and its package.json version is behind the releases. KEEL_CHECK_UPDATES=0 turns the
// check off; KEEL_AUTO_UPDATE=0 only says a release is out. The last answer is kept in the data folder.
const { COMPILED } = await import('./open.js');
const off = (name) => /^(0|false|no|off)$/i.test(process.env[name] || '');
let checkUpdate;
let installUpdate;
if (COMPILED && !off('KEEL_CHECK_UPDATES')) {
  const update = await import('./update.js');
  const { config } = await import('../server/config.js');
  const last = update.lastCheckStore(path.join(config.dataDir, 'update-check.json'));
  checkUpdate = async () => {
    const result = await update.checkForUpdate(await last.load());
    await last.save(result.checked).catch(() => {});
    return result;
  };
  if (!off('KEEL_AUTO_UPDATE')) installUpdate = update.installUpdate;
  // What an earlier update moved aside; quietly, and it doesn't hold up the start.
  update.removeOldExecutables();
}

// Draw on the alternate screen, like a full-screen app, and give the terminal back untouched on exit.
process.stdout.write('\x1b[?1049h\x1b[H');
process.on('exit', () => process.stdout.write('\x1b[?1049l'));

const app = render(React.createElement(App, { keel, checkUpdate, installUpdate }), { exitOnCtrlC: false, patchConsole: false });
await app.waitUntilExit();
process.exit(0);
