// Finding a folder's manifests and reading the packages in them: npm's package-lock.json (and
// npm-shrinkwrap.json), NuGet's packages.lock.json, and a .NET project's PackageReferences when it has
// no lock file (Directory.Packages.props giving the versions under central package management). The
// parsers take text and are pure; `scan` is the one that reads the disk.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

// Folders never worth going into: what installs, builds and editors make.
const SKIP = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', 'TestResults', 'artifacts']);
const PROJECT = /\.(cs|fs|vb)proj$/i;
export const MAX_DEPTH = 6;
export const MAX_MANIFESTS = 200;

/** A package's key: the same package at the same version, wherever it was found. */
export const keyOf = (p) => `${p.ecosystem}:${p.ecosystem === 'NuGet' ? p.name.toLowerCase() : p.name}@${p.version}`;

/** The 1-based line of `text` the first match of `re` is on, or null. */
function lineOf(text, re) {
  const m = re.exec(text);
  return m ? text.slice(0, m.index).split('\n').length : null;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * npm's lock file, as text: [{ ecosystem, name, version, direct, dev, license?, line? }], one per name
 * and version. Lock files 2 and 3 list every installed path under `packages` (a workspace's own
 * packages, links, are left out); version 1 nests `dependencies`.
 */
export function parseNpmLock(text) {
  const lock = JSON.parse(text);
  const out = new Map();
  const add = (p) => {
    const key = `${p.name}@${p.version}`;
    const had = out.get(key);
    if (had) {
      had.direct ||= p.direct;
      had.dev &&= p.dev;
      had.license ??= p.license;
    } else out.set(key, p);
  };
  if (lock.packages) {
    // What the project asks for itself: the root's dependencies, and each workspace's (an entry outside node_modules).
    const directs = new Set();
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (path.includes('node_modules/')) continue;
      for (const name of Object.keys({ ...entry.dependencies, ...entry.devDependencies, ...entry.optionalDependencies, ...entry.peerDependencies })) directs.add(name);
    }
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path.includes('node_modules/') || entry.link || !entry.version) continue;
      const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      // The version of an alias (npm:other@1.2.3) or a git or file dependency isn't the registry's.
      if (!/^\d/.test(entry.version)) continue;
      const license = typeof entry.license === 'string' ? entry.license : entry.license?.type;
      add({ ecosystem: 'npm', name, version: entry.version, direct: directs.has(name) && path.indexOf('node_modules/') === path.lastIndexOf('node_modules/'), dev: Boolean(entry.dev || entry.devOptional), ...(license ? { license } : {}), line: lineOf(text, new RegExp(`"${escape(path)}"\\s*:`)) });
    }
  } else if (lock.dependencies) {
    const walk = (deps, top) => {
      for (const [name, entry] of Object.entries(deps ?? {})) {
        if (entry.version && /^\d/.test(entry.version)) add({ ecosystem: 'npm', name, version: entry.version, direct: top, dev: Boolean(entry.dev), line: lineOf(text, new RegExp(`"${escape(name)}"\\s*:\\s*\\{`)) });
        walk(entry.dependencies, false);
      }
    };
    walk(lock.dependencies, true);
  }
  return [...out.values()];
}

/**
 * NuGet's packages.lock.json, as text: every target framework's packages, once each. "Direct" ones are
 * the project's own references; a "Project" entry is another project of the solution, not a package.
 */
export function parseNugetLock(text) {
  const lock = JSON.parse(text.replace(/^﻿/, ''));
  const out = new Map();
  for (const deps of Object.values(lock.dependencies ?? {})) {
    for (const [name, entry] of Object.entries(deps)) {
      if (entry.type === 'Project' || !entry.resolved) continue;
      const key = `${name.toLowerCase()}@${entry.resolved}`;
      const had = out.get(key);
      if (had) had.direct ||= entry.type === 'Direct';
      else out.set(key, { ecosystem: 'NuGet', name, version: entry.resolved, direct: entry.type === 'Direct', dev: false, line: lineOf(text, new RegExp(`"${escape(name)}"\\s*:`, 'i')) });
    }
  }
  return [...out.values()];
}

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
    if (names.has('package-lock.json')) found.push(join(dir, 'package-lock.json'));
    else if (names.has('npm-shrinkwrap.json')) found.push(join(dir, 'npm-shrinkwrap.json'));
    else if (names.has('package.json') && !names.has('yarn.lock') && !names.has('pnpm-lock.yaml')) found.push(join(dir, 'package.json'));
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
      const workspaces = Object.keys(JSON.parse(text).packages ?? {}).filter((k) => k && !k.includes('node_modules/'));
      return { ...base, ecosystem: 'npm', kind: 'lock', packages: parseNpmLock(text), workspaces: workspaces.map((w) => join(dirname(file), ...w.split('/'))) };
    }
    if (name === 'package.json') {
      // A workspace's own package.json is covered by the root's lock file.
      return { ...base, ecosystem: 'npm', kind: 'manifest', packages: [], note: 'no package-lock.json: npm install makes one' };
    }
    if (name === 'packages.lock.json') {
      const project = readdirSync(dirname(file)).find((n) => PROJECT.test(n));
      return { ...base, ecosystem: 'NuGet', kind: 'lock', packages: parseNugetLock(text), ...(project ? { project: join(dirname(file), project) } : {}) };
    }
    const { packages, inexact } = parseProject(text, centralFor(dirname(file), root));
    const notes = ['no packages.lock.json: only its own references'];
    if (inexact.length) notes.push(`no exact version for ${inexact.slice(0, 3).join(', ')}${inexact.length > 3 ? ` and ${inexact.length - 3} more` : ''}`);
    return { ...base, ecosystem: 'NuGet', kind: 'project', project: file, packages, note: notes.join('; ') };
  } catch (e) {
    return { ...base, ecosystem: /\.json$/.test(name) && !/packages\.lock/.test(name) ? 'npm' : 'NuGet', kind: 'broken', packages: [], note: `couldn't be read: ${String(e.message).split('\n')[0]}` };
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
