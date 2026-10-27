// Data for the viewer (ui/DataViewer.jsx), pure: text read as JSON (or JSON lines) or CSV/TSV into a
// value, a tree of rows to draw from it, a table when it's rows of fields, a small jq-like query
// (.a.b[0], .items[], .items[].name, | length, | keys) and pretty-printing in coloured tokens.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const IDENT = /^[A-Za-z_$][\w$-]*$/;

/** The kind of a value as the viewer colours it: object, array, string, number, boolean or null. */
export const kindOf = (v) => (v === null || v === undefined ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);

/** `.key` (or `."odd key"`) added to a path; '' is the root. */
export const keyPath = (path, key) => `${path}${IDENT.test(key) ? `.${key}` : `.${JSON.stringify(key)}`}`;
export const indexPath = (path, i) => `${path}[${i}]`;
/** A path as the person reads it and the query takes it: the root is `.`. */
export const showPath = (path) => path || '.';

/** One CSV record per row, handling "quoted, fields" and "" for a quote and newlines inside quotes. */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') (field += '"', i++);
        else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) (row.push(field), (field = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) (row.push(field), rows.push(row));
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** The delimiter (tab, comma, semicolon) the first lines agree on with at least two columns, or null. */
function delimiterOf(text) {
  const lines = text.split(/\r?\n/).filter(Boolean).slice(0, 20);
  if (lines.length < 2) return null;
  for (const d of ['\t', ',', ';']) {
    const counts = lines.map((l) => parseDelimited(l, d)[0]?.length ?? 0);
    if (counts[0] >= 2 && counts.every((n) => n === counts[0])) return d;
  }
  return null;
}

/** Column names made unique (a, a_2) and never empty. */
function names(header) {
  const seen = new Map();
  return header.map((h, i) => {
    const base = h.trim() || `column${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}

/** Rows of cells under column names as an array of objects (what the tree and the table read). */
export function fromTable(columns, rows) {
  const cols = names(columns.map(String));
  return rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, jsonable(r[i])])));
}

/** A value JSON can hold: dates as ISO text, bytes as hex, big integers as text. */
export function jsonable(v) {
  if (v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object' && v !== null && typeof v.length === 'number' && typeof v.readUInt8 === 'function') return `0x${Buffer.from(v).toString('hex')}`;
  return v;
}

/**
 * Text read as data: `{ kind: 'json' | 'jsonl' | 'csv' | 'tsv', value }` (CSV and TSV as an array of objects, a
 * header's names as keys, values as text), or `{ error }` when it's none of them.
 */
export function parseData(text) {
  const t = String(text ?? '').trim();
  if (!t) return { error: 'There is nothing to read.' };
  try {
    return { kind: 'json', value: JSON.parse(t) };
  } catch (e) {
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length >= 2 && /^[[{]/.test(lines[0])) {
      try {
        return { kind: 'jsonl', value: lines.map((l) => JSON.parse(l)) };
      } catch {}
    }
    const d = /^[[{"]/.test(t) ? null : delimiterOf(t);
    if (d) {
      const [header, ...rows] = parseDelimited(t, d);
      return { kind: d === '\t' ? 'tsv' : 'csv', value: fromTable(header, rows) };
    }
    return { error: /^[[{]/.test(t) ? `Not valid JSON: ${e.message}` : 'Not JSON, JSON lines, CSV or TSV.' };
  }
}

/** The cell text of a value in the table. */
export const cellText = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** `{ columns, rows }` (rows of cell values) when `value` is a non-empty array of objects, else null. */
export function tableOf(value, maxColumns = 60) {
  if (!Array.isArray(value) || !value.length || !value.every(isObject)) return null;
  const columns = [];
  const seen = new Set();
  for (const r of value) {
    for (const k of Object.keys(r)) if (!seen.has(k) && columns.length < maxColumns) (seen.add(k), columns.push(k));
  }
  return columns.length ? { columns, rows: value.map((r) => columns.map((c) => r[c])) } : null;
}

const CHILD_LIMIT = 500;

/** A one-line summary of a container, shown beside its key. */
export const summary = (v) => (Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length}}`);

/**
 * The rows of the tree to draw, each `{ path, depth, key, kind, value, open, expandable, more }`: a container's
 * children follow it while its path is in `expanded` (a Set), at most 500 of them (then a `more` row says how many).
 */
export function flatten(value, expanded) {
  const out = [];
  const walk = (v, path, key, depth) => {
    const kind = kindOf(v);
    const expandable = kind === 'object' || kind === 'array';
    const open = expandable && expanded.has(path);
    out.push({ path, depth, key, kind, value: v, open, expandable });
    if (!open) return;
    const entries = kind === 'array' ? v.map((x, i) => [i, x]) : Object.entries(v);
    for (const [k, x] of entries.slice(0, CHILD_LIMIT)) walk(x, kind === 'array' ? indexPath(path, k) : keyPath(path, k), kind === 'array' ? `[${k}]` : k, depth + 1);
    if (entries.length > CHILD_LIMIT) out.push({ path: `${path}…`, depth: depth + 1, key: '', kind: 'more', value: null, open: false, expandable: false, more: entries.length - CHILD_LIMIT });
  };
  walk(value, '', '', 0);
  return out;
}

/** The text of a scalar as written in JSON. */
export const scalarText = (v) => (v === undefined ? 'null' : JSON.stringify(v));

/**
 * Pretty-printed JSON as lines of tokens `{ text, kind }`, kind being key, string, number, boolean, null or
 * punct: the viewer picks a colour for each. At most `max` lines (the last then says how many more).
 */
export function prettyLines(value, { indent = 2, max = 5000 } = {}) {
  const lines = [];
  let total = 0;
  const push = (line) => {
    total++;
    if (lines.length < max) lines.push(line);
  };
  const put = (v, pad, lead, trail) => {
    const kind = kindOf(v);
    const sp = ' '.repeat(pad);
    if (kind !== 'object' && kind !== 'array') return push([...lead, { text: scalarText(v), kind }, ...trail]);
    const entries = kind === 'array' ? v.map((x) => [null, x]) : Object.entries(v);
    const [open, close] = kind === 'array' ? ['[', ']'] : ['{', '}'];
    if (!entries.length) return push([...lead, { text: open + close, kind: 'punct' }, ...trail]);
    push([...lead, { text: open, kind: 'punct' }]);
    entries.forEach(([k, x], i) => {
      const head = [{ text: sp + ' '.repeat(indent), kind: 'punct' }];
      if (k !== null) head.push({ text: JSON.stringify(k), kind: 'key' }, { text: ': ', kind: 'punct' });
      put(x, pad + indent, head, i < entries.length - 1 ? [{ text: ',', kind: 'punct' }] : []);
    });
    push([{ text: sp + close, kind: 'punct' }, ...trail]);
  };
  put(value, 0, [], []);
  if (total > lines.length) lines.push([{ text: `… ${total - lines.length} more lines`, kind: 'null' }]);
  return lines;
}

/** Pretty-printed JSON as text. */
export const prettyText = (value, indent = 2) => (value === undefined ? 'null' : JSON.stringify(value, null, indent));

/** Steps of a path query, or `{ error }`. */
function steps(q) {
  const out = [];
  let i = 0;
  if (q[0] !== '.' && q[0] !== '[') q = `.${q}`;
  while (i < q.length) {
    const c = q[i];
    if (c === '.') {
      i++;
      if (q[i] === '"') {
        const end = closeQuote(q, i);
        if (end < 0) return { error: 'A quoted key is missing its closing quote.' };
        out.push({ key: JSON.parse(q.slice(i, end + 1)) });
        i = end + 1;
      } else if (q[i] === '[') continue;
      else {
        const m = /^[\w$-]+/.exec(q.slice(i));
        if (m) (out.push({ key: m[0] }), (i += m[0].length));
        else if (i < q.length) return { error: `Expected a key after the dot at position ${i}.` };
      }
    } else if (c === '[') {
      const end = q.indexOf(']', i);
      if (end < 0) return { error: 'A [ is missing its ].' };
      const inner = q.slice(i + 1, end).trim();
      if (inner === '') out.push({ each: true });
      else if (/^-?\d+$/.test(inner)) out.push({ index: Number(inner) });
      else if (inner[0] === '"') {
        try {
          out.push({ key: JSON.parse(inner) });
        } catch {
          return { error: `${inner} isn't a quoted key.` };
        }
      } else return { error: `[${inner}] isn't an index: use [0], [-1], [] or ["key"].` };
      i = end + 1;
    } else return { error: `Unexpected "${c}" at position ${i}: a path reads like .items[0].name.` };
  }
  return out;
}

function closeQuote(q, from) {
  for (let i = from + 1; i < q.length; i++) {
    if (q[i] === '\\') i++;
    else if (q[i] === '"') return i;
  }
  return -1;
}

const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : `a ${kindOf(v)}`);

/**
 * Runs a jq-like query on `value`: `{ values }` (what matched, in order) or `{ error }` saying what is wrong.
 * `.a.b[0]`, `.["odd key"]`, `.items[]` (every item), `.items[-1]`, then `| length` or `| keys`.
 */
export function query(value, text) {
  const [pathText, ...pipes] = String(text ?? '').split('|').map((s) => s.trim());
  const parsed = steps(pathText || '.');
  if (parsed.error) return parsed;
  let values = [value];
  for (const [n, s] of parsed.entries()) {
    const next = [];
    for (const v of values) {
      if (s.key !== undefined) {
        if (v === null || v === undefined) next.push(null);
        else if (!isObject(v)) return { error: `Can't take "${s.key}" from ${describe(v)}${n ? ` (after ${pathSoFar(parsed, n)})` : ''}.` };
        else next.push(v[s.key] === undefined ? null : v[s.key]);
      } else if (s.index !== undefined) {
        if (v === null || v === undefined) next.push(null);
        else if (!Array.isArray(v)) return { error: `Can't index ${describe(v)} with [${s.index}].` };
        else next.push(v[s.index < 0 ? v.length + s.index : s.index] ?? null);
      } else if (Array.isArray(v)) next.push(...v);
      else if (isObject(v)) next.push(...Object.values(v));
      else return { error: `Can't go through the items of ${describe(v)}.` };
    }
    values = next;
  }
  for (const p of pipes) {
    if (p === 'length') values = values.map((v) => (Array.isArray(v) || typeof v === 'string' ? v.length : isObject(v) ? Object.keys(v).length : v === null ? 0 : v));
    else if (p === 'keys') {
      if (values.some((v) => !isObject(v) && !Array.isArray(v))) return { error: 'keys needs objects or arrays.' };
      values = values.map((v) => (Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v)));
    } else return { error: `"| ${p}" isn't known: | length and | keys are.` };
  }
  return { values };
}

function pathSoFar(parsed, n) {
  return parsed.slice(0, n).map((s) => (s.key !== undefined ? `.${s.key}` : s.index !== undefined ? `[${s.index}]` : '[]')).join('') || '.';
}
