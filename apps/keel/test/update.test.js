// The terminal app's own updates, through the kit's updater (packages/kit/update.js, tested there):
// asking at most once a day, keeping the answer between starts, and what the app says. Nothing here
// goes online or replaces a real executable.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The app runs on demo data, in a throwaway folder; the server's config reads these on import.
const dataDir = mkdtempSync(join(tmpdir(), 'keel-update-'));
process.env.AZDO_MOCK = '1';
process.env.AUTH_MODE = 'local';
process.env.DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { checkForUpdate, lastCheckStore } = await import('@fleet/kit/update.js');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');

test('asks at most once a day, only says "newer" for a newer release, and keeps the answer between starts', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  let asked = 0;
  const fetchLatest = async () => {
    asked++;
    return { version: '0.3.0', url: 'https://example.com/v0.3.0' };
  };
  const first = await checkForUpdate(undefined, { current: '0.2.0', now: 1000, fetchLatest });
  assert.deepEqual(first, { checked: { at: 1000, latest: '0.3.0', url: 'https://example.com/v0.3.0' }, newer: true });
  await checkForUpdate(first.checked, { current: '0.2.0', now: 1000 + DAY - 1, fetchLatest });
  assert.equal(asked, 1);
  assert.equal((await checkForUpdate(first.checked, { current: '0.3.0', now: 2000, fetchLatest })).newer, false);
  await checkForUpdate(first.checked, { current: '0.2.0', now: 1000 + DAY, fetchLatest });
  assert.equal(asked, 2);
  // A clock that went back doesn't keep an old answer forever.
  await checkForUpdate({ ...first.checked, at: 10 * DAY }, { current: '0.2.0', now: DAY, fetchLatest });
  assert.equal(asked, 3);

  const store = lastCheckStore(join(dataDir, 'nested', 'update-check.json'));
  assert.equal(await store.load(), undefined);
  await store.save(first.checked);
  assert.deepEqual(await store.load(), first.checked);
});

test('the app installs a newer release in the background, says when it can\'t, and can be told only to tell', async () => {
  const keel = openKeel();
  const checkUpdate = async () => ({ checked: { at: 5, latest: '9.9.9', url: 'https://example.com/latest' }, newer: true });
  const open = async (installUpdate, check, what) => {
    const app = render(React.createElement(App, { keel, poll: false, openUrl: () => {}, checkUpdate, installUpdate }));
    try {
      const end = Date.now() + 10000;
      while (!check(app.lastFrame() ?? '')) {
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}. Last frame:\n${app.lastFrame()}`);
        await new Promise((r) => setTimeout(r, 40));
      }
    } finally {
      app.unmount();
    }
  };
  const asked = [];
  await open(async (v) => asked.push(v), (f) => /Keel 9\.9\.9 is installed/.test(f), 'the installed note');
  assert.deepEqual(asked, ['9.9.9']);

  await open(async () => {
    throw new Error("can't write to C:\\Program Files\\Keel\nmore detail");
  }, (f) => /couldn't be installed: can't write to/.test(f) && /example\.com\/latest/.test(f), 'the failure note');

  // KEEL_AUTO_UPDATE=0: cli.jsx passes no installUpdate, so it only says a release is out.
  await open(undefined, (f) => /Keel 9\.9\.9 is out \(you have/.test(f), 'the release note');
});
