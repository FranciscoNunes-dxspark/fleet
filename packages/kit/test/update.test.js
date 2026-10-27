// The updater: one repository for every app (FranciscoNunes-dxspark/fleet), each app's releases
// under its own tags. Nothing here goes online or replaces a real executable: GitHub is a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureApp } from '../app.js';
import {
  REPO, assetName, buildTargets, checkForUpdate, checksDisabled, compareVersions, downloadUrl, fetchLatest, fetchLatestRelease, installUpdate,
  isDue, isNewer, newestRelease, parseChecksums, parseVersion, releasesUrl, removeOldExecutables, tagOf, tagPrefix, updateAdvice,
} from '../update.js';

configureApp({ name: 'splice', title: 'Splice', version: '0.2.0' });

// Windows can hold a just-renamed file for a moment.
const removeTemp = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

test('versions compare by number, with pre-releases before their release', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('v1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('v0.2.0', '0.2.0'), 0);
  assert.ok(compareVersions('0.3.0-beta.1', '0.3.0') < 0);
  assert.ok(compareVersions('0.3.0-beta.1', '0.2.0') > 0);
  assert.equal(compareVersions('nightly', '0.2.0'), 0);
  assert.equal(compareVersions(undefined, '0.2.0'), 0);
  assert.deepEqual(parseVersion('v1.10.0'), [1, 10, 0]);
  assert.equal(parseVersion('latest'), null);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('v0.2.0', '0.2.0'), false);
  assert.equal(isNewer('garbage', '0.1.0'), false);
});

test('a check is due once a day, and can be turned off by the config or <APP>_NO_UPDATE_CHECK', () => {
  const now = 10 * 86_400_000;
  assert.equal(isDue(null, now), true);
  assert.equal(isDue({ at: now - 3_600_000 }, now), false);
  assert.equal(isDue({ at: now - 86_400_000 }, now), true);
  assert.equal(checksDisabled({ checkUpdates: false }, {}), true);
  assert.equal(checksDisabled({}, { SPLICE_NO_UPDATE_CHECK: '1' }), true);
  assert.equal(checksDisabled({}, { SPLICE_NO_UPDATE_CHECK: '0' }), false);
  assert.equal(checksDisabled({}, { TRAWL_NO_UPDATE_CHECK: '1' }), false);
  assert.equal(checksDisabled({ checkUpdates: true }, {}), false);
});

test('asks at most once a day, and only says "newer" for a newer release', async () => {
  const DAY = 24 * 60 * 60 * 1000;
  let asked = 0;
  const fetchLatest = async () => {
    asked++;
    return { version: '0.3.0', url: 'https://example.com/v0.3.0' };
  };
  const first = await checkForUpdate(undefined, { current: '0.2.0', now: 1000, fetchLatest });
  assert.deepEqual(first, { checked: { at: 1000, latest: '0.3.0', url: 'https://example.com/v0.3.0' }, newer: true });
  assert.equal(asked, 1);
  const sameDay = await checkForUpdate(first.checked, { current: '0.2.0', now: 1000 + DAY - 1, fetchLatest });
  assert.equal(asked, 1);
  assert.equal(sameDay.newer, true);
  assert.equal((await checkForUpdate(first.checked, { current: '0.3.0', now: 2000, fetchLatest })).newer, false);
  await checkForUpdate(first.checked, { current: '0.2.0', now: 1000 + DAY, fetchLatest });
  assert.equal(asked, 2);
  // A clock that went back doesn't keep an old answer forever.
  await checkForUpdate({ ...first.checked, at: 10 * DAY }, { current: '0.2.0', now: DAY, fetchLatest });
  assert.equal(asked, 3);
});

test("the app's tags, release files and pages, from its name", () => {
  assert.equal(REPO, 'FranciscoNunes-dxspark/fleet');
  assert.equal(tagPrefix(), 'splice-v');
  assert.equal(tagOf('0.3.0'), 'splice-v0.3.0');
  assert.equal(tagOf('v0.3.0', 'keel'), 'keel-v0.3.0');
  assert.equal(downloadUrl('0.3.0', 'SHA256SUMS.txt'), 'https://github.com/FranciscoNunes-dxspark/fleet/releases/download/splice-v0.3.0/SHA256SUMS.txt');
  assert.equal(releasesUrl('trawl'), 'https://github.com/FranciscoNunes-dxspark/fleet/releases?q=trawl-v&expanded=true');
  assert.equal(assetName('win32', 'x64'), 'splice-windows-x64.exe');
  assert.equal(assetName('darwin', 'arm64'), 'splice-macos-arm64');
  assert.equal(assetName('linux', 'x64', 'hail'), 'hail-linux-x64');
  assert.equal(assetName('win32', 'arm64'), null);
  assert.deepEqual(buildTargets('bosun'), {
    'bun-windows-x64': 'bosun-windows-x64.exe',
    'bun-linux-x64': 'bosun-linux-x64',
    'bun-linux-arm64': 'bosun-linux-arm64',
    'bun-darwin-x64': 'bosun-macos-x64',
    'bun-darwin-arm64': 'bosun-macos-arm64',
  });
});

test('SHA256SUMS.txt is read as sha256sum writes it', () => {
  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);
  const sums = parseChecksums(`${a}  splice-linux-x64\r\n${b} *splice-windows-x64.exe\nnot a line\n`);
  assert.deepEqual([...sums], [
    ['splice-linux-x64', a],
    ['splice-windows-x64.exe', 'b'.repeat(64)],
  ]);
});

const rel = (tag, extra = {}) => ({ tag_name: tag, html_url: `https://github.com/${REPO}/releases/tag/${tag}`, draft: false, prerelease: false, assets: [], ...extra });
const LIST = [
  rel('trawl-v9.0.0'),
  rel('splice-v0.3.0', { assets: [{ name: assetName(), browser_download_url: 'https://example.test/splice' }] }),
  rel('splice-v0.10.0', { draft: true }),
  rel('splice-v0.4.0', { prerelease: true }),
  rel('splice-v0.2.9'),
  rel('keel-android-v120'),
  rel('splice-vnext'),
];

test("the newest of the app's own releases: other apps', drafts and pre-releases don't count", () => {
  assert.equal(newestRelease(LIST).version, '0.3.0');
  assert.equal(newestRelease(LIST, 'trawl').version, '9.0.0');
  assert.equal(newestRelease(LIST, 'keel'), null);
  assert.equal(newestRelease([rel('keel-v0.1.9'), rel('keel-v0.1.10'), rel('keel-android-v130')], 'keel').version, '0.1.10');
  assert.equal(newestRelease(null), null);
});

const reply = (status, body) => async (url, opts) => {
  assert.equal(url, `https://api.github.com/repos/${REPO}/releases?per_page=100`);
  assert.equal(opts.headers['user-agent'], 'splice/0.2.0');
  return { status, ok: status < 300, statusText: 'x', json: async () => body };
};

test("fetchLatest reads the repository's releases and picks this app's newest, and this machine's file", async () => {
  const latest = await fetchLatest({ fetchImpl: reply(200, LIST), ghImpl: async () => assert.fail('no need for gh') });
  assert.deepEqual(latest, { version: '0.3.0', url: `https://github.com/${REPO}/releases/tag/splice-v0.3.0`, download: 'https://example.test/splice', signedIn: false });
  assert.deepEqual(await fetchLatestRelease({ fetchImpl: reply(200, LIST) }), { version: '0.3.0', url: latest.url });
  assert.equal(await fetchLatest({ fetchImpl: reply(200, [rel('trawl-v1.0.0')]) }), null);
  await assert.rejects(fetchLatestRelease({ fetchImpl: reply(200, []) }), /No release found/);
});

test('a 404 (private), or no answer at all, asks again through gh', async () => {
  const viaGh = await fetchLatest({ fetchImpl: reply(404, {}), ghImpl: async () => [rel('splice-v0.5.0', { html_url: 'https://r' })] });
  assert.deepEqual(viaGh, { version: '0.5.0', url: 'https://r', download: null, signedIn: true });
  const offline = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  assert.equal((await fetchLatest({ fetchImpl: offline, ghImpl: async () => LIST })).version, '0.3.0');
  assert.equal(await fetchLatest({ fetchImpl: reply(404, {}), ghImpl: async () => null }), null);
  await assert.rejects(fetchLatest({ fetchImpl: offline, ghImpl: async () => null }), /ENOTFOUND/);
  await assert.rejects(fetchLatest({ fetchImpl: reply(403, {}), ghImpl: async () => null }), /GitHub answered 403/);
});

test('the advice depends on how the app was installed', () => {
  const latest = { version: '0.3.0', url: 'https://r', download: 'https://d' };
  assert.match(updateAdvice({ latest: null, current: '0.2.0' })[0], /gh auth login/);
  const signedIn = updateAdvice({ latest: { ...latest, signedIn: true }, current: '0.2.0', compiled: true });
  assert.equal(signedIn[1], `Download it: gh release download splice-v0.3.0 --repo ${REPO} --pattern ${assetName()}`);
  assert.deepEqual(updateAdvice({ latest, current: '0.3.0' }), ['Splice 0.3.0 is the latest version.']);
  const exe = updateAdvice({ latest, current: '0.2.0', compiled: true });
  assert.equal(exe[0], 'Splice 0.3.0 is out (you have 0.2.0).');
  assert.match(exe[1], /https:\/\/d/);
  assert.equal(exe[2], 'Then replace this executable with it (quit Splice first).');
  const src = updateAdvice({ latest, current: '0.2.0', compiled: false, root: 'C:\\Team\\fleet\\apps\\splice' });
  assert.equal(src[1], 'From the checkout: cd "C:\\Team\\fleet\\apps\\splice" && git pull && npm install');
});

test('installing an update swaps the executable, only with a matching checksum, and tidies up after', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-install-'));
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  // Stands in for GitHub: the release's files, written where installUpdate asks.
  const release = (content, sum = sha(content)) => async (version, names, into) => {
    assert.equal(version, '0.3.0');
    writeFileSync(join(into, names[0]), content);
    writeFileSync(join(into, names[1]), `${sum}  ${names[0]}\n`);
  };
  const leftovers = () => readdirSync(dir).filter((f) => f.startsWith('.splice-update-'));
  try {
    // Windows: the running one is renamed aside, and the new one takes its name.
    const exe = join(dir, 'splice.exe');
    writeFileSync(exe, 'old build');
    const win = { exe, platform: 'win32', arch: 'x64', installed: async () => '0.2.0' };
    assert.equal(await installUpdate('0.3.0', { ...win, download: release('new build') }), 'installed');
    assert.equal(readFileSync(exe, 'utf8'), 'new build');
    const aside = readdirSync(dir).filter((f) => f.startsWith('splice.exe.old.'));
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
    const unixExe = join(dir, 'splice');
    writeFileSync(unixExe, 'old build');
    await installUpdate('0.3.0', { exe: unixExe, platform: 'linux', arch: 'x64', installed: async () => '0.2.0', download: release('new build') });
    assert.equal(readFileSync(unixExe, 'utf8'), 'new build');
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('splice.old.')));

    await assert.rejects(installUpdate('0.3.0', { ...win, arch: 'arm64', download: release('x') }), /no release build/);
  } finally {
    removeTemp(dir);
  }
});

test('an update also replaces the files beside the executable it names, where they are, and never fails over them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-extras-'));
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  // The release has the build and the icon, both in its checksums, unless a test says the icon is bad or missing.
  const release = ({ icon = 'new icon', iconSum = sha(icon), listed = true, broken = false } = {}) => async (version, names, into) => {
    for (const n of names) {
      if (n === 'SHA256SUMS.txt') writeFileSync(join(into, n), `${sha('new build')}  splice-windows-x64.exe\n${listed ? `${iconSum}  splice.ico\n` : ''}`);
      else if (n === 'splice.ico') {
        if (broken) throw new Error('GitHub answered 404');
        writeFileSync(join(into, n), icon);
      } else writeFileSync(join(into, n), 'new build');
    }
  };
  try {
    const exe = join(dir, 'splice.exe');
    const win = { exe, platform: 'win32', arch: 'x64', installed: async () => '0.2.0', extras: ['splice.ico'] };
    const fresh = () => {
      writeFileSync(exe, 'old build');
      writeFileSync(join(dir, 'splice.ico'), 'old icon');
    };
    // The icon an install put there is replaced.
    fresh();
    assert.equal(await installUpdate('0.3.0', { ...win, download: release() }), 'installed');
    assert.equal(readFileSync(join(dir, 'splice.ico'), 'utf8'), 'new icon');
    // A copy that doesn't match its checksum, a release without it, or a failed download: the icon stays, the update still happens.
    for (const options of [{ iconSum: sha('other') }, { listed: false }, { broken: true }]) {
      fresh();
      assert.equal(await installUpdate('0.3.0', { ...win, download: release(options) }), 'installed');
      assert.equal(readFileSync(exe, 'utf8'), 'new build');
      assert.equal(readFileSync(join(dir, 'splice.ico'), 'utf8'), 'old icon');
    }
    // No icon beside it (not an installed copy): none is created, and nothing is downloaded for it.
    fresh();
    rmSync(join(dir, 'splice.ico'));
    const asked = [];
    await installUpdate('0.3.0', { ...win, download: async (v, names, into, o) => (asked.push(names), release()(v, names, into, o)) });
    assert.ok(!readdirSync(dir).includes('splice.ico'));
    assert.deepEqual(asked, [['splice-windows-x64.exe', 'SHA256SUMS.txt']]);
  } finally {
    removeTemp(dir);
  }
});

test('old executables and abandoned downloads are removed, but not a download still going', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-old-'));
  try {
    const exe = join(dir, 'splice.exe');
    writeFileSync(exe, 'current');
    writeFileSync(join(dir, 'splice.exe.old.1700000000000'), 'old');
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    mkdirSync(join(dir, '.splice-update-stale'));
    mkdirSync(join(dir, '.splice-update-busy'));
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(join(dir, '.splice-update-stale'), twoHoursAgo, twoHoursAgo);
    await removeOldExecutables(exe);
    assert.deepEqual(readdirSync(dir).sort(), ['.splice-update-busy', 'notes.txt', 'splice.exe']);
  } finally {
    removeTemp(dir);
  }
});
