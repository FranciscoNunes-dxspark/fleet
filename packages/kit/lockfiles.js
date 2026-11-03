// The lock files a project's packages are pinned in, read from their text: npm's package-lock.json
// (and npm-shrinkwrap.json) and NuGet's packages.lock.json. Pure: Bilge reads them from a folder,
// Keel's advisory watch from a repository through Azure DevOps. A package is { ecosystem, name,
// version, direct, dev, license?, peers?, line? }.

/** A package's key: the same package at the same version, wherever it was found. */
export const keyOf = (p) => `${p.ecosystem}:${p.ecosystem === 'NuGet' ? p.name.toLowerCase() : p.name}@${p.version}`;

/** The 1-based line of `text` the first match of `re` is on, or null. */
export function lineOf(text, re) {
  const m = re.exec(text);
  return m ? text.slice(0, m.index).split('\n').length : null;
}

export const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
      const peers = requiredPeers(entry.peerDependencies, entry.peerDependenciesMeta);
      add({ ecosystem: 'npm', name, version: entry.version, direct: directs.has(name) && path.indexOf('node_modules/') === path.lastIndexOf('node_modules/'), dev: Boolean(entry.dev || entry.devOptional), ...(license ? { license } : {}), ...(peers ? { peers } : {}), line: lineOf(text, new RegExp(`"${escape(path)}"\\s*:`)) });
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
 * A package's peerDependencies without the optional ones (peerDependenciesMeta): { name: range }, or
 * null when it has none. What npm insists on: the installed version of each must be in its range.
 */
export function requiredPeers(peers, meta = {}) {
  const out = Object.fromEntries(Object.entries(peers ?? {}).filter(([name, range]) => typeof range === 'string' && !meta?.[name]?.optional));
  return Object.keys(out).length ? out : null;
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
