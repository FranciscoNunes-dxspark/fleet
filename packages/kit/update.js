// Whether a newer release of the app has come out, and installing it. Every app releases from the one
// repository, FranciscoNunes-dxspark/fleet, under tags of its own (`splice-v1.2.3`, `keel-v0.1.28`), so
// the newest release is the newest of the app's tags, not GitHub's "latest". Asked at most once a day,
// in the background, and silent when it can't tell (offline, no gh). The repository is private, which
// GitHub answers with a 404 to anyone not signed in, so a failed request asks again through the gh
// CLI, with the sign-in it already has; downloads go the same way. Nothing about the machine, a
// connection or a repository is sent: the user agent is "<app>/<version>".
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { app } from './app.js';

export const REPO = 'FranciscoNunes-dxspark/fleet';
const DAY = 24 * 60 * 60 * 1000;
const CHECKSUMS = 'SHA256SUMS.txt';
const DOWNLOAD_MS = 10 * 60 * 1000;

/** The prefix of this app's release tags: "splice-v". */
export const tagPrefix = (name = app().name) => `${name}-v`;

/** The tag of `version`'s release: "splice-v1.2.3". */
export const tagOf = (version, name = app().name) => `${tagPrefix(name)}${String(version).replace(/^v/, '')}`;

/** This app's releases on GitHub, for people: the release list filtered to its tags. */
export const releasesUrl = (name = app().name) => `https://github.com/${REPO}/releases?q=${encodeURIComponent(tagPrefix(name))}&expanded=true`;

/** The page of `version`'s release. */
export const releaseUrl = (version, name = app().name) => `https://github.com/${REPO}/releases/tag/${tagOf(version, name)}`;

// The release files, by Bun's target (scripts/build.js) and by Node's platform-arch (installing).
const PLATFORMS = [
  ['bun-windows-x64', 'win32-x64', 'windows-x64.exe'],
  ['bun-linux-x64', 'linux-x64', 'linux-x64'],
  ['bun-linux-arm64', 'linux-arm64', 'linux-arm64'],
  ['bun-darwin-x64', 'darwin-x64', 'macos-x64'],
  ['bun-darwin-arm64', 'darwin-arm64', 'macos-arm64'],
];

/** Bun's build targets and the release file each makes: { 'bun-linux-x64': 'splice-linux-x64', … }. */
export const buildTargets = (name = app().name) => Object.fromEntries(PLATFORMS.map(([bun, , file]) => [bun, `${name}-${file}`]));

/** The release file that runs on `platform` and `arch`, or null if there's none. */
export function assetName(platform = process.platform, arch = process.arch, name = app().name) {
  const found = PLATFORMS.find(([, node]) => node === `${platform}-${arch}`);
  return found ? `${name}-${found[2]}` : null;
}

/** "v1.2.3" or "1.2.3" → [1, 2, 3]; anything else → null. Pre-release suffixes are ignored. */
export function parseVersion(s) {
  const m = String(s ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

/** Compares two "1.2.3" versions (a leading v is fine); a pre-release sorts before its release. Unreadable ones count as equal. */
export function compareVersions(a, b) {
  const parse = (v) => String(v ?? '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(-.+)?$/);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (Boolean(x[4]) !== Boolean(y[4])) return x[4] ? -1 : 1;
  return 0;
}

/** Whether `latest` is a higher version than `current`. */
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** Off when the config says so (`checkUpdates: false`) or <APP>_NO_UPDATE_CHECK is set (to anything but 0). */
export function checksDisabled(config, env = process.env, name = app().name) {
  const flag = env[`${name.toUpperCase()}_NO_UPDATE_CHECK`];
  return config?.checkUpdates === false || (flag != null && flag !== '' && flag !== '0');
}

/** A check is due when there has been none, or the last one was a day ago or more. */
export function isDue(check, now = Date.now()) {
  return !check?.at || now - check.at >= DAY;
}

/**
 * The app's newest release in a list of GitHub's releases (as /repos/…/releases answers): not a
 * draft or a pre-release, its tag `<app>-v<version>`, highest version first. Null when there's none.
 */
export function newestRelease(releases, name = app().name) {
  const prefix = tagPrefix(name);
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    if (r?.draft || r?.prerelease || typeof r?.tag_name !== 'string' || !r.tag_name.startsWith(prefix)) continue;
    const version = r.tag_name.slice(prefix.length);
    if (!/^\d+\.\d+\.\d+$/.test(version)) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, release: r };
  }
  return best;
}

/** Runs the GitHub CLI, resolving with its stdout; rejects with its first line of error output. */
function gh(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { signal, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      reject(new Error(err.code === 'ENOENT' ? "gh isn't installed" : (stderr || err.message).trim().split('\n')[0]));
    });
  });
}

const RELEASES_PATH = `repos/${REPO}/releases?per_page=100`;

/** The repository's releases through gh, signed in as you: how a private repository's are seen. Null when gh can't. */
export async function ghReleases({ signal } = {}) {
  try {
    return JSON.parse(await gh(['api', RELEASES_PATH], { signal: signal ?? AbortSignal.timeout(15000) }));
  } catch {
    return null;
  }
}

function shape(found, { signedIn, name }) {
  if (!found) return null;
  const { version, release } = found;
  const file = (release.assets ?? []).find((a) => a.name === assetName(undefined, undefined, name));
  return { version, url: release.html_url || releaseUrl(version, name), download: file?.browser_download_url ?? null, signedIn };
}

/**
 * The app's newest release: { version, url, download, signedIn }, `download` being this machine's
 * file when the release has one, `signedIn` when only gh could see it. Null when neither finds one.
 * Throws when GitHub answers something other than a list or a 404 and gh can't help either.
 */
export async function fetchLatest({ current, signal, fetchImpl = fetch, ghImpl = ghReleases, name = app().name } = {}) {
  let failure = null;
  try {
    const res = await fetchImpl(`https://api.github.com/${RELEASES_PATH}`, {
      signal: signal ?? AbortSignal.timeout(5000),
      headers: { accept: 'application/vnd.github+json', 'user-agent': `${name}/${current ?? app().VERSION}` },
    });
    if (res.ok) return shape(newestRelease(await res.json(), name), { signedIn: false, name });
    if (res.status !== 404) failure = new Error(`GitHub answered ${res.status} ${res.statusText ?? ''}`.trim());
  } catch (e) {
    if (signal?.aborted) throw e;
    failure = e;
    // Offline or blocked; gh may still get through.
  }
  const listed = await ghImpl({ signal });
  if (listed == null && failure) throw failure;
  return shape(newestRelease(listed, name), { signedIn: true, name });
}

/** The newest release as { version, url }. Throws if it can't be found out. */
export async function fetchLatestRelease(opts = {}) {
  const latest = await fetchLatest(opts);
  if (!latest) throw new Error('No release found');
  return { version: latest.version, url: latest.url };
}

/**
 * What the last check found (`last`: { at, latest, url } from the config), asking again when it's
 * a day old. Resolves with { checked, newer }; `checked` goes back into the config.
 */
export async function checkForUpdate(last, { current = app().VERSION, now = Date.now(), fetchLatest = fetchLatestRelease } = {}) {
  let checked = last;
  // A check from the future (the clock moved back) counts as stale too.
  if (!last?.latest || !(now - last.at >= 0 && now - last.at < DAY)) {
    const latest = await fetchLatest();
    checked = { at: now, latest: latest.version, url: latest.url };
  }
  return { checked, newer: compareVersions(checked.latest, current) > 0 };
}

/** Where the last check's answer is kept between starts, for an app without a config to keep it in: a small JSON file. */
export function lastCheckStore(file) {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch {
        return undefined;
      }
    },
    async save(checked) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(checked)}\n`);
    },
  };
}

/** The folder of the checkout this copy runs from: the app's own folder (where its package.json is). */
export function checkoutRoot() {
  const pkg = app().packageUrl;
  return pkg ? dirname(fileURLToPath(pkg)) : process.cwd();
}

/** What to do to get `latest`, for the way this copy was installed. */
export function updateAdvice({ latest, current, compiled, root = checkoutRoot() }) {
  const { name, title } = app();
  if (!latest) return [`No release found at ${releasesUrl()}. It's private, so the check needs gh signed in with access (gh auth login). You have ${current}.`];
  if (!isNewer(latest.version, current)) return [`${title} ${current} is the latest version.`];
  const lines = [`${title} ${latest.version} is out (you have ${current}).`];
  if (compiled && latest.signedIn) {
    // A private release's files need a signed-in download, which gh does.
    lines.push(`Download it: gh release download ${tagOf(latest.version, name)} --repo ${REPO} --pattern ${assetName()}`);
  } else if (compiled) {
    lines.push(latest.download ? `Download ${assetName()}: ${latest.download}` : `Download it from ${latest.url}`);
    lines.push(`Then replace this executable with it (quit ${title} first).`);
  } else {
    lines.push(`From the checkout: cd "${root}" && git pull && npm install`);
    lines.push(`What's new: ${latest.url}`);
  }
  return lines;
}

/** Opens a URL in the default browser. */
export function openUrl(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, { windowsHide: true }, () => {});
}

/** sha256sum's output ("<hash>  <name>", or "<hash> *<name>" for binary mode) as a Map from name to hash. */
export function parseChecksums(text) {
  const out = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/** Where release `version`'s file `file` downloads from. */
export const downloadUrl = (version, file, name = app().name) => `https://github.com/${REPO}/releases/download/${tagOf(version, name)}/${file}`;

/** Downloads release `version`'s files `names` into `dir`: straight from GitHub, or through gh while the repository is private. */
async function downloadAssets(version, names, dir, { signal } = {}) {
  const limit = signal ? AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_MS)]) : AbortSignal.timeout(DOWNLOAD_MS);
  try {
    for (const name of names) {
      const res = await fetch(downloadUrl(version, name), { headers: { 'user-agent': `${app().name}/${app().VERSION}` }, signal: limit });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(join(dir, name)));
    }
    return;
  } catch (e) {
    if (signal?.aborted) throw e;
    // A private repository answers 404; gh has a sign-in that can read it.
  }
  await gh(['release', 'download', tagOf(version), '--repo', REPO, '--dir', dir, '--clobber', ...names.flatMap((n) => ['--pattern', n])], { signal: limit });
}

/** The version an executable says it is (`splice --version`), or null if it doesn't answer. */
function versionOf(exe) {
  const said = new RegExp(`${app().name} (\\S+)`);
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { timeout: 10000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : (said.exec(stdout)?.[1] ?? null)));
  });
}

/** The prefix of the download folders next to the executable: ".splice-update-". */
const workPrefix = () => `.${app().name}-update-`;

/**
 * Replaces the executable `exe` with release `version`, which then runs from the next start. The
 * download goes into a folder next to `exe` (the same disk, so the swap is a rename) and must match the
 * release's SHA256SUMS.txt. Windows won't overwrite a running program but will rename it, so there the
 * old one moves aside to `<exe>.old.<time>`, for removeOldExecutables to delete on a later start.
 * Resolves with "installed", or "already" if `exe` is that version already (another window of the app
 * got there first). Throws, with `exe` as it was, if anything goes wrong: a folder it can't write to,
 * no download, a checksum that doesn't match.
 */
export async function installUpdate(
  version,
  { exe = process.execPath, platform = process.platform, arch = process.arch, signal, download = downloadAssets, installed = versionOf } = {},
) {
  const name = assetName(platform, arch);
  if (!name) throw new Error(`there's no release build for ${platform} ${arch}`);
  if ((await installed(exe)) === version) return 'already';
  const work = await mkdtemp(join(dirname(exe), workPrefix()));
  try {
    await download(version, [name, CHECKSUMS], work, { signal });
    const want = parseChecksums(await readFile(join(work, CHECKSUMS), 'utf8')).get(name);
    if (!want) throw new Error(`the release has no checksum for ${name}`);
    const file = join(work, name);
    const got = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
    if (got !== want) throw new Error(`the download of ${name} doesn't match its checksum`);
    if (platform !== 'win32') {
      await chmod(file, 0o755);
      // Replaces it in one step; a copy still running keeps the one it started from.
      await rename(file, exe);
    } else {
      const aside = `${exe}.old.${Date.now()}`;
      await rename(exe, aside);
      try {
        await rename(file, exe);
      } catch (e) {
        await rename(aside, exe);
        throw e;
      }
    }
    return 'installed';
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Deletes what earlier updates left next to `exe`: old executables moved aside (one still running stays
 * until a later start) and download folders of updates that were interrupted (an hour old, so a
 * download in another window right now isn't touched).
 */
export async function removeOldExecutables(exe = process.execPath, { now = Date.now() } = {}) {
  const dir = dirname(exe);
  const old = `${basename(exe)}.old.`;
  const work = workPrefix();
  for (const f of await readdir(dir).catch(() => [])) {
    const path = join(dir, f);
    if (f.startsWith(old)) await rm(path, { force: true }).catch(() => {});
    else if (f.startsWith(work)) {
      const s = await stat(path).catch(() => null);
      if (s && now - s.mtimeMs > 60 * 60 * 1000) await rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }
}
