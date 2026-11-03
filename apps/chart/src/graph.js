// What depends on what: from a plan's configuration (the references each resource's arguments make,
// and its depends_on), from `terraform graph`'s DOT when a plan has no configuration, or for a what-if
// from the resource ids (a child under its parent). One shape, `dependsOn`: { address → [addresses it
// depends on] }, over the plan's own change addresses. Pure, and imports nothing: plan.js uses it
// while parsing.

// A reference's first word that names no resource.
const NOT_RESOURCES = new Set(['var', 'local', 'each', 'count', 'path', 'terraform', 'self', 'output', 'provider']);

/** A change's address as its configuration writes it: module.a[0].azurerm_x.y["k"] → module.a.azurerm_x.y. */
export const configAddress = (address) => String(address).replace(/\[[^\]]*\]/g, '');

/** What a reference ("azurerm_service_plan.main.id", "module.network.subnet_id", "data.x.y.z") points at, under `prefix`; null for a variable or a local. */
function referenceTarget(ref, prefix) {
  const parts = configAddress(ref).split('.');
  if (NOT_RESOURCES.has(parts[0])) return null;
  if (parts[0] === 'data') return parts.length >= 3 ? `${prefix}data.${parts[1]}.${parts[2]}` : null;
  // A module's output: everything in that module.
  if (parts[0] === 'module') return parts.length >= 2 ? `${prefix}module.${parts[1]}.` : null;
  return parts.length >= 2 ? `${prefix}${parts[0]}.${parts[1]}` : null;
}

/** Every `references` list in an expressions object, however deep its blocks go. */
function references(expressions, out = []) {
  if (Array.isArray(expressions)) for (const e of expressions) references(e, out);
  else if (expressions && typeof expressions === 'object') {
    if (Array.isArray(expressions.references)) out.push(...expressions.references.filter((r) => typeof r === 'string'));
    for (const [k, v] of Object.entries(expressions)) if (k !== 'references' && v && typeof v === 'object') references(v, out);
  }
  return out;
}

/** The configuration's edges: Map config address → Set of targets (a config address, or a module's prefix ending in "."). */
export function configEdges(configuration) {
  const edges = new Map();
  const walk = (mod, prefix, inherited) => {
    for (const r of mod?.resources ?? []) {
      const own = `${prefix}${r.address ?? `${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}`}`;
      const targets = new Set(inherited);
      for (const ref of [...references(r.expressions), ...references(r.count_expression), ...references(r.for_each_expression), ...(r.depends_on ?? [])]) {
        const t = referenceTarget(ref, prefix);
        if (t && t !== own) targets.add(t);
      }
      edges.set(own, targets);
    }
    for (const [name, call] of Object.entries(mod?.module_calls ?? {})) {
      // What a module is given, its resources depend on: the call's arguments, resolved where the call is.
      const given = new Set(inherited);
      for (const ref of [...references(call.expressions), ...references(call.count_expression), ...references(call.for_each_expression), ...(call.depends_on ?? [])]) {
        const t = referenceTarget(ref, prefix);
        if (t) given.add(t);
      }
      walk(call.module, `${prefix}module.${name}.`, given);
    }
  };
  walk(configuration?.root_module, '', new Set());
  return edges;
}

/** Edges between config addresses (or module prefixes), as edges between the plan's own `addresses`. */
function onAddresses(edges, addresses) {
  const byConfig = new Map();
  for (const a of addresses) {
    const c = configAddress(a);
    if (!byConfig.has(c)) byConfig.set(c, []);
    byConfig.get(c).push(a);
  }
  const resolve = (t) => (t.endsWith('.') ? addresses.filter((a) => configAddress(a).startsWith(t)) : (byConfig.get(t) ?? []));
  const out = {};
  for (const a of addresses) {
    const deps = new Set();
    for (const t of edges.get(configAddress(a)) ?? []) for (const d of resolve(t)) if (d !== a) deps.add(d);
    out[a] = [...deps].sort();
  }
  return out;
}

/** A Terraform plan's `dependsOn` from its `configuration`, over `addresses`; null when the plan has none. */
export function planDependencies(configuration, addresses) {
  if (!configuration?.root_module) return null;
  return onAddresses(configEdges(configuration), addresses);
}

/**
 * `terraform graph`'s DOT ("[root] a.b (expand)" -> "[root] c.d (expand)", or plainly "a.b" -> "c.d"
 * in newer versions: a depends on c), as `dependsOn` over `addresses`.
 */
export function parseDot(text, addresses) {
  const edges = new Map();
  const node = (s) => {
    const n = s.replace(/^\[root\] /, '').replace(/ \((expand|close)\)$/, '').trim();
    const first = n.split('.')[0];
    if (!n || NOT_RESOURCES.has(first) || /^(provider|meta|root)\b/.test(n) || /^var\.|^local\.|^output\./.test(n)) return null;
    return configAddress(n);
  };
  for (const m of String(text).matchAll(/"([^"]+)"\s*->\s*"([^"]+)"/g)) {
    const from = node(m[1]);
    const to = node(m[2]);
    if (!from || !to || from === to) continue;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  }
  return onAddresses(edges, addresses);
}

/** A what-if's `dependsOn`: each resource on the one whose id its own id is under (a slot on its app, a database on its server). */
export function idDependencies(changes) {
  // The changes by their lowercased id, so each change looks up the ids its own starts with (each
  // prefix ending before a "/") rather than comparing itself with every other change.
  const byId = new Map();
  changes.forEach((p, i) => {
    if (!p.id) return;
    const key = String(p.id).toLowerCase();
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(i);
  });
  const out = {};
  for (const c of changes) {
    const id = String(c.id ?? '').toLowerCase();
    const found = [];
    for (let j = id.indexOf('/'); j >= 0; j = id.indexOf('/', j + 1)) for (const i of byId.get(id.slice(0, j)) ?? []) found.push(i);
    out[c.address] = found.sort((x, y) => x - y).map((i) => changes[i].address);
  }
  return out;
}

// What depends on each address directly, sorted: dependsOn turned round once per dependsOn (never
// changed once made), so walking what depends on what doesn't scan every address at each step.
const directIndex = new WeakMap();
function directDependents(dependsOn) {
  let index = directIndex.get(dependsOn);
  if (index) return index;
  index = new Map();
  for (const k of Object.keys(dependsOn)) {
    for (const a of dependsOn[k]) {
      const list = index.get(a);
      if (!list) index.set(a, [k]);
      else if (list.at(-1) !== k) list.push(k);
    }
  }
  for (const list of index.values()) list.sort();
  directIndex.set(dependsOn, index);
  return index;
}

/** What depends on `address`, directly and through others: addresses, nearest first. */
export function dependentsOf(dependsOn, address) {
  if (!dependsOn) return [];
  const index = directDependents(dependsOn);
  const seen = new Set([address]);
  const out = [];
  let level = [address];
  while (level.length) {
    const next = [];
    for (const a of level)
      for (const d of index.get(a) ?? [])
        if (!seen.has(d)) {
          seen.add(d);
          out.push(d);
          next.push(d);
        }
    level = next;
  }
  return out;
}

const LOSES = new Set(['delete', 'replace']);

/** For each change that depends (directly or not) on something destroyed or replaced: { address → [those addresses] }. */
export function affectedBy(changes, dependsOn) {
  const out = {};
  for (const c of changes.filter((x) => LOSES.has(x.action))) for (const d of dependentsOf(dependsOn, c.address)) (out[d] ??= []).push(c.address);
  return out;
}

/** "replacing X affects Y, Z" for a destroyed or replaced change, or null. */
export function affectsLine(change, dependsOn, { max = 6 } = {}) {
  if (!LOSES.has(change.action)) return null;
  const deps = dependentsOf(dependsOn, change.address);
  if (!deps.length) return null;
  const shown = deps.slice(0, max).join(', ');
  return `${change.action === 'replace' ? 'Replacing' : 'Destroying'} ${change.address} affects ${shown}${deps.length > max ? ` and ${deps.length - max} more` : ''}`;
}

/**
 * The tree the dependency view draws: rows of { change, depth, repeat } with what nothing depends on
 * at the top and, under each resource, what depends on it. A resource under several is drawn in full
 * under the first and marked `repeat` under the others, so the tree stays a tree.
 */
export function dependencyRows(changes, dependsOn, { rank = () => 0 } = {}) {
  const by = new Map(changes.map((c) => [c.address, c]));
  const order = (list) => list.map((a) => by.get(a)).filter(Boolean).sort((x, y) => rank(x.action) - rank(y.action) || x.address.localeCompare(y.address));
  const dependents = new Map(changes.map((c) => [c.address, []]));
  for (const [a, deps] of Object.entries(dependsOn ?? {})) for (const d of deps) if (dependents.has(d) && by.has(a)) dependents.get(d).push(a);
  const rows = [];
  const shown = new Set();
  // `path` is the way down to here, added to going in and taken from coming out (a copy at each step
  // made a long chain quadratic).
  const visit = (c, depth, path) => {
    if (shown.has(c.address)) return rows.push({ change: c, depth, repeat: true });
    shown.add(c.address);
    rows.push({ change: c, depth, repeat: false });
    for (const d of order(dependents.get(c.address) ?? [])) {
      if (path.has(d.address)) continue;
      path.add(d.address);
      visit(d, depth + 1, path);
      path.delete(d.address);
    }
  };
  const roots = order(changes.filter((c) => !(dependsOn?.[c.address] ?? []).some((d) => by.has(d))).map((c) => c.address));
  for (const r of roots) visit(r, 0, new Set([r.address]));
  // What a cycle leaves out (each depends on another), from the worst of it.
  for (const c of order(changes.map((x) => x.address))) if (!shown.has(c.address)) visit(c, 0, new Set([c.address]));
  return rows;
}
