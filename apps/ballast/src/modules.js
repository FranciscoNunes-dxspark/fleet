// What is inside chunks, as the Modules view shows it, and what is bundled twice, as Duplicates does.
// Pure.
import { moduleSize, packageTotals } from './build.js';

const bySize = (a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label);

/**
 * The tree of `chunks`' modules: a node per package (node_modules grouped, its installs as children
 * when it has more than one), then the project's own files by folder (a folder with one folder in it
 * drawn as one, src/pages/), biggest first at each level. A node is { key, kind: 'package' | 'install'
 * | 'dir' | 'module', label, bytes, size, modules, children?, ... }; `size` is in `measure`.
 */
export function moduleTree(chunks, measure = 'gzip') {
  const leaf = (m, c, label) => ({ key: `mod:${c.file}:${m.id}`, kind: 'module', label, id: m.id, chunk: c.file, pkg: m.pkg, bytes: m.bytes, size: moduleSize(m, c, measure), modules: 1 });
  const packages = new Map();
  const own = { children: new Map(), modules: [] };
  for (const c of chunks) {
    for (const m of c.modules) {
      if (m.pkg) {
        let p = packages.get(m.pkg.name);
        if (!p) packages.set(m.pkg.name, (p = new Map()));
        if (!p.has(m.pkg.installPath)) p.set(m.pkg.installPath, { version: m.pkg.version ?? null, leaves: [] });
        p.get(m.pkg.installPath).leaves.push(leaf(m, c, m.id.slice(m.id.lastIndexOf(m.pkg.installPath) + m.pkg.installPath.length + 1) || m.id));
        continue;
      }
      const parts = m.id.split('/');
      let dir = own;
      for (const part of parts.slice(0, -1)) {
        if (!dir.children.has(part)) dir.children.set(part, { children: new Map(), modules: [] });
        dir = dir.children.get(part);
      }
      dir.modules.push(leaf(m, c, parts.at(-1)));
    }
  }
  const sum = (nodes) => ({ bytes: nodes.reduce((n, x) => n + x.bytes, 0), size: nodes.reduce((n, x) => n + x.size, 0), modules: nodes.reduce((n, x) => n + x.modules, 0) });
  const pkgNodes = [...packages].map(([name, installs]) => {
    const list = [...installs].map(([installPath, i]) => ({ installPath, version: i.version, leaves: i.leaves.sort(bySize) }));
    const versions = [...new Set(list.map((i) => i.version).filter(Boolean))];
    const children =
      list.length === 1
        ? list[0].leaves
        : list.map((i) => ({ key: `install:${i.installPath}`, kind: 'install', label: `${i.version ?? '?'}  ${i.installPath}`, name, installPath: i.installPath, version: i.version, ...sum(i.leaves), children: i.leaves })).sort(bySize);
    return { key: `pkg:${name}`, kind: 'package', label: name, name, versions, installs: list.length, ...sum(list.flatMap((i) => i.leaves)), children };
  });
  const dirNode = (path, d) => {
    const children = [...[...d.children].map(([name, sub]) => dirNode(path ? `${path}/${name}` : name, sub)), ...d.modules].sort(bySize);
    // A folder holding one folder and nothing else reads as one: src/pages/.
    if (children.length === 1 && children[0].kind === 'dir' && path) return children[0];
    return { key: `dir:${path}`, kind: 'dir', label: `${path}/`, path, ...sum(children), children };
  };
  const ownNodes = [...[...own.children].map(([name, d]) => dirNode(name, d)), ...own.modules];
  return [...pkgNodes, ...ownNodes].sort(bySize);
}

/** The tree as rows to draw: each node with its depth, the open ones' children under them. */
export function treeRows(nodes, open, depth = 0, out = []) {
  for (const node of nodes) {
    const isOpen = Boolean(node.children?.length) && open.has(node.key);
    out.push({ node, depth, open: isOpen });
    if (isOpen) treeRows(node.children, open, depth + 1, out);
  }
  return out;
}

/**
 * Packages bundled more than once: at two versions or more (`kind: 'versions'`), or one version from
 * two install paths (`'paths'`). [{ name, kind, versions, installs, bytes, size, wasted, wastedSize }],
 * where `wasted` is all but the biggest install, the most there is to win first.
 */
export function duplicates(chunks, measure = 'gzip') {
  return packageTotals(chunks, measure)
    .filter((p) => p.installs.length > 1)
    .map((p) => ({ name: p.name, kind: p.versions.length > 1 ? 'versions' : 'paths', versions: p.versions, installs: p.installs, bytes: p.bytes, size: p.size, wasted: p.bytes - p.installs[0].bytes, wastedSize: p.size - p.installs[0].size, chunks: p.chunks }))
    .sort((a, b) => b.wasted - a.wasted || a.name.localeCompare(b.name));
}
