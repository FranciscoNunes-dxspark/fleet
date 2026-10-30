// What changes in a resource, attribute by attribute: two values (Terraform's before and after) flattened
// to their leaves and compared, with what's known only after apply, what's sensitive (never shown), and
// what forces a replacement marked. Pure.

export const SENSITIVE = '(sensitive)';
export const UNKNOWN = '(known after apply)';

const IDENT = /^[A-Za-z_][\w-]*$/;

/** A path's segments as written: a.b[0]["odd key"]. */
export function pathText(segments) {
  return segments.map((s, i) => (typeof s === 'number' ? `[${s}]` : IDENT.test(s) ? (i ? `.${s}` : s) : `[${JSON.stringify(s)}]`)).join('');
}

/** The leaves of a value: Map path text → [segments, value]. An empty object or list is a leaf of its own. */
function leaves(value, prefix = [], out = new Map()) {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
    if (!entries.length && prefix.length) out.set(pathText(prefix), [prefix, value]);
    for (const [k, v] of entries) leaves(v, [...prefix, k], out);
  } else if (prefix.length) out.set(pathText(prefix), [prefix, value]);
  return out;
}

/** Whether `marks` (a structure like the value's, `true` where something is marked) marks `segments` or anything above it. */
export function marked(marks, segments) {
  let m = marks;
  if (m === true) return true;
  for (const s of segments) {
    if (m === null || typeof m !== 'object') return false;
    m = m[s];
    if (m === true) return true;
  }
  return false;
}

/** The paths `marks` marks true, as segment lists. */
function markedPaths(marks, prefix = [], out = []) {
  if (marks === true) out.push(prefix);
  else if (marks && typeof marks === 'object') for (const [k, v] of Array.isArray(marks) ? marks.map((v, i) => [i, v]) : Object.entries(marks)) markedPaths(v, [...prefix, k], out);
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const startsWith = (segments, prefix) => prefix.length <= segments.length && prefix.every((p, i) => String(p) === String(segments[i]));

/**
 * The differences between `before` and `after`, leaf by leaf, in path order:
 * [{ path, kind: add | remove | change | unknown, before?, after?, sensitive?, forces? }].
 * `unknown`, `beforeSensitive` and `afterSensitive` are Terraform's marks (true where it applies);
 * `forces` its replace_paths. A null that comes or goes is no change worth a line.
 */
export function attributeDiff(before, after, { unknown = {}, beforeSensitive = {}, afterSensitive = {}, forces = [] } = {}) {
  const b = leaves(before ?? {});
  const a = leaves(after ?? {});
  const paths = new Map([...b, ...a].map(([k, [segments]]) => [k, segments]));
  for (const segments of markedPaths(unknown)) if (segments.length) paths.set(pathText(segments), segments);
  const out = [];
  for (const [path, segments] of paths) {
    const was = b.get(path)?.[1];
    const will = a.get(path)?.[1];
    const isUnknown = marked(unknown, segments);
    if (!isUnknown && same(was, will)) continue;
    if (!isUnknown && (was === undefined || was === null) && (will === undefined || will === null)) continue;
    const hidden = marked(beforeSensitive, segments) || marked(afterSensitive, segments);
    const kind = isUnknown ? 'unknown' : was === undefined || was === null ? 'add' : will === undefined || will === null ? 'remove' : 'change';
    out.push({
      path,
      kind,
      ...(kind !== 'add' && was !== undefined && was !== null ? { before: hidden ? SENSITIVE : was } : {}),
      ...(kind === 'unknown' ? { after: UNKNOWN } : kind !== 'remove' ? { after: hidden ? SENSITIVE : will } : {}),
      ...(hidden ? { sensitive: true } : {}),
      ...(forces.some((f) => startsWith(segments, f)) ? { forces: true } : {}),
    });
  }
  return out.sort((x, y) => x.path.localeCompare(y.path, undefined, { numeric: true }));
}

/** A value as one line: strings quoted, the rest as JSON, cut at `max`. */
export function showValue(v, max = 80) {
  if (v === SENSITIVE || v === UNKNOWN) return v;
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? 'null';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A diff as the lines the viewer shows: "+ tags.env = \"prod\"", "~ sku: \"B1\" → \"P1v3\"  # forces replacement". */
export function diffLines(diff, { noise = true } = {}) {
  return diff
    .filter((d) => noise || !d.noise)
    .map((d) => {
      const tail = `${d.forces ? '  # forces replacement' : ''}${d.noise ? '  # no effect' : ''}`;
      if (d.kind === 'add') return `+ ${d.path} = ${showValue(d.after)}${tail}`;
      if (d.kind === 'remove') return `- ${d.path} (was ${showValue(d.before)})${tail}`;
      if (d.kind === 'unknown') return `~ ${d.path}: ${d.before !== undefined ? `${showValue(d.before)} → ` : ''}${UNKNOWN}${tail}`;
      return `~ ${d.path}: ${showValue(d.before)} → ${showValue(d.after)}${tail}`;
    });
}

/** A state resource's values as lines, its sensitive ones masked: "name = \"shop-api\"". */
export function valueLines(values, sensitive = {}) {
  return [...leaves(values ?? {}).values()].map(([segments, v]) => `${pathText(segments)} = ${marked(sensitive, segments) ? SENSITIVE : showValue(v, 200)}`);
}
