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
keel login [address]
keel logout

Keel in the terminal: the Inbox, pull requests, pipelines, work items and production,
with the same tracked projects and settings as the web app.

  login    sign in with your account on your team's Keel (keel.example.com unless you name
           another), in the browser. Keel then works through it, as you.
  logout   sign this terminal out of that Keel
  --demo   the demo organization, no credentials needed

Without signing in to a Keel, it works with the Azure DevOps organization in
${ENV_FILE}: it signs in with AZDO_PAT from that file, or else with the Azure CLI
(az login). With nothing set, it asks on start and saves the answers there.
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
const isOn = (v) => /^(1|true|yes)$/i.test(v || '');

const remote = await import('./remote.js');
const { saveEnvSettings } = await import('./setup.js');
const { openUrl } = await import('./open.js');
// Straight to the streams: from the sign-in on, console.* goes to /log (log.js).
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const say = (message) => process.stdout.write(`${message}\n`);

/** Signs in to the Keel at `server` through the browser and saves it for next time. */
async function signIn(server) {
  try {
    const { token, user } = await remote.deviceLogin({ server, openUrl: interactive ? openUrl : undefined });
    saveEnvSettings(ENV_FILE, [`KEEL_SERVER=${server}`, `KEEL_TOKEN=${token}`]);
    say(`\n\x1b[38;2;255;138;101m●\x1b[39m Signed in as ${user.name} (${user.email}). The sign-in is kept in ${ENV_FILE}.`);
  } catch (e) {
    fail(`\nCouldn't sign in: ${e.message}`);
  }
}

if (args[0] === 'logout') {
  const server = process.env.KEEL_SERVER?.trim();
  if (!server || !process.env.KEEL_TOKEN?.trim()) {
    say('This terminal isn’t signed in to a Keel server.');
    process.exit(0);
  }
  // Signed out on the web already, or the server is out of reach: forget it here all the same.
  await remote.keelClient(server, process.env.KEEL_TOKEN.trim()).call('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  saveEnvSettings(ENV_FILE, ['KEEL_SERVER=', 'KEEL_TOKEN=']);
  say(`Signed out of Keel at ${server}.`);
  process.exit(0);
}

if (args[0] === 'login') {
  const server = remote.serverUrlFrom(args[1] || process.env.KEEL_SERVER || remote.DEFAULT_SERVER);
  if (!server) fail(`That isn't a Keel address: ${args[1]}. Try keel login https://keel.example.com.`);
  await signIn(server);
}

// Signed in to a Keel server (or setting one up below): it does the Azure DevOps side.
let server = !demo && remote.serverUrlFrom(process.env.KEEL_SERVER);
if (demo) process.env.AZDO_MOCK = '1';
else if (!server && !process.env.AZDO_ORG_URL?.trim() && !isOn(process.env.AZDO_MOCK)) {
  if (!interactive) fail(`Nothing to connect to: run keel login to use your team's Keel, or set AZDO_ORG_URL=https://dev.azure.com/<org> in ${ENV_FILE}, or try keel --demo.`);
  // First run: ask, and save the answers for next time (setup.js).
  const { firstRunSetup } = await import('./setup.js');
  try {
    const answer = await firstRunSetup({ envFile: ENV_FILE });
    if (answer === 'demo') process.env.AZDO_MOCK = '1';
    if (answer === 'keel') server = remote.serverUrlFrom(process.env.KEEL_SERVER);
  } catch (e) {
    if (e.cancelled) process.exit(130);
    fail(`Couldn't save the settings: ${e.message}`);
  }
}
if (!server && !isOn(process.env.AZDO_MOCK) && !process.env.AZDO_PAT?.trim()) process.env.AZDO_AUTH ||= 'az';

if (!interactive) fail('keel needs an interactive terminal.');

const { captureConsole } = await import('./log.js');
captureConsole();
let keel;
if (server) {
  if (!process.env.KEEL_TOKEN?.trim()) await signIn(server);
  const connect = () => remote.connectKeel({ server, token: process.env.KEEL_TOKEN.trim() });
  try {
    keel = await connect();
  } catch (e) {
    if (e.code !== 'signin-required') fail(e.message);
    // The sign-in ended (signed out on the web, a new password, 90 days unused): sign in again.
    say(e.message);
    await signIn(server);
    keel = await connect().catch((again) => fail(again.message));
  }
} else {
  const { openKeel } = await import('./service.js');
  try {
    keel = openKeel();
  } catch (e) {
    fail(e.message);
  }
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

// Clicks, the wheel and drag-to-copy, where the terminal can report them (mouse.js); App turns reporting
// on unless this computer's Settings turned it off. Set up before rendering, so mouse reports never
// reach Ink as keys, and Ink draws through the mouse's stdout, which keeps the frames to select text from.
const { terminalMouse } = await import('./mouse.js');
const mouse = await terminalMouse(process.stdin, process.stdout);
const app = render(React.createElement(App, { keel, checkUpdate, installUpdate, mouse }), { exitOnCtrlC: false, patchConsole: false, stdout: mouse?.stdout ?? process.stdout });
await app.waitUntilExit();
process.exit(0);
