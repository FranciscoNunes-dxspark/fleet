// /update in the terminal app: it asks for the latest release now and installs it, through the
// `updater` cli.jsx passes the downloaded executable. Tests pass stubs, so nothing goes online.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-update-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');
const { VERSION } = await import('../cli/open.js');

let keel;
before(() => {
  keel = openKeel();
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

let lastApp = null;
const frame = () => lastApp.lastFrame() ?? '';
async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame()}`);
}

/** Opens the app with `updater`, types /update and waits for `what` to show. */
async function runUpdate(updater, done, what) {
  lastApp = render(React.createElement(App, { keel, poll: false, openUrl: () => {}, updater }));
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  for (const ch of '/update') {
    lastApp.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
  lastApp.stdin.write('\r');
  await until(() => frame().includes(done), what);
  return lastApp;
}

const checked = { at: 0, latest: '9.9.9', url: 'https://github.com/FranciscoNunes-dxspark/keel/releases/latest' };

test('/update installs a newer release, and says it starts next time', async () => {
  const installed = [];
  const app = await runUpdate({ check: async () => ({ checked, newer: true }), install: async (v) => installed.push(v) }, 'Keel 9.9.9 is installed. It starts the next time you open Keel.', 'the install');
  assert.deepEqual(installed, ['9.9.9']);
  // Asked again: it says so rather than installing twice.
  for (const ch of '/update') app.stdin.write(ch);
  app.stdin.write('\r');
  await until(() => frame().split('Keel 9.9.9 is installed').length > 2, 'the second answer');
  assert.deepEqual(installed, ['9.9.9']);
  app.unmount();
});

test('/update says when this is the latest version, and why an install failed', async () => {
  let app = await runUpdate({ check: async () => ({ checked: { ...checked, latest: VERSION }, newer: false }), install: async () => assert.fail('nothing to install') }, `Keel ${VERSION} is the latest version.`, 'the answer');
  app.unmount();
  app = await runUpdate({ check: async () => ({ checked, newer: true }), install: async () => { throw new Error("EACCES: can't write"); } }, "Keel 9.9.9 is out, but it couldn't be installed: EACCES", 'the failure');
  assert.match(frame(), /Download it from https:\/\/github\.com\//);
  app.unmount();
});

test('/update from a checkout says git pull', async () => {
  const app = await runUpdate(undefined, 'runs from a checkout: git pull updates it', 'the note');
  app.unmount();
});
