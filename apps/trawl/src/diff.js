// Comparing two databases' schemas: what each has that the other hasn't, and what differs (columns'
// types, lengths, nullability, defaults and identity, primary keys, foreign keys, indexes, and views',
// procedures' and functions' definitions, by a hash of their normalised text). Pure: actions.js reads
// both catalogs and shows the text (/diff's by kind, /compare's by here, there and different), and
// the script that would make the first database match the second.
import { createHash } from 'node:crypto';
import { createTableScript, objectName } from './schema.js';
import { mask, quoteIdent } from './sql.js';

// The marker comment lets the demo driver recognise this batch.
export const DIFF_SQL = `-- trawl:diff
SELECT s.name AS [schema], o.name, OBJECT_DEFINITION(o.object_id) AS definition
FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('V', 'P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0
ORDER BY s.name, o.name;
SELECT s.name AS [schema], o.name AS [object], i.name, i.is_unique, i.type_desc, i.filter_definition,
  STUFF((SELECT ', ' + QUOTENAME(c.name) + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END
    FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
    ORDER BY ic.key_ordinal FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '') AS columns,
  STUFF((SELECT ', ' + QUOTENAME(c.name)
    FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
    ORDER BY c.name FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '') AS included
FROM sys.indexes i
JOIN sys.objects o ON o.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type = 'U' AND o.is_ms_shipped = 0 AND i.type > 0 AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.is_hypothetical = 0
ORDER BY s.name, o.name, i.name;
SELECT s.name AS [schema], o.name AS [object], c.name AS [column], dc.name, dc.definition
FROM sys.default_constraints dc
JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
JOIN sys.objects o ON o.object_id = dc.parent_object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type = 'U' AND o.is_ms_shipped = 0
ORDER BY s.name, o.name, c.name;`;

const rowsOf = (set) => (set ? set.rows.map((row) => Object.fromEntries(set.columns.map((c, i) => [c.name, row[i]]))) : []);
const key = (s) => String(s).toLowerCase();

/**
 * DIFF_SQL's result sets as { definitions, indexes, defaults }: definitions by "schema.name" (lower
 * case), each index { table: "schema.name", name, unique, type, columns, included, filter }, and the
 * columns' defaults by "schema.table.column" (lower case) as { name, definition }.
 */
export function buildExtras(sets) {
  const definitions = new Map(rowsOf(sets[0]).map((r) => [key(`${r.schema}.${r.name}`), r.definition == null ? null : String(r.definition)]));
  const indexes = rowsOf(sets[1]).map((r) => ({
    table: `${r.schema}.${r.object}`,
    name: r.name,
    unique: Boolean(r.is_unique),
    type: String(r.type_desc ?? 'NONCLUSTERED').toUpperCase(),
    columns: r.columns ?? '',
    included: r.included ?? '',
    filter: r.filter_definition ?? '',
  }));
  const defaults = new Map(rowsOf(sets[2]).map((r) => [key(`${r.schema}.${r.object}.${r.column}`), { name: r.name, definition: String(r.definition) }]));
  return { definitions, indexes, defaults };
}

// The text a definition's lines are shown from: line endings, trailing spaces and blank lines at the ends aside.
const normaliseDefinition = (text) =>
  String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();

/**
 * A definition as it's hashed: every run of whitespace outside strings and comments one space (so
 * indenting it again changes nothing, while a changed string or comment does), and CREATE OR ALTER
 * read as CREATE, which is how a script that put it there may have worded it.
 */
export function normaliseForHash(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const m = mask(src);
  let out = '';
  let gap = false;
  for (let i = 0; i < src.length; i++) {
    // The mask keeps a character as it is outside comments, strings and quoted names.
    if (m[i] === src[i] && /\s/.test(src[i])) {
      gap = true;
      continue;
    }
    if (gap && out) out += ' ';
    gap = false;
    out += src[i];
  }
  return out.replace(/\bCREATE OR ALTER\b/i, 'CREATE');
}

/** The SHA-256 of a definition's normalised text, in hex; null when it couldn't be read. */
export const definitionHash = (text) => (text == null ? null : createHash('sha256').update(normaliseForHash(text)).digest('hex'));

const defaultText = (c) => (c.default ? ` default ${c.default.definition}` : '');
const columnText = (c) => `${c.type}${c.identity ? ' identity' : ''} ${c.nullable ? 'null' : 'not null'}${defaultText(c)}`;

/** What differs between two versions of a column, each "what here → what there". */
export function columnDelta(a, b) {
  const out = [];
  if (key(a.type) !== key(b.type)) out.push(`type ${a.type} → ${b.type}`);
  if (a.nullable !== b.nullable) out.push(`${a.nullable ? 'null' : 'not null'} → ${b.nullable ? 'null' : 'not null'}`);
  if (a.identity !== b.identity) out.push(`identity ${a.identity ? 'yes' : 'no'} → ${b.identity ? 'yes' : 'no'}`);
  if ((a.default?.definition ?? null) !== (b.default?.definition ?? null)) out.push(`default ${a.default?.definition ?? 'none'} → ${b.default?.definition ?? 'none'}`);
  return out;
}
const fkText = (f) => `(${f.columns.map((c) => c[0]).join(', ')}) → ${f.to} (${f.columns.map((c) => c[1]).join(', ')})`;
const indexText = (i) => `${i.unique ? 'unique ' : ''}${i.type.toLowerCase()} (${i.columns})${i.included ? ` include (${i.included})` : ''}${i.filter ? ` where ${i.filter}` : ''}`;

/**
 * What differs between `left` and `right`, each { schema, definitions, indexes } (buildSchema and
 * buildExtras). A list of { kind, name, change, … }: `change` is 'left' (only the left has it),
 * 'right' (only the right) or 'changed'. Kinds: table, view, procedure, function (whole objects), and
 * column, primary key, foreign key, index (inside a table both have, `table` naming it).
 */
export function schemaDiff(left, right) {
  const out = [];
  const objs = (side) => new Map(side.schema.objects.filter((o) => o.kind !== 'other').map((o) => [key(objectName(o)), o]));
  const [lo, ro] = [objs(left), objs(right)];
  const names = [...new Set([...lo.keys(), ...ro.keys()])].sort();
  for (const n of names) {
    const [l, r] = [lo.get(n), ro.get(n)];
    if (!l || !r || l.kind !== r.kind) {
      if (l) out.push({ kind: l.kind, name: objectName(l), change: 'left', left: l, hashes: [definitionHash(left.definitions?.get(n)), null] });
      if (r) out.push({ kind: r.kind, name: objectName(r), change: 'right', right: r, hashes: [null, definitionHash(right.definitions?.get(n))] });
      continue;
    }
    if (l.kind === 'table') {
      out.push(...tableDiff(l, r, left, right));
      continue;
    }
    const [ld, rd] = [left.definitions?.get(n), right.definitions?.get(n)];
    // A definition one side can't read (encrypted, no VIEW DEFINITION) can't be compared.
    const hashes = [definitionHash(ld), definitionHash(rd)];
    if (ld != null && rd != null && hashes[0] !== hashes[1]) out.push({ kind: l.kind, name: objectName(l), change: 'changed', left: l, right: r, hashes, lines: lineDiff(normaliseDefinition(ld), normaliseDefinition(rd)) });
  }
  // Foreign keys and indexes, on the tables both sides have (a new table's come with it).
  const both = (table) => lo.get(key(table))?.kind === 'table' && ro.get(key(table))?.kind === 'table';
  const fks = (side) => new Map(side.schema.foreignKeys.filter((f) => both(f.from)).map((f) => [key(`${f.from}.${f.name}`), f]));
  const [lf, rf] = [fks(left), fks(right)];
  for (const n of [...new Set([...lf.keys(), ...rf.keys()])].sort()) {
    const [l, r] = [lf.get(n), rf.get(n)];
    if (l && r && fkText(l) === fkText(r)) continue;
    const f = l ?? r;
    out.push({ kind: 'foreign key', table: f.from, name: f.name, change: !l ? 'right' : !r ? 'left' : 'changed', left: l, right: r });
  }
  const idx = (side) => new Map((side.indexes ?? []).filter((i) => both(i.table)).map((i) => [key(`${i.table}.${i.name}`), i]));
  const [li, ri] = [idx(left), idx(right)];
  for (const n of [...new Set([...li.keys(), ...ri.keys()])].sort()) {
    const [l, r] = [li.get(n), ri.get(n)];
    if (l && r && indexText(l) === indexText(r)) continue;
    const i = l ?? r;
    out.push({ kind: 'index', table: i.table, name: i.name, change: !l ? 'right' : !r ? 'left' : 'changed', left: l, right: r });
  }
  return out;
}

// A table's columns, each with its default ({ name, definition } or null) when that side's were read.
const withDefaults = (o, side) => (side.defaults ? o.columns.map((c) => ({ ...c, default: side.defaults.get(key(`${objectName(o)}.${c.name}`)) ?? null })) : o.columns);

function columnDiffs(l, r, left, right) {
  const out = [];
  const table = objectName(l);
  // Defaults are compared only when both sides' were read (SQL Server's catalog).
  const both = Boolean(left.defaults && right.defaults);
  const [lcols, rcols] = both ? [withDefaults(l, left), withDefaults(r, right)] : [l.columns, r.columns];
  const [lc, rc] = [new Map(lcols.map((c) => [key(c.name), c])), new Map(rcols.map((c) => [key(c.name), c]))];
  for (const c of lcols) {
    const other = rc.get(key(c.name));
    if (!other) out.push({ kind: 'column', table, name: c.name, change: 'left', left: c });
    else if (columnText(c) !== columnText(other)) out.push({ kind: 'column', table, name: c.name, change: 'changed', left: c, right: other });
  }
  for (const c of rcols) if (!lc.has(key(c.name))) out.push({ kind: 'column', table, name: c.name, change: 'right', right: c });
  return out;
}

function tableDiff(l, r, left, right) {
  const out = columnDiffs(l, r, left, right);
  const pk = (o) => o.columns.filter((c) => c.pk).map((c) => c.name).join(', ');
  if (key(pk(l)) !== key(pk(r))) out.push({ kind: 'primary key', table: objectName(l), name: objectName(l), change: 'changed', left: pk(l), right: pk(r) });
  return out;
}

/**
 * The lines of `a` and `b` as a diff: [' ', line] kept, ['-', line] only in a, ['+', line] only in b.
 * A longest-common-subsequence diff, which is plenty for a view's or procedure's text.
 */
export function lineDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  // Too big to compare line by line in reasonable time: say it all changed.
  if (x.length * y.length > 4_000_000) return [...x.map((l) => ['-', l]), ...y.map((l) => ['+', l])];
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let [i, j] = [0, 0];
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) (out.push([' ', x[i]]), i++, j++);
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(['-', x[i++]]);
    else out.push(['+', y[j++]]);
  }
  while (i < x.length) out.push(['-', x[i++]]);
  while (j < y.length) out.push(['+', y[j++]]);
  return out;
}

const KIND_ORDER = ['table', 'view', 'procedure', 'function'];
const SECTION = { table: 'Tables', view: 'Views', procedure: 'Procedures', function: 'Functions' };
const MARK = { left: '<', right: '>', changed: '~' };

/**
 * The comparison as text for the viewer: one section per kind of object, `<` for what only the left
 * has, `>` for what only the right has, `~` for what differs, with the details under each table and
 * the changed lines of each definition (a few lines of context around them).
 */
export function diffText(changes, { left, right }) {
  const lines = [`${left}  ←→  ${right}`, `<  only in ${left}    >  only in ${right}    ~  different`, ''];
  if (!changes.length) return [...lines, 'The schemas are the same: the same tables, columns, keys, indexes and definitions.'].join('\n');
  const tableParts = new Map();
  for (const c of changes) if (c.table) (tableParts.get(key(c.table)) ?? tableParts.set(key(c.table), []).get(key(c.table))).push(c);
  for (const kind of KIND_ORDER) {
    const whole = changes.filter((c) => c.kind === kind && !c.table);
    const names = [...new Set([...whole.map((c) => key(c.name)), ...(kind === 'table' ? tableParts.keys() : [])])].sort();
    if (!names.length) continue;
    lines.push(SECTION[kind]);
    for (const n of names) {
      const w = whole.find((c) => key(c.name) === n);
      const parts = kind === 'table' ? (tableParts.get(n) ?? []) : [];
      if (w) {
        lines.push(`  ${MARK[w.change]} ${w.name}${w.change === 'changed' ? ': the definitions differ' : ''}`);
        if (w.lines) lines.push(...contextLines(w.lines).map((l) => `      ${l}`));
      } else if (parts.length) lines.push(`  ~ ${parts[0].table}`);
      for (const p of parts) lines.push(`      ${partText(p)}`);
    }
    lines.push('');
  }
  const counts = ['left', 'right', 'changed'].map((ch) => changes.filter((c) => c.change === ch).length);
  lines.push(`${counts[0]} only in ${left} · ${counts[1]} only in ${right} · ${counts[2]} different`);
  return lines.join('\n');
}

function partText(p) {
  const m = MARK[p.change];
  if (p.kind === 'column') return p.change === 'changed' ? `~ ${p.name}: ${columnText(p.left)} → ${columnText(p.right)}` : `${m} column ${p.name} ${columnText(p.left ?? p.right)}`;
  if (p.kind === 'primary key') return `~ primary key: (${p.left || 'none'}) → (${p.right || 'none'})`;
  if (p.kind === 'foreign key') return p.change === 'changed' ? `~ foreign key ${p.name}: ${fkText(p.left)} → ${fkText(p.right)}` : `${m} foreign key ${p.name} ${fkText(p.left ?? p.right)}`;
  return p.change === 'changed' ? `~ index ${p.name}: ${indexText(p.left)} → ${indexText(p.right)}` : `${m} index ${p.name} ${indexText(p.left ?? p.right)}`;
}

// The changed lines with two lines of context, "…" where unchanged ones are left out.
function contextLines(diff, around = 2) {
  const keep = diff.map((d, i) => diff.slice(Math.max(0, i - around), i + around + 1).some((x) => x[0] !== ' '));
  const out = [];
  diff.forEach(([mark, text], i) => {
    if (keep[i]) out.push(`${mark === ' ' ? ' ' : mark} ${text}`);
    else if (keep[i - 1] || i === 0) out.push('  …');
  });
  return out;
}

const ORDER = ['table', 'column', 'primary key', 'foreign key', 'index', 'view', 'procedure', 'function'];
const shortHash = (h) => (h ? h.slice(0, 12) : 'unreadable');

/**
 * /compare's text: the changes of schemaDiff(here, there) grouped as only here, only there and
 * different, by kind inside each, with what differs ("this here → that there") and the definitions'
 * hashes and changed lines.
 */
export function compareText(changes, { here, there }) {
  const lines = [`${here}  →  ${there}`, '"a → b": a here, b there. Definitions by a hash of their text, whitespace aside.', ''];
  if (!changes.length) return [...lines, 'The schemas are the same: the same tables, columns, keys, indexes and definitions.'].join('\n');
  const sorted = (list) => [...list].sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind) || key(`${x.table ?? ''}.${x.name}`).localeCompare(key(`${y.table ?? ''}.${y.name}`)));
  const label = (c) => (c.table && c.kind !== 'primary key' ? `${c.table}.${c.name}` : c.name);
  const about = (c, side) => {
    const it = c[side];
    if (c.kind === 'table') return `${it.columns.length} column${it.columns.length === 1 ? '' : 's'}`;
    if (c.kind === 'column') return columnText(it);
    if (c.kind === 'foreign key') return fkText(it);
    if (c.kind === 'index') return indexText(it);
    if (DROP[c.kind]) return `definition ${shortHash(c.hashes?.[side === 'left' ? 0 : 1])}`;
    return '';
  };
  const changed = (c) => {
    if (c.kind === 'column') return columnDelta(c.left, c.right).join('; ');
    if (c.kind === 'primary key') return `(${c.left || 'none'}) → (${c.right || 'none'})`;
    if (c.kind === 'foreign key') return `${fkText(c.left)} → ${fkText(c.right)}`;
    if (c.kind === 'index') return `${indexText(c.left)} → ${indexText(c.right)}`;
    return `definition ${shortHash(c.hashes?.[0])} → ${shortHash(c.hashes?.[1])}`;
  };
  for (const [change, title] of [['left', `Only in ${here}`], ['right', `Only in ${there}`], ['changed', 'Different']]) {
    const list = sorted(changes.filter((c) => c.change === change));
    lines.push(`${title} (${list.length})`);
    if (!list.length) lines.push('  nothing');
    for (const c of list) {
      const what = change === 'changed' ? changed(c) : about(c, change);
      lines.push(`  ${c.kind.padEnd(12)} ${label(c)}${what ? `: ${what}` : ''}`);
      if (c.lines) lines.push(...contextLines(c.lines).map((l) => `      ${l}`));
    }
    lines.push('');
  }
  const counts = ['left', 'right', 'changed'].map((ch) => changes.filter((c) => c.change === ch).length);
  lines.push(`${counts[0]} only in ${here} · ${counts[1]} only in ${there} · ${counts[2]} different`);
  return lines.join('\n');
}

const qname = (dotted) => {
  const [schema, ...rest] = String(dotted).split('.');
  return `${quoteIdent(schema)}.${quoteIdent(rest.join('.'))}`;
};
const DROP = { view: 'VIEW', procedure: 'PROCEDURE', function: 'FUNCTION' };
const createOrAlter = (definition) => String(definition).replace(/^(\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*)CREATE\s+(?!OR\s+ALTER\b)/i, '$1CREATE OR ALTER ');

// A declared type's parts: nvarchar(50) → { base: 'nvarchar', size: 50 }, decimal(10,2) → size 10, scale 2.
function typeParts(type) {
  const m = /^\s*(\w+)\s*(?:\(\s*(max|\d+)\s*(?:,\s*(\d+)\s*)?\))?\s*$/i.exec(String(type));
  if (!m) return { base: key(type), size: null, scale: null };
  return { base: key(m[1]), size: m[2] == null ? null : key(m[2]) === 'max' ? Infinity : Number(m[2]), scale: m[3] == null ? null : Number(m[3]) };
}
const TEXT = { char: 'a', varchar: 'a', nchar: 'n', nvarchar: 'n' };
const BINARY = new Set(['binary', 'varbinary']);
const INTS = ['bit', 'tinyint', 'smallint', 'int', 'bigint'];
const INT_DIGITS = { bit: 1, tinyint: 3, smallint: 5, int: 10, bigint: 19 };
// A date or time type, and the types each one fits into without losing anything.
const WIDER_TIME = { date: ['datetime', 'datetime2', 'datetimeoffset', 'smalldatetime'], smalldatetime: ['datetime', 'datetime2', 'datetimeoffset'], datetime: ['datetime2', 'datetimeoffset'], datetime2: ['datetime2', 'datetimeoffset'] };

/**
 * Why changing a column's type from `from` to `to` could lose data or fail on rows already there
 * (a shorter string, a smaller number, a type that doesn't convert every value); null when every
 * value fits. Lengths: a bare char or binary is 1, a bare datetime2 is 7.
 */
export function typeRisk(from, to) {
  const [a, b] = [typeParts(from), typeParts(to)];
  if (a.base === b.base && a.size === b.size && a.scale === b.scale) return null;
  const len = (p) => p.size ?? (p.base === 'datetime2' || p.base === 'datetimeoffset' ? 7 : 1);
  if (TEXT[a.base] && TEXT[b.base]) {
    if (TEXT[a.base] === 'n' && TEXT[b.base] === 'a') return `${from} to ${to} loses characters outside the code page`;
    if (len(b) < len(a)) return `${to} is shorter than ${from}: longer values don't fit`;
    return null;
  }
  if (BINARY.has(a.base) && BINARY.has(b.base)) return len(b) < len(a) ? `${to} is shorter than ${from}: longer values don't fit` : null;
  if (INTS.includes(a.base) && INTS.includes(b.base)) return INTS.indexOf(b.base) < INTS.indexOf(a.base) ? `${to} is smaller than ${from}: larger values don't fit` : null;
  const decimal = (p) => p.base === 'decimal' || p.base === 'numeric';
  // A bare decimal is decimal(18,0).
  const whole = (p) => (p.size ?? 18) - (p.scale ?? 0);
  if (INTS.includes(a.base) && decimal(b)) return whole(b) >= INT_DIGITS[a.base] ? null : `${to} has fewer whole digits than ${from} can hold`;
  if (decimal(a) && decimal(b)) return (b.scale ?? 0) >= (a.scale ?? 0) && whole(b) >= whole(a) ? null : `${to} has fewer digits than ${from}: values would be rounded or not fit`;
  if ((a.base === 'real' && b.base === 'float') || (['bit', 'tinyint', 'smallint', 'int'].includes(a.base) && b.base === 'float')) return null;
  if (a.base === 'float' && b.base === 'float') return (b.size ?? 53) >= (a.size ?? 53) ? null : `${to} keeps fewer digits than ${from}`;
  if (WIDER_TIME[a.base]?.includes(b.base)) return a.base === b.base && len(b) < len(a) ? `${to} keeps fewer fractions of a second than ${from}` : null;
  if (a.base === 'time' && b.base === 'time') return len(b) < len(a) ? `${to} keeps fewer fractions of a second than ${from}` : null;
  return `${from} to ${to} may not convert every value`;
}

/** Why an ALTER COLUMN from `from` to `to` isn't safe to run as it is, or null. */
export function alterRisk(from, to) {
  if (from.pk) return 'it is in the primary key, which has to be dropped and made again around the change';
  const reasons = [];
  if (key(from.type) !== key(to.type)) {
    const r = typeRisk(from.type, to.type);
    if (r) reasons.push(r);
  }
  if (from.nullable && !to.nullable) reasons.push('NOT NULL fails while any row holds NULL there: fill those in first');
  return reasons.length ? reasons.join('; ') : null;
}

// The new tables in an order where a table comes after those it refers to (a circle keeps its order).
function tablesInOrder(list, schema) {
  const names = new Set(list.map((c) => key(c.name)));
  const deps = new Map(list.map((c) => [key(c.name), new Set((schema?.foreignKeys ?? []).filter((f) => key(f.from) === key(c.name) && names.has(key(f.to)) && key(f.to) !== key(c.name)).map((f) => key(f.to)))]));
  const out = [];
  const left = [...list];
  while (left.length) {
    const i = left.findIndex((c) => [...deps.get(key(c.name))].every((d) => out.some((o) => key(o.name) === d)));
    out.push(...left.splice(i < 0 ? 0 : i, 1));
  }
  return out;
}

const mentions = (list, column) => new RegExp(`\\[${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/]/g, ']]')}\\]`, 'i').test(list ?? '');

/**
 * T-SQL that makes the left database match the right one, to read through and run on the left, in
 * the order SQL Server needs: foreign keys and indexes that go, or that stand on a column about to
 * change, are dropped first; then new tables (each after the tables it refers to, with its defaults
 * and indexes), columns, and the keys and indexes made (again) last. A column changes in place with
 * ALTER COLUMN where every value fits; where data could be lost or the change fail (a shorter type,
 * NOT NULL, a key column) it comes commented out with why, and so does dropping a table or a column.
 * Views, procedures and functions go one to a batch, with CREATE OR ALTER for those that differ.
 * `leftSchema`, `leftIndexes` (what stands on a changing column) and the right side's `rightIndexes`
 * and `rightDefaults` (buildExtras) are optional; without them less is scripted.
 */
export function syncScript(changes, { left, right, rightSchema, rightDefinitions, rightIndexes = [], rightDefaults = null, leftSchema = null, leftIndexes = [] }) {
  const out = [
    `-- Makes ${left} match ${right}, from Trawl's schema comparison. Read it through before running it on ${left}.`,
    '-- What would lose data (dropping a table or a column, a column made shorter or NOT NULL) is commented out with why: uncomment it on purpose.',
    "-- Check constraints, triggers and permissions aren't compared.",
    '',
  ];
  const dropKeys = [];
  const dropIndexes = [];
  const drops = [];
  const tables = [];
  const columns = [];
  const makeIndexes = [];
  const makeKeys = [];
  const modules = [];
  const fkSql = (f) => {
    const list = (i) => f.columns.map((c) => quoteIdent(c[i])).join(', ');
    return `ALTER TABLE ${qname(f.from)} ADD CONSTRAINT ${quoteIdent(f.name)} FOREIGN KEY (${list(0)}) REFERENCES ${qname(f.to)} (${list(1)});`;
  };
  const indexSql = (i) => `CREATE ${i.unique ? 'UNIQUE ' : ''}${/^(CLUSTERED|NONCLUSTERED)$/.test(i.type) ? `${i.type} ` : ''}INDEX ${quoteIdent(i.name)} ON ${qname(i.table)} (${i.columns})${i.included ? ` INCLUDE (${i.included})` : ''}${i.filter ? ` WHERE ${i.filter}` : ''};`;
  const columnSql = (c) => `${quoteIdent(c.name)} ${c.type} ${c.nullable ? 'NULL' : 'NOT NULL'}`;
  const definition = (o) => rightDefinitions?.get(key(objectName(o)));
  const defaultsOf = (table) => new Map([...(rightDefaults ?? new Map())].filter(([k]) => k.startsWith(`${key(table)}.`)).map(([k, v]) => [k.slice(key(table).length + 1), v]));
  // What these changes drop anyway, and the columns an ALTER COLUMN changes, by table.
  const gone = new Set();
  const altered = new Map();
  for (const c of tablesInOrder(changes.filter((c) => c.kind === 'table' && c.change === 'right'), rightSchema)) {
    tables.push(createTableScript(c.right, rightSchema, { extras: { defaults: defaultsOf(c.name) } }));
    for (const i of rightIndexes.filter((i) => key(i.table) === key(c.name))) makeIndexes.push(indexSql(i));
  }
  for (const c of changes) {
    if (c.kind === 'table') {
      if (c.change === 'left') drops.push(`-- DROP TABLE ${qname(c.name)};`);
    } else if (DROP[c.kind]) {
      if (c.change === 'left') drops.push(`DROP ${DROP[c.kind]} ${qname(c.name)};`);
      else {
        const text = definition(c.right);
        modules.push(text ? `${c.change === 'changed' ? createOrAlter(text.trim()) : text.trim()}\nGO` : `-- ${c.name}: its definition couldn't be read on ${right}.`);
      }
    } else if (c.kind === 'column') {
      const t = qname(c.table);
      const col = quoteIdent(c.name);
      if (c.change === 'left') {
        columns.push(`-- ALTER TABLE ${t} DROP COLUMN ${col};${c.left.default ? ` -- drop its default ${quoteIdent(c.left.default.name)} first` : ''}`);
        continue;
      }
      if (c.change === 'right') {
        const d = c.right.default;
        const notes = [c.right.identity ? 'identity: add IDENTITY(1,1) by hand' : '', c.right.nullable || d ? '' : 'NOT NULL: a table with rows needs a DEFAULT too'].filter(Boolean);
        columns.push(`ALTER TABLE ${t} ADD ${columnSql(c.right)}${d ? ` CONSTRAINT ${quoteIdent(d.name)} DEFAULT ${d.definition}` : ''};${notes.length ? ` -- ${notes.join('; ')}` : ''}`);
        continue;
      }
      const shape = key(c.left.type) !== key(c.right.type) || c.left.nullable !== c.right.nullable;
      if (c.left.identity !== c.right.identity) columns.push(`-- ${t}.${col}: IDENTITY can't be added or removed in place; rebuild the table.`);
      else if (shape) {
        const risk = alterRisk(c.left, c.right);
        if (risk) columns.push(`-- ${t}.${col}: ${risk}.`, `-- ALTER TABLE ${t} ALTER COLUMN ${columnSql(c.right)};`);
        else {
          columns.push(`ALTER TABLE ${t} ALTER COLUMN ${columnSql(c.right)};`);
          (altered.get(key(c.table)) ?? altered.set(key(c.table), new Set()).get(key(c.table))).add(key(c.name));
        }
      }
      // Defaults are constraints with names: the old one goes, the new one comes.
      if ((c.left.default?.definition ?? null) !== (c.right.default?.definition ?? null)) {
        if (c.left.default) columns.push(`ALTER TABLE ${t} DROP CONSTRAINT ${quoteIdent(c.left.default.name)};`);
        if (c.right.default) columns.push(`ALTER TABLE ${t} ADD CONSTRAINT ${quoteIdent(c.right.default.name)} DEFAULT ${c.right.default.definition} FOR ${col};`);
      }
    } else if (c.kind === 'primary key') {
      columns.push(`-- ${qname(c.table)}: the primary key is (${c.left || 'none'}) here and (${c.right || 'none'}) there; change it by hand.`);
    } else if (c.kind === 'foreign key') {
      if (c.left) (dropKeys.push(`ALTER TABLE ${qname(c.table)} DROP CONSTRAINT ${quoteIdent(c.name)};`), gone.add(key(`${c.table}.${c.name}`)));
      if (c.right) makeKeys.push(fkSql(c.right));
    } else if (c.kind === 'index') {
      if (c.left) (dropIndexes.push(`DROP INDEX ${quoteIdent(c.name)} ON ${qname(c.table)};`), gone.add(key(`${c.table}.${c.name}`)));
      if (c.right) makeIndexes.push(indexSql(c.right));
    }
  }
  // An ALTER COLUMN fails while a foreign key or an index stands on the column: those go first and
  // are made again after, as they were.
  const touches = (table, cols) => cols.some((name) => altered.get(key(table))?.has(key(name)));
  for (const f of leftSchema?.foreignKeys ?? []) {
    if (gone.has(key(`${f.from}.${f.name}`))) continue;
    if (!touches(f.from, f.columns.map((c) => c[0])) && !touches(f.to, f.columns.map((c) => c[1]))) continue;
    dropKeys.push(`ALTER TABLE ${qname(f.from)} DROP CONSTRAINT ${quoteIdent(f.name)}; -- stands on a column that changes; made again below`);
    makeKeys.push(fkSql(f));
  }
  for (const i of leftIndexes) {
    if (gone.has(key(`${i.table}.${i.name}`)) || !altered.has(key(i.table))) continue;
    if (![...altered.get(key(i.table))].some((name) => mentions(i.columns, name) || mentions(i.included, name))) continue;
    dropIndexes.push(`DROP INDEX ${quoteIdent(i.name)} ON ${qname(i.table)}; -- stands on a column that changes; made again below`);
    makeIndexes.push(indexSql(i));
  }
  const section = (title, list) => (list.length ? [`-- ${title}`, ...list, ''] : []);
  out.push(
    ...section('Foreign keys that go, before anything else', dropKeys),
    ...section('Indexes that go', dropIndexes),
    ...section("Drop what the other side hasn't", drops),
    ...section('New tables', tables),
    ...section('Columns', columns),
    ...section('Indexes', makeIndexes),
    ...section('Foreign keys, once the tables and columns are there', makeKeys),
  );
  if (out.length > 4 && modules.length) out.push('GO', '');
  out.push(...section('Views, procedures and functions', modules));
  return out.join('\n').trimEnd() + '\n';
}
