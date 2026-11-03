// The supply chain: what in a lock file could run or arrive from somewhere it shouldn't, rather than
// what has a known advisory. A package with an install script (it runs on npm install), a name one
// slip from a well-known package's (typosquat.js), and one downloaded from somewhere other than npm's
// registry (a git repository, a tarball's URL, another registry, plain http). Pure: lock text in,
// findings out, in the kit's findings.js shape with the package's own fields beside it.
import { indentTree, unquote, valueOf } from './indent.js';
import { isBerryLock, pnpmKey } from './jslocks.js';
import { escape, keyOf, lineOf } from '@fleet/kit/lockfiles.js';
import { rank } from './audit.js';
import { typosquatOf } from './typosquat.js';

// Where npm and Yarn download npm's packages from.
const REGISTRIES = /^https:\/\/registry\.(npmjs\.org|npmjs\.com|yarnpkg\.com)\//i;

/**
 * Where a package came from, when it isn't npm's registry: { from: 'git'|'url'|'http', url } or null.
 * A local file (file:, link:) is the project's own and isn't flagged.
 */
export function origin(resolved) {
  const r = String(resolved ?? '').trim();
  if (!r || REGISTRIES.test(r) || /^(file|link|workspace|portal|patch|exec):/i.test(r)) return null;
  if (/^git(\+[a-z]+)?:|^(github|gitlab|bitbucket):|\.git(#|$)|^ssh:/i.test(r)) return { from: 'git', url: r };
  if (/^http:/i.test(r)) return { from: 'http', url: r };
  if (/^https:/i.test(r)) return { from: 'url', url: r };
  return null;
}

/**
 * npm's package-lock.json (or npm-shrinkwrap.json), as text: [{ name, version, line, installScript?,
 * resolved? }], one per installed path. Lock files 2 and 3 say `hasInstallScript`; 1 has only
 * `resolved`. A workspace's link is the project's own and left out.
 */
export function npmEntries(text) {
  const lock = JSON.parse(text);
  const out = [];
  if (lock.packages) {
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path.includes('node_modules/') || entry.link) continue;
      const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      out.push({ name, version: String(entry.version ?? ''), line: lineOf(text, new RegExp(`"${escape(path)}"\\s*:`)), installScript: entry.hasInstallScript === true, resolved: entry.resolved });
    }
  } else {
    const walk = (deps) => {
      for (const [name, entry] of Object.entries(deps ?? {})) {
        out.push({ name, version: String(entry.version ?? ''), line: lineOf(text, new RegExp(`"${escape(name)}"\\s*:\\s*\\{`)), installScript: false, resolved: entry.resolved ?? (/^\d/.test(entry.version ?? '') ? undefined : entry.version) });
        walk(entry.dependencies);
      }
    };
    walk(lock.dependencies);
  }
  return out;
}

/** `name@range` split at its own @ (a scope's leading one isn't it). */
const splitAt = (s) => {
  const at = String(s).indexOf('@', 1);
  return at < 0 ? { name: String(s), range: '' } : { name: s.slice(0, at), range: s.slice(at + 1) };
};

/**
 * yarn.lock, as text: [{ name, version, line, resolved? }]. Yarn 1 writes where it downloaded each
 * package (`resolved`); Yarn 2+ only says what isn't npm's (a resolution of git or a URL). Neither says
 * which packages have install scripts.
 */
export function yarnEntries(text) {
  const berry = isBerryLock(text);
  const out = [];
  for (const [key, node] of indentTree(text, { yaml: berry }).map) {
    if (key === '__metadata') continue;
    const first = splitAt(unquote(key.split(/,\s*/)[0]));
    if (berry) {
      const r = splitAt(valueOf(node, 'resolution') ?? '');
      const range = r.range.replace(/^npm:/, '');
      out.push({ name: r.name || first.name, version: String(valueOf(node, 'version') ?? ''), line: node.line, resolved: /^npm:/.test(r.range) ? undefined : range });
    } else out.push({ name: /^npm:/.test(first.range) ? splitAt(first.range.slice(4)).name : first.name, version: String(valueOf(node, 'version') ?? ''), line: node.line, resolved: valueOf(node, 'resolved') });
  }
  return out;
}

/**
 * pnpm-lock.yaml, as text: [{ name, version, line, installScript?, resolved? }]. `requiresBuild`
 * (lock files before 9) marks an install script; a `tarball` or git `repo` in the resolution where it
 * didn't come from the registry.
 */
export function pnpmEntries(text) {
  const out = [];
  for (const [key, node] of indentTree(text).map.get('packages')?.map ?? []) {
    const k = pnpmKey(key);
    const resolution = valueOf(node, 'resolution') ?? '';
    const tarball = /tarball:\s*([^,}\s]+)/.exec(resolution)?.[1];
    const repo = /type:\s*git/.test(resolution) ? /repo:\s*([^,}\s]+)/.exec(resolution)?.[1] : undefined;
    const name = valueOf(node, 'name') ?? k?.name ?? splitAt(key.replace(/^\//, '')).name;
    out.push({ name, version: String(valueOf(node, 'version') ?? k?.version ?? ''), line: node.line, installScript: valueOf(node, 'requiresBuild') === 'true', resolved: repo ? `git+${repo}` : tarball });
  }
  return out;
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The entries of a lock file Bilge reads, by its name; [] for any other. */
export function lockEntries(fileName, text) {
  if (fileName === 'package-lock.json' || fileName === 'npm-shrinkwrap.json') return npmEntries(text);
  if (fileName === 'yarn.lock') return yarnEntries(text);
  if (fileName === 'pnpm-lock.yaml') return pnpmEntries(text);
  return [];
}

export const SUPPLY_RULES = {
  typosquat: { title: 'Name like a well-known package', why: 'Malicious packages are published under names one slip away from popular ones, for the install someone mistypes.' },
  'not-from-registry': { title: 'Not from npm\'s registry', why: 'A package from a git repository, a URL or another registry skips what npm\'s registry checks, and can change under the same version.' },
  'http-download': { title: 'Downloaded over plain http', why: 'Anyone between the machine and the server can swap what an http download brings.' },
  'install-script': { title: 'Runs a script on install', why: 'An install script runs with the rights of whoever runs npm install, on every machine and pipeline that installs it.' },
};

/**
 * The supply-chain findings of one manifest's lock entries (`path` the manifest's): typosquat (high),
 * not-from-registry (medium) or http-download (high), install-script (low; medium when the package is
 * also a suspect for one of the others). Each is { rule, severity, title, where, line?, why, fix,
 * excerpt, kind: 'supply', package, version, ecosystem, key }, once per package and rule.
 */
export function supplyFindings(entries, path, ecosystem = 'npm') {
  const out = new Map();
  const add = (e, rule, severity, fix, excerpt) => {
    const id = `${rule}:${e.name}@${e.version}`;
    if (out.has(id)) return;
    out.set(id, { rule, severity, title: `${SUPPLY_RULES[rule].title}: ${e.name}`, where: path, ...(e.line ? { line: e.line } : {}), why: SUPPLY_RULES[rule].why, fix, excerpt, kind: 'supply', package: e.name, version: e.version, ecosystem, key: keyOf({ ecosystem, name: e.name, version: e.version }) });
  };
  for (const e of entries) {
    if (!e.name) continue;
    const squat = typosquatOf(e.name, ecosystem);
    const from = origin(e.resolved);
    if (squat) add(e, 'typosquat', 'high', `Check that ${e.name} is the package meant, not ${squat.like}; if not, remove it and install ${squat.like}, and look at what ran when it was installed.`, `${e.name} looks like ${squat.like} (${squat.how === 'separators' ? 'only the separators differ' : squat.how === 'swapped' ? 'two letters swapped' : 'one letter apart'})`);
    if (from?.from === 'http') add(e, 'http-download', 'high', `Install ${e.name} from https (the registry's address, or the server's https one) and update the lock file.`, from.url);
    else if (from) add(e, 'not-from-registry', 'medium', from.from === 'git' ? `Pin ${e.name} to a published version from the registry, or to a commit you have read.` : `Install ${e.name} from npm's registry, or make sure ${hostOf(from.url)} is a registry you run or trust.`, from.url);
    if (e.installScript) add(e, 'install-script', squat || from ? 'medium' : 'low', `Check what ${e.name}'s preinstall, install or postinstall script does; npm install --ignore-scripts (or ignore-scripts=true in .npmrc) runs none.`, `${e.name}@${e.version} has an install script`);
  }
  return [...out.values()];
}

/** A NuGet manifest's packages, through the typosquat check (NuGet has no install scripts or URLs in its lock file). */
export const nugetSupply = (packages, path) => supplyFindings(packages.map((p) => ({ name: p.name, version: p.version, line: p.line })), path, 'NuGet');

/** Every manifest's supply findings, worst first. */
export const allSupply = (manifests) => (manifests ?? []).flatMap((m) => m.supply ?? []).sort((a, b) => rank(a.severity) - rank(b.severity) || a.package.localeCompare(b.package));

/** Without what `supplyIgnore` names: a rule's id, a package's name, or `rule:package`. */
export function withoutIgnoredSupply(list, ignore = []) {
  if (!ignore.length) return list;
  const set = new Set(ignore.map((s) => s.toLowerCase()));
  return list.filter((f) => !set.has(f.rule) && !set.has(f.package.toLowerCase()) && !set.has(`${f.rule}:${f.package.toLowerCase()}`));
}

/** A short word for the Packages view's column: what the worst of a package's findings is. */
export const SUPPLY_LABEL = { typosquat: 'typo?', 'http-download': 'http', 'not-from-registry': 'source', 'install-script': 'script' };
