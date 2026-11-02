// Yarn's and pnpm's lock files: yarn.lock (Yarn 1, and Yarn 2+'s "Berry" one, which is YAML) and
// pnpm-lock.yaml (lock file 6 to 9). Each gives every installed package's name and version, the ones
// the project asks for itself marked direct, and the ones only development needs marked dev where the
// file lets that be told: pnpm's says which the project asks for as development ones, Yarn's only
// with the package.json beside it, and the rest is a walk of the dependencies from those. Pure: text in,
// lockfiles.js's packages out.
import { indentTree, objectOf, unquote, valueOf } from './indent.js';
import { requiredPeers } from './lockfiles.js';

// A range that isn't the registry's: a git, file, link or tarball dependency.
const NOT_REGISTRY = /^(file:|link:|portal:|exec:|patch:|workspace:|git[+:]|github:|gitlab:|bitbucket:|https?:|[\w.-]+\/[\w.-]+(#.*)?$)/i;
const isVersion = (v) => /^\d/.test(String(v ?? ''));

/** `name@range` split at its own @ (a scope's leading one isn't it). */
function splitAt(text) {
  const s = String(text ?? '');
  const at = s.indexOf('@', 1);
  return at < 0 ? { name: s, range: '' } : { name: s.slice(0, at), range: s.slice(at + 1) };
}

/** The packages a project's package.json(s) ask for: { prod: Set(name@range), dev: Set(name@range), names: Set }. */
function asked(packageJsons) {
  const prod = new Set();
  const dev = new Set();
  const names = new Set();
  for (const pj of packageJsons.filter(Boolean)) {
    for (const [name, range] of Object.entries({ ...pj.dependencies, ...pj.optionalDependencies })) {
      prod.add(`${name}@${range}`);
      names.add(name);
    }
    for (const [name, range] of Object.entries(pj.devDependencies ?? {})) {
      dev.add(`${name}@${range}`);
      names.add(name);
    }
  }
  return { prod, dev, names };
}

/**
 * Which of a graph's nodes only development reaches: the nodes reachable from `devRoots` and not from
 * `prodRoots`. `edges(id)` gives a node's dependencies' ids.
 */
function devOnly(prodRoots, devRoots, edges) {
  const walk = (roots) => {
    const seen = new Set();
    const todo = [...roots];
    while (todo.length) {
      const id = todo.pop();
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      todo.push(...edges(id));
    }
    return seen;
  };
  const prod = walk(prodRoots);
  return new Set([...walk(devRoots)].filter((id) => !prod.has(id)));
}

/** Adds `p` to `out` (a Map by name@version), keeping direct if either is, dev only if both are. */
function add(out, p) {
  const key = `${p.name}@${p.version}`;
  const had = out.get(key);
  if (!had) return out.set(key, p);
  had.direct ||= p.direct;
  had.dev &&= p.dev;
  had.peers ??= p.peers;
}

/** Whether a yarn.lock is Yarn 2+'s (YAML, with __metadata) rather than Yarn 1's. */
export const isBerryLock = (text) => /^__metadata:/m.test(String(text ?? ''));

/**
 * yarn.lock, as text, with the package.json files of the project (the one beside it first, then its
 * workspaces' where known): [{ ecosystem, name, version, direct, dev, peers?, line }]. Yarn 1's entries
 * are `name@range, name@range:` with `version "1.2.3"`; Berry's `"name@npm:range":` with `resolution:
 * "name@npm:1.2.3"` (an alias resolves to the package's own name). A workspace, a patch, a git or file
 * dependency isn't the registry's and is left out.
 */
export function parseYarnLock(text, packageJsons = []) {
  const berry = isBerryLock(text);
  const tree = indentTree(text, { yaml: berry });
  const nodes = [];
  const byDescriptor = new Map();
  const workspaces = [];
  for (const [key, node] of tree.map) {
    if (key === '__metadata') continue;
    const descriptors = key.split(/,\s*/).map(unquote).filter(Boolean);
    let name;
    let version;
    if (berry) {
      const resolution = splitAt(valueOf(node, 'resolution'));
      if (/^workspace:/.test(resolution.range)) {
        workspaces.push({ node, path: resolution.range.slice('workspace:'.length) });
        continue;
      }
      if (!/^npm:/.test(resolution.range)) continue;
      name = resolution.name;
      version = resolution.range.slice(4);
    } else {
      const first = splitAt(descriptors[0]);
      if (NOT_REGISTRY.test(first.range)) continue;
      // An alias (other@npm:real@^1) is the real package's.
      name = /^npm:/.test(first.range) ? splitAt(first.range.slice(4)).name : first.name;
      version = valueOf(node, 'version');
    }
    if (!name || !isVersion(version)) continue;
    const id = nodes.length;
    const peers = berry ? requiredPeers(objectOf(node.map.get('peerDependencies')), objectOf(node.map.get('peerDependenciesMeta'))) : null;
    nodes.push({ name, version, line: node.line, node, peers });
    for (const d of descriptors) byDescriptor.set(d, id);
  }
  // A dependency's range finds its entry as Yarn wrote it: `name@range`, or in Berry `name@npm:range`.
  const target = (name, range) => byDescriptor.get(`${name}@${range}`) ?? byDescriptor.get(`${name}@npm:${range}`);
  const edges = (id) => {
    const node = nodes[id].node;
    return ['dependencies', 'optionalDependencies'].flatMap((k) => [...(node.map.get(k)?.map ?? [])].map(([n, v]) => target(n, v.value)));
  };
  const { prod, dev, names } = asked(packageJsons);
  const prodRoots = [...prod].map((d) => target(splitAt(d).name, splitAt(d).range));
  const devRoots = [...dev].map((d) => target(splitAt(d).name, splitAt(d).range));
  // Berry lists every workspace with what it asks for (development ones too, not told apart): those are
  // direct, and development's only where a package.json given says so.
  for (const w of workspaces) {
    for (const k of ['dependencies', 'optionalDependencies']) {
      for (const [n, v] of w.node.map.get(k)?.map ?? []) {
        const id = target(n, v.value);
        const asWritten = `${n}@${String(v.value).replace(/^npm:/, '')}`;
        (dev.has(asWritten) && !prod.has(asWritten) ? devRoots : prodRoots).push(id);
        names.add(n);
      }
    }
  }
  const direct = new Set([...prodRoots, ...devRoots].filter((id) => id != null));
  const devSet = devOnly(prodRoots, devRoots, edges);
  const out = new Map();
  nodes.forEach((n, id) => add(out, { ecosystem: 'npm', name: n.name, version: n.version, direct: direct.has(id), dev: devSet.has(id), ...(n.peers ? { peers: n.peers } : {}), line: n.line }));
  // A direct package whose entry Yarn wrote differently (a range normalised) still counts as asked for.
  const found = new Set([...direct].map((id) => nodes[id].name));
  for (const p of out.values()) if (!found.has(p.name) && names.has(p.name) && [...out.values()].filter((q) => q.name === p.name).length === 1) p.direct = true;
  return [...out.values()];
}

/** The workspaces a Berry yarn.lock lists: their folders relative to it ('.' for its own). */
export function yarnWorkspaces(text) {
  if (!isBerryLock(text)) return [];
  const out = [];
  for (const node of indentTree(text).map.values()) {
    const r = splitAt(valueOf(node, 'resolution'));
    if (/^workspace:/.test(r.range)) out.push(r.range.slice('workspace:'.length));
  }
  return out;
}

/**
 * A pnpm lock file's key or reference as { name, version, id }: `/name@1.2.3(peer@1.0.0)` (6),
 * `name@1.2.3(peer@1.0.0)` (9), `/name/1.2.3_peer@1.0.0` (5). `id` keeps the peers, which tell one
 * snapshot from another; null when it isn't the registry's.
 */
export function pnpmKey(text) {
  const s = String(text ?? '').replace(/^\//, '');
  const base = s.replace(/\(.*$/, '');
  // name@version from lock file 6 on; name/version_peers in 5.
  const m = /^(@[^/@]+\/[^/@]+|[^/@]+)@(.+)$/.exec(base) ?? /^(@[^/@]+\/[^/@]+|[^/@]+)\/([^_]+)/.exec(base);
  if (!m) return null;
  const [, name, version] = m;
  return isVersion(version) && !NOT_REGISTRY.test(version) ? { name, version, id: s } : null;
}

/**
 * pnpm-lock.yaml, as text: [{ ecosystem, name, version, direct, dev, peers?, line }]. The importers
 * (the project and its workspaces; lock file 6 has a single project's at the top) say what's asked for,
 * development's included; `packages` lists every package, and lock file 6's mark the development ones,
 * where 9's are worked out from its `snapshots`.
 */
export function parsePnpmLock(text) {
  const tree = indentTree(text);
  const importers = tree.map.get('importers') ? [...tree.map.get('importers').map.values()] : [tree];
  const packages = tree.map.get('packages')?.map ?? new Map();
  const graph = tree.map.get('snapshots')?.map ?? packages;
  // A reference to a dependency: its version (with peers) under its own name, or an alias's package.
  const ref = (name, value) => {
    const v = String(value ?? '');
    if (/^(link|file|workspace):/.test(v)) return null;
    const aliased = v.replace(/^\//, '').replace(/\(.*$/, '').indexOf('@', 1) > 0;
    const key = pnpmKey(aliased ? v : `${name}@${v}`);
    return key?.id ?? null;
  };
  const prodRoots = [];
  const devRoots = [];
  for (const imp of importers) {
    for (const [kind, roots] of [['dependencies', prodRoots], ['optionalDependencies', prodRoots], ['devDependencies', devRoots]]) {
      for (const [name, n] of imp.map.get(kind)?.map ?? []) roots.push(ref(name, n.value ?? valueOf(n, 'version')));
    }
  }
  const ids = new Map([...graph.keys()].map((k) => [k.replace(/^\//, ''), k]));
  const edges = (id) => {
    const node = graph.get(ids.get(id) ?? id);
    return ['dependencies', 'optionalDependencies'].flatMap((k) => [...(node?.map.get(k)?.map ?? [])].map(([n, v]) => ref(n, v.value)));
  };
  const devSet = devOnly(prodRoots, devRoots, edges);
  const base = (id) => (id ? pnpmKey(id) : null);
  const directs = new Set([...prodRoots, ...devRoots].map(base).filter(Boolean).map((k) => `${k.name}@${k.version}`));
  const devBases = new Set([...devSet].map(base).filter(Boolean).map((k) => `${k.name}@${k.version}`));
  // A package with several snapshots (peers) is development's only if every one of them is.
  const prodBases = new Set([...ids.keys()].filter((id) => !devSet.has(id)).map(base).filter(Boolean).map((k) => `${k.name}@${k.version}`));
  const out = new Map();
  for (const [key, node] of packages) {
    const k = pnpmKey(key);
    if (!k) continue;
    const at = `${k.name}@${k.version}`;
    const flag = valueOf(node, 'dev');
    const dev = flag === 'true' ? true : flag === 'false' ? false : devBases.has(at) && !prodBases.has(at);
    const peers = requiredPeers(objectOf(node.map.get('peerDependencies')), objectOf(node.map.get('peerDependenciesMeta')));
    add(out, { ecosystem: 'npm', name: k.name, version: k.version, direct: directs.has(at), dev, ...(peers ? { peers } : {}), line: node.line });
  }
  return [...out.values()];
}

/** The importers (the project and its workspaces) a pnpm lock file lists: folders relative to it. */
export function pnpmWorkspaces(text) {
  return [...(indentTree(text).map.get('importers')?.map.keys() ?? [])];
}
