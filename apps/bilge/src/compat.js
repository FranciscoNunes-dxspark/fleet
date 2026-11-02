// Whether a package can move to a newer version in this project, before it does: what the new version
// needs (`needs`, the registry's word: npm's engines.node and peerDependencies, the frameworks a NuGet
// package is built for) against what the project has (the frameworks it targets, the Node it says it
// runs on, the versions installed beside it), and the installed packages whose own peerDependencies
// wouldn't take the new version. Pure: `data` is App's ({ manifests, packages }).
import { unsupported } from './frameworks.js';
import { compareVersions, lowestIn, satisfies } from './versions.js';

const manifestsOf = (p, data) => (data?.manifests ?? []).filter((m) => p.where.some((w) => w.path === m.path));
const beside = (p, data) => {
  const paths = new Set(p.where.map((w) => w.path));
  return (data?.packages ?? []).filter((q) => q.ecosystem === p.ecosystem && q.where.some((w) => paths.has(w.path)));
};

/** The frameworks the project(s) a NuGet package is in target: [{ framework, path }]. */
export function targetsOf(p, data) {
  return manifestsOf(p, data).flatMap((m) => (m.frameworks ?? []).map((framework) => ({ framework, path: m.path })));
}

/** The Node the project a package is in says it runs on: { range|version, from } or null. */
export const nodeOf = (p, data) => manifestsOf(p, data).find((m) => m.node)?.node ?? null;

/**
 * The version of Node to try a range against: the lowest a project's engines.node lets in (what it
 * promises to run on), or what .nvmrc names, its newest when it names a line (20 is 20.x, whatever x).
 */
function nodeToTry(node) {
  if (node.range) return lowestIn(node.range);
  const parts = node.version.split('.');
  return [...parts, ...Array(3 - parts.length).fill('999999')].join('.');
}

/**
 * What stands in the way of `p` moving to `version`, whose `needs` the registry gave: sentences, empty
 * when nothing does (or nothing could be checked).
 */
export function problems(p, version, needs, data) {
  const out = [];
  if (p.ecosystem === 'NuGet') {
    const targets = targetsOf(p, data);
    const missing = new Set(unsupported(needs?.frameworks, [...new Set(targets.map((t) => t.framework))]));
    if (missing.size) {
      const where = [...new Set(targets.filter((t) => missing.has(t.framework)).map((t) => t.path.replace(/\/?[^/]+$/, '') || '.'))];
      out.push(`${version} is built for ${needs.frameworks.join(', ')}, not ${[...missing].join(', ')} (${where.join(', ')})`);
    }
    return out;
  }
  const node = nodeOf(p, data);
  if (node && needs?.node) {
    const tried = nodeToTry(node);
    if (tried && satisfies(tried, needs.node) === false) out.push(`${version} needs Node ${needs.node}; the project says ${node.range ?? node.version} (${node.from})`);
  }
  const others = beside(p, data);
  for (const [name, range] of Object.entries(needs?.peers ?? {})) {
    const there = others.filter((q) => q.name === name);
    if (there.length && !there.some((q) => satisfies(q.version, range) !== false)) out.push(`${version} wants ${name} ${range}; ${there.map((q) => q.version).join(', ')} is installed`);
  }
  for (const q of others) {
    const range = q.peers?.[p.name];
    if (q.name !== p.name && range && satisfies(version, range) === false) out.push(`${q.name} ${q.version} wants ${p.name} ${range}`);
  }
  return out;
}

/**
 * The problems of every outdated package's newest version (`latest`: key → the registry's answer):
 * Map key → [sentences], only for the ones with some.
 */
export function updateProblems(data) {
  const out = new Map();
  for (const p of data?.packages ?? []) {
    const l = data.latest?.get(p.key);
    if (!l?.latest || compareVersions(l.latest, p.version) <= 0) continue;
    const found = problems(p, l.latest, l.needs, data);
    if (found.length) out.set(p.key, found);
  }
  return out;
}
