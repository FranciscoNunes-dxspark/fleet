// The terminal app's own updates (cli/update.js), as Tiller's: comparing versions, asking at most
// once a day, swapping the executable only for a matching download, tidying up, and what the app
// says. Nothing here goes online or replaces a real executable.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
const { assetName, checkForUpdate, compareVersions, installUpdate, lastCheckStore, parseChecksums, removeOldExecutables } = await import('../cli/update.js');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');

test('versions compare by number, with pre-releases before their release', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('v1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('v0.2.0', '0.2.0'), 0);
  assert.ok(compareVersions('0.3.0-beta.1', '0.3.0') < 0);
  assert.equal(compareVersions('nightly', '0.2.0'), 0);
});

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

test('the release file for each platform, and the checksums file', () => {
  assert.equal(assetName('win32', 'x64'), 'keel-windows-x64.exe');
  assert.equal(assetName('darwin', 'arm64'), 'keel-macos-arm64');
  assert.equal(assetName('linux', 'arm64'), 'keel-linux-arm64');
  assert.equal(assetName('win32', 'arm64'), null);
  const a = 'a'.repeat(64);
  const sums = parseChecksums(`${a}  keel-linux-x64\r\n${'B'.repeat(64)} *keel-windows-x64.exe\nnot a line\n`);
  assert.deepEqual([...sums], [['keel-linux-x64', a], ['keel-windows-x64.exe', 'b'.repeat(64)]]);
});

test('installing an update swaps the executable, only with a matching checksum, and tidies up after', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-install-'));
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  // Stands in for GitHub: the release's files, written where installUpdate asks.
  const release = (content, sum = sha(content)) => async (version, names, into) => {
    assert.equal(version, '0.3.0');
    writeFileSync(join(into, names[0]), content);
    writeFileSync(join(into, names[1]), `${sum}  ${names[0]}\n`);
  };
  const leftovers = () => readdirSync(dir).filter((f) => f.startsWith('.keel-update-'));
  try {
    // Windows: the running one is renamed aside, and the new one takes its name.
    const exe = join(dir, 'keel.exe');
    writeFileSync(exe, 'old build');
    const win = { exe, platform: 'win32', arch: 'x64', installed: async () => '0.2.0' };
    assert.equal(await installUpdate('0.3.0', { ...win, download: release('new build') }), 'installed');
    assert.equal(readFileSync(exe, 'utf8'), 'new build');
    const aside = readdirSync(dir).filter((f) => f.startsWith('keel.exe.old.'));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(dir, aside[0]), 'utf8'), 'old build');
    assert.deepEqual(leftovers(), []);

    // A download that doesn't match its checksum leaves everything as it was.
    writeFileSync(exe, 'current');
    await assert.rejects(installUpdate('0.3.0', { ...win, download: release('tampered', sha('something else')) }), /doesn't match its checksum/);
    assert.equal(readFileSync(exe, 'utf8'), 'current');
    assert.deepEqual(leftovers(), []);

    // Already that version (another window installed it): nothing is downloaded.
    let downloads = 0;
    const counted = async (...args) => {
      downloads++;
      return release('x')(...args);
    };
    assert.equal(await installUpdate('0.3.0', { ...win, installed: async () => '0.3.0', download: counted }), 'already');
    assert.equal(downloads, 0);

    // macOS and Linux: a rename replaces it in one step, with nothing set aside.
    const unixExe = join(dir, 'keel');
    writeFileSync(unixExe, 'old build');
    await installUpdate('0.3.0', { exe: unixExe, platform: 'linux', arch: 'x64', installed: async () => '0.2.0', download: release('new build') });
    assert.equal(readFileSync(unixExe, 'utf8'), 'new build');
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('keel.old.')));

    await assert.rejects(installUpdate('0.3.0', { ...win, arch: 'arm64', download: release('x') }), /no release build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('old executables and abandoned downloads are removed, but not a download still going', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-old-'));
  try {
    const exe = join(dir, 'keel.exe');
    writeFileSync(exe, 'current');
    writeFileSync(join(dir, 'keel.exe.old.1700000000000'), 'old');
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    mkdirSync(join(dir, '.keel-update-stale'));
    mkdirSync(join(dir, '.keel-update-busy'));
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(join(dir, '.keel-update-stale'), twoHoursAgo, twoHoursAgo);
    await removeOldExecutables(exe);
    assert.deepEqual(readdirSync(dir).sort(), ['.keel-update-busy', 'keel.exe', 'notes.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
