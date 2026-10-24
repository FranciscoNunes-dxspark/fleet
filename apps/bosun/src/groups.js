// Groups and the `after` graph: "group" on a process puts it under a heading in the Crew list, and
// /start, /stop and /restart take a group's name; ctrl+g shows one group at a time; /graph draws who
// starts after whom as a tree. Pure.

const groupOf = (p) => p.spec?.group ?? p.group ?? null;

/** The groups the processes name, in the order they first come. */
export function groupsOf(procs) {
  return [...new Set(procs.map(groupOf).filter(Boolean))];
}

/**
 * The Crew list's rows: the processes without a group first, then each group's under a heading
 * ({ heading, procs }), the group order as they first come. With `only`, that group's alone. Without
 * any group, just the processes.
 */
export function crewRows(procs, only = null) {
  const groups = groupsOf(procs);
  if (!groups.length) return procs.map((p) => ({ p }));
  const rows = only ? [] : procs.filter((p) => !groupOf(p)).map((p) => ({ p }));
  for (const g of only ? groups.filter((x) => x === only) : groups) {
    const members = procs.filter((p) => groupOf(p) === g);
    rows.push({ heading: g, procs: members }, ...members.map((p) => ({ p })));
  }
  return rows;
}

/** ctrl+g: the group after `current` (null, every process, comes after the last). */
export function nextGroup(groups, current) {
  if (!groups.length) return null;
  const i = current == null ? -1 : groups.indexOf(current);
  return i + 1 < groups.length ? groups[i + 1] : null;
}

/** The processes a name means: one by its name, else a group's, by its name (any case); null when neither. */
export function namedProcs(procs, name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return null;
  const one = procs.find((p) => p.name.toLowerCase() === n);
  if (one) return { procs: [one] };
  const group = groupsOf(procs).find((g) => g.toLowerCase() === n);
  return group ? { group, procs: procs.filter((p) => groupOf(p) === group) } : null;
}

/**
 * Who starts after whom, as a tree: [{ name, depth, last, lines }] in drawing order, roots being the
 * processes that wait for nobody; `circle` on one whose `after`s go round in a circle (drawn as a
 * root, its waits never met).
 */
export function afterTree(procs) {
  const names = new Set(procs.map((p) => p.name));
  const after = (p) => (p.spec?.after ?? p.after ?? null);
  const kids = new Map();
  for (const p of procs) {
    const a = after(p);
    if (a && names.has(a) && a !== p.name) kids.set(a, [...(kids.get(a) ?? []), p]);
  }
  const out = [];
  const seen = new Set();
  const visit = (p, depth, prefix, last, circle = false) => {
    seen.add(p.name);
    out.push({ name: p.name, group: groupOf(p), depth, prefix, last, circle });
    const children = (kids.get(p.name) ?? []).filter((c) => !seen.has(c.name));
    children.forEach((c, i) => visit(c, depth + 1, depth === 0 ? '' : `${prefix}${last ? '   ' : '│  '}`, i === children.length - 1));
  };
  for (const p of procs) if (!after(p) || !names.has(after(p)) || after(p) === p.name) visit(p, 0, '', true);
  // What's left waits in a circle: each drawn from the first not yet drawn.
  for (const p of procs) if (!seen.has(p.name)) visit(p, 0, '', true, true);
  return out;
}

/** A tree's line for one node: `└─ web`, `│  ├─ e2e`; a root is its name alone. */
export const treeLine = (n) => (n.depth === 0 ? n.name : `${n.prefix}${n.last ? '└─ ' : '├─ '}${n.name}`);
