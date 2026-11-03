// Finding a folder's manifests and reading the packages in them: npm's package-lock.json (and
// npm-shrinkwrap.json), Yarn's yarn.lock and pnpm's pnpm-lock.yaml (jslocks.js), NuGet's
// packages.lock.json, and a .NET project's PackageReferences when it has no lock file
// (Directory.Packages.props giving the versions under central package management). The parsers take
// text and are pure; `scan` is the one that reads the disk.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { lockFrameworks, projectFrameworks } from './frameworks.js';
import { parsePnpmLock, parseYarnLock, isBerryLock, pnpmWorkspaces, yarnWorkspaces } from './jslocks.js';
import { escape, keyOf, lineOf, parseNpmLock, parseNugetLock, requiredPeers } from '@fleet/kit/lockfiles.js';

// The parsers of npm's and NuGet's lock files are the kit's (Keel reads them too).
export { keyOf, parseNpmLock, parseNugetLock, requiredPeers };

// Folders never worth going into: what installs, builds and editors make.
const SKIP = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', 'TestResults', 'artifacts']);
const PROJECT = /\.(cs|fs|vb)proj$/i;
export const MAX_DEPTH = 6;
export const MAX_MANIFESTS = 200;

/**
 * The Node a project says it runs on: package.json's engines.node (its lowest version is what it
 * promises), else .nvmrc or .node-version in its folder or one above, up to `root`. { range, from } or
 * { version, from }, or null when nothing says.
 */
export function projectNode(dir, root, packageJson = null) {
  const engines = packageJson?.engines?.node;
  if (typeof engines === 'string' && engines.trim()) return { range: engines.trim(), from: 'engines.node in package.json' };
  for (let d = dir; ; d = dirname(d)) {
    for (const name of ['.nvmrc', '.node-version']) {
      const file = join(d, name);
      if (!existsSync(file)) continue;
      try {
        const v = readFileSync(file, 'utf8').trim().replace(/^v/i, '');
        // lts/*, node and the like name no version.
        if (/^\d+(\.\d+){0,2}$/.test(v)) return { version: v, from: shortPath(root, file) };
      } catch {}
    }
    if (d === root || dirname(d) === d || relative(root, d).startsWith('..')) return null;
  }
}

/** The frameworks a packages.lock.json was restored for (its `dependencies` keys), as short names. */
export const nugetLockFrameworks = (text) => lockFrameworks(Object.keys(JSON.parse(text.replace(/^\uFEFF/, '')).dependencies ?? {}));

const attr = (attrs, name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)?.[1];
const child = (body, name) => (body ? new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(body)?.[1] : undefined);

/** An exact version from what a project asks for: 1.2.3 and [1.2.3] are; a range or a wildcard (1.2.*) is not, and is null. */
export function exactVersion(v) {
  const s = String(v ?? '').trim().replace(/^\[([^,\]]+)\]$/, '$1');
  return /^\d+(\.\d+)*(-[\w.]+)?$/.test(s) ? s : null;
}

/** Directory.Packages.props, as text: { name (lower case): version }, central package management's versions. */
export function parseCentralVersions(text) {
  const out = {};
  for (const m of String(text).matchAll(/<PackageVersion\s+([^>]*?)\/?>/gi)) {
    const name = attr(m[1], 'Include');
    const version = attr(m[1], 'Version');
    if (name && version) out[name.toLowerCase()] = version;
  }
  return out;
}

/**
 * A .csproj (or .fsproj, .vbproj), as text: its PackageReferences, all direct. Only these: what they
 * bring in is in a packages.lock.json, which `RestorePackagesWithLockFile` makes. A version from
 * `central` (parseCentralVersions) when the reference has none; one that isn't exact is left out, with
 * its name in `inexact`.
 */
export function parseProject(text, central = {}) {
  const packages = [];
  const inexact = [];
  for (const m of String(text).matchAll(/<PackageReference\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi)) {
    const name = attr(m[1], 'Include') ?? attr(m[1], 'Update');
    if (!name) continue;
    const asked = attr(m[1], 'VersionOverride') ?? attr(m[1], 'Version') ?? child(m[2], 'VersionOverride') ?? child(m[2], 'Version') ?? central[name.toLowerCase()];
    const version = exactVersion(asked);
    if (!version) {
      inexact.push(name);
      continue;
    }
    packages.push({ ecosystem: 'NuGet', name, version, direct: true, dev: false, line: lineOf(text, new RegExp(`Include\\s*=\\s*"${escape(name)}"`, 'i')) });
  }
  return { packages, inexact };
}

/** A JSON file, or null when it isn't there or can't be read. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Directory.Packages.props in `dir` or the nearest folder above it, up to `root`: its versions, or {}. */
function centralFor(dir, root) {
  for (let d = dir; ; d = dirname(d)) {
    const file = join(d, 'Directory.Packages.props');
    if (existsSync(file)) {
      try {
        return parseCentralVersions(readFileSync(file, 'utf8'));
      } catch {
        return {};
      }
    }
    if (d === root || dirname(d) === d) return {};
  }
}

/**
 * The folders a package.json's `workspaces` names (an array, or Yarn's { packages }): a plain folder,
 * or every folder in one (`packages/*`, `packages/**` taken as the same). Other patterns are left out.
 */
export function workspaceFolders(dir, packageJson) {
  const w = packageJson?.workspaces;
  const patterns = Array.isArray(w) ? w : Array.isArray(w?.packages) ? w.packages : [];
  const out = [];
  for (const raw of patterns) {
    const p = String(raw).replace(/^\.\//, '').replace(/\/+$/, '');
    const star = /^(.*?)\/\*{1,2}$/.exec(p);
    if (star && !star[1].includes('*')) {
      try {
        for (const e of readdirSync(join(dir, ...star[1].split('/')), { withFileTypes: true })) if (e.isDirectory()) out.push(join(dir, ...star[1].split('/'), e.name));
      } catch {}
    } else if (p && !p.includes('*')) out.push(join(dir, ...p.split('/')));
  }
  return out;
}

/** The manifest files under `root`, as paths: lock files, and .NET projects without one beside them. */
export function findManifests(root, { depth = MAX_DEPTH, max = MAX_MANIFESTS } = {}) {
  const found = [];
  const walk = (dir, level) => {
    if (found.length >= max) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    // One lock file a folder: npm's when there are several (it's what Bilge has always read there).
    const lock = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'].find((n) => names.has(n));
    if (lock) found.push(join(dir, lock));
    else if (names.has('package.json')) found.push(join(dir, 'package.json'));
    if (names.has('packages.lock.json')) found.push(join(dir, 'packages.lock.json'));
    else for (const n of [...names].filter((n) => PROJECT.test(n)).sort()) found.push(join(dir, n));
    if (level >= depth) return;
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) walk(join(dir, e.name), level + 1);
    }
  };
  walk(root, 0);
  return found.slice(0, max);
}

/** A path under `root` as Bilge shows it: relative, with forward slashes on every system. */
export const shortPath = (root, file) => relative(root, file).split(sep).join('/') || basename(file);

/**
 * One manifest read: { file, path, ecosystem, kind, packages, note? }. A package.json with no lock file
 * beside it has no packages (its ranges aren't versions), and says so; so does a lock file that can't
 * be read.
 */
export function readManifest(root, file) {
  const name = basename(file);
  const path = shortPath(root, file);
  const base = { file, path, dir: dirname(file) };
  try {
    const text = readFileSync(file, 'utf8');
    if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json') {
      // The workspaces it covers: its entries outside node_modules.
      const lock = JSON.parse(text);
      const workspaces = Object.keys(lock.packages ?? {}).filter((k) => k && !k.includes('node_modules/'));
      const node = projectNode(dirname(file), root, readJson(join(dirname(file), 'package.json')) ?? lock.packages?.[''] ?? null);
      return { ...base, ecosystem: 'npm', kind: 'lock', packages: parseNpmLock(text), workspaces: workspaces.map((w) => join(dirname(file), ...w.split('/'))), ...(node ? { node } : {}) };
    }
    if (name === 'yarn.lock' || name === 'pnpm-lock.yaml') {
      const own = readJson(join(dirname(file), 'package.json'));
      const node = projectNode(dirname(file), root, own);
      if (name === 'pnpm-lock.yaml') {
        const workspaces = pnpmWorkspaces(text).filter((w) => w !== '.').map((w) => join(dirname(file), ...w.split('/')));
        return { ...base, ecosystem: 'npm', kind: 'lock', tool: 'pnpm', packages: parsePnpmLock(text), workspaces, ...(node ? { node } : {}) };
      }
      // Yarn 1 doesn't list the workspaces: their package.json files say what each asks for.
      const berry = isBerryLock(text);
      const workspaces = berry ? yarnWorkspaces(text).filter((w) => w !== '.').map((w) => join(dirname(file), ...w.split('/'))) : workspaceFolders(dirname(file), own);
      const packageJsons = [own, ...workspaces.map((w) => readJson(join(w, 'package.json')))];
      return { ...base, ecosystem: 'npm', kind: 'lock', tool: 'yarn', berry, packages: parseYarnLock(text, packageJsons), workspaces, ...(node ? { node } : {}) };
    }
    if (name === 'package.json') {
      // A workspace's own package.json is covered by the root's lock file.
      return { ...base, ecosystem: 'npm', kind: 'manifest', packages: [], note: 'no package-lock.json: npm install makes one' };
    }
    if (name === 'packages.lock.json') {
      const project = readdirSync(dirname(file)).find((n) => PROJECT.test(n));
      return { ...base, ecosystem: 'NuGet', kind: 'lock', packages: parseNugetLock(text), frameworks: nugetLockFrameworks(text), ...(project ? { project: join(dirname(file), project) } : {}) };
    }
    const { packages, inexact } = parseProject(text, centralFor(dirname(file), root));
    const frameworks = projectFrameworks(text);
    const notes = ['no packages.lock.json: only its own references'];
    if (inexact.length) notes.push(`no exact version for ${inexact.slice(0, 3).join(', ')}${inexact.length > 3 ? ` and ${inexact.length - 3} more` : ''}`);
    return { ...base, ecosystem: 'NuGet', kind: 'project', project: file, packages, ...(frameworks.length ? { frameworks } : {}), note: notes.join('; ') };
  } catch (e) {
    return { ...base, ecosystem: /\.json$|^yarn\.lock$|^pnpm-lock\.yaml$/.test(name) && !/packages\.lock/.test(name) ? 'npm' : 'NuGet', kind: 'broken', packages: [], note: `couldn't be read: ${String(e.message).split('\n')[0]}` };
  }
}

/**
 * Every package of `manifests`, once per ecosystem, name and version, with where each was found
 * (`where`: [{ path, line }]): direct if any manifest asks for it itself, dev if every one has it only
 * for development.
 */
export function mergePackages(manifests) {
  const out = new Map();
  for (const m of manifests) {
    for (const p of m.packages) {
      const key = keyOf(p);
      const at = { path: m.path, ...(p.line ? { line: p.line } : {}) };
      const had = out.get(key);
      if (had) {
        had.direct ||= p.direct;
        had.dev &&= p.dev;
        had.license ??= p.license;
        had.where.push(at);
      } else {
        const { line, ...rest } = p;
        out.set(key, { ...rest, key, where: [at] });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.version.localeCompare(b.version));
}

/** What `root` depends on: { root, manifests, packages }. A file can be given in place of a folder. */
export function scanFolder(dir) {
  const root = resolve(dir);
  const isFile = (() => {
    try {
      return statSync(root).isFile();
    } catch {
      return false;
    }
  })();
  const top = isFile ? dirname(root) : root;
  const files = isFile ? [root] : findManifests(root);
  // A workspace's package.json says nothing its root's lock file doesn't.
  const read = files.map((f) => readManifest(top, f));
  const covered = new Set(read.flatMap((m) => m.workspaces ?? []).map((d) => resolve(d)));
  const manifests = read.filter((m) => basename(m.file) !== 'package.json' || !covered.has(resolve(m.dir))).map(({ workspaces, ...m }) => m);
  return { root: top, manifests, packages: mergePackages(manifests) };
}
