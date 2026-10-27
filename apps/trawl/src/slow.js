// /explain-slow: a statement the app runs slowly (Sonar hands one over with what Application Insights
// measured) planned, never run, and Claude asked which indexes would help. Pure: actions.js connects,
// asks the server for the plan and the indexes, and asks Claude.
import { findObject, objectName } from './schema.js';
import { mask, scriptVariables } from './sql.js';
import { tableLine } from './ai.js';
import { columnNames } from './scriptall.js';
import { wrap } from '@fleet/kit/text.js';

// A parameter's type by its name, when nothing in the statement says: the last word of it, as an
// ORM names them (@__customerId_0 is customerId). Only a guess, and said to be one.
const BY_NAME = [
  [/^(is|has|can)[A-Z_]|(flag|enabled|active|deleted)$/i, 'bit'],
  [/guid|uuid/i, 'uniqueidentifier'],
  [/date|time|(At|On)$/, 'datetime2'],
  [/(amount|price|total|cost|rate|balance)$/i, 'decimal(18, 2)'],
  [/(id|count|number|no|qty|quantity|year|age|page|size|top|skip|take|limit|offset|version)$/i, 'int'],
];
export const DEFAULT_TYPE = 'nvarchar(4000)';

/** A parameter's bare name: @__customerId_0 → customerId, @p0 → '' (says nothing). */
export const bareName = (name) => String(name).replace(/^@+/, '').replace(/^_+/, '').replace(/_\d+$/, '').replace(/^p\d+$/i, '');

/** A guess at a parameter's type from its name alone, or null. */
export function typeByName(name) {
  const n = bareName(name);
  if (!n) return null;
  return BY_NAME.find(([re]) => re.test(n))?.[1] ?? null;
}

// The mask (sql.js) turns a quoted name into a run of \u0001, which is read back from the text.
const NAME = String.raw`(?:\u0001+|\[[^\]]+\]|"[^"]+"|\`[^\`]+\`|[\w#$]+)`;
const QUALIFIED = String.raw`${NAME}(?:\s*\.\s*${NAME}){0,2}`;
const unquote = (s) => s.trim().replace(/^[[`"](.*)[\]`"]$/s, '$1');

/** The tables and views a statement reads or writes, found in `schema`: FROM, JOIN, UPDATE, INTO, APPLY, DELETE. */
export function tablesIn(sql, schema) {
  const m = mask(String(sql ?? ''));
  const src = String(sql ?? '');
  const out = [];
  for (const hit of m.matchAll(new RegExp(String.raw`\b(?:FROM|JOIN|UPDATE|INTO|APPLY|DELETE)\s+(${QUALIFIED})`, 'gi'))) {
    // The mask blanks quoted names, so the name is read from the text at the same place.
    const at = hit.index + hit[0].length - hit[1].length;
    const o = findObject(schema, src.slice(at, at + hit[1].length).replace(/\s+/g, ''));
    if (o && (o.kind === 'table' || o.kind === 'view') && !out.includes(o)) out.push(o);
  }
  return out;
}

/**
 * The type of each parameter the statement uses: the column it's compared with (`o.CustomerId = @c`,
 * `@c = CustomerId`, `LIKE`, `IN (@c`) in the tables it names, else a guess from its name, else
 * DEFAULT_TYPE. `declared` (name → type, lower-case names) wins over both: what you DECLAREd yourself.
 * Returns [{ name, type, from: 'declared' | 'column' | 'name' | 'default', column? }].
 */
export function parameterTypes(sql, schema, { declared = {} } = {}) {
  const text = String(sql ?? '');
  const m = mask(text);
  const tables = schema ? tablesIn(text, schema) : [];
  const columnType = (name) => {
    const n = unquote(name).toLowerCase();
    for (const t of tables) {
      const c = t.columns.find((x) => x.name.toLowerCase() === n);
      if (c) return { type: c.type, column: `${objectName(t)}.${c.name}` };
    }
    return null;
  };
  const OP = String.raw`(?:=|<>|!=|<=|>=|<|>|\bLIKE\b|\bIN\s*\()`;
  return scriptVariables(text).map(({ name }) => {
    const k = name.toLowerCase();
    if (declared[k]) return { name, type: declared[k], from: 'declared' };
    const p = name.replace(/[$]/g, '\\$');
    const before = new RegExp(String.raw`(${QUALIFIED})\s*${OP}\s*${p}(?![\w@#$])`, 'i').exec(m);
    const after = new RegExp(String.raw`${p}(?![\w@#$])\s*(?:=|<>|!=|<=|>=|<|>)\s*(${QUALIFIED})`, 'i').exec(m);
    for (const hit of [before, after]) {
      if (!hit) continue;
      const at = hit.index + hit[0].indexOf(hit[1]);
      const ref = text.slice(at, at + hit[1].length).replace(/\s+/g, '');
      const found = columnType(ref.split('.').at(-1));
      if (found) return { name, type: found.type, from: 'column', column: found.column };
    }
    const guess = typeByName(name);
    return guess ? { name, type: guess, from: 'name' } : { name, type: DEFAULT_TYPE, from: 'default' };
  });
}

/** The types the console's own DECLAREs give its variables: name (lower case) → type. */
export function declaredTypes(text) {
  const out = {};
  const m = mask(String(text ?? ''));
  const src = String(text ?? '');
  // A DECLARE ends at its semicolon, or else at the end of its line.
  for (const d of m.matchAll(/\bDECLARE\s+([^;\n]*)/gi)) {
    const body = src.slice(d.index + d[0].length - d[1].length, d.index + d[0].length);
    for (const part of body.split(/,(?![^(]*\))/)) {
      const v = /^\s*(@[\w@#$]+)\s+(?:AS\s+)?([\w]+(?:\s*\([^)]*\))?)/i.exec(part);
      if (v && !/^TABLE\b/i.test(v[2])) out[v[1].toLowerCase()] = v[2].replace(/\s+/g, ' ');
    }
  }
  return out;
}

/**
 * The statement made ready to plan: { script, params, note }. On SQL Server each @parameter it uses is
 * DECLAREd first (with no value, so the optimizer plans for an unknown one, as for a parameter it hasn't
 * sniffed); on Postgres ($1) and MySQL (?) they become NULL, since neither plans a statement with
 * placeholders. Nothing here runs it: the script only goes under SHOWPLAN_TEXT or EXPLAIN.
 */
export function prepareStatement(sql, { schema = null, kind = 'sqlserver', declared = {} } = {}) {
  const text = String(sql ?? '').trim().replace(/;\s*$/, '');
  if (kind === 'postgres' || kind === 'mysql') {
    const m = mask(text);
    const re = kind === 'postgres' ? /\$(\d+)\b/g : /\?/g;
    const params = [...new Set([...m.matchAll(re)].map((x) => x[0]))].map((name) => ({ name, type: 'NULL', from: 'default' }));
    let out = '';
    let last = 0;
    for (const x of m.matchAll(re)) {
      out += `${text.slice(last, x.index)}NULL`;
      last = x.index + x[0].length;
    }
    out += text.slice(last);
    return { script: out, params, note: params.length ? `Its parameters (${params.map((p) => p.name).join(', ')}) are NULL in the plan.` : '' };
  }
  const params = parameterTypes(text, schema, { declared });
  const script = params.length ? `DECLARE ${params.map((p) => `${p.name} ${p.type}`).join(', ')};\n${text};` : `${text};`;
  const guessed = params.filter((p) => p.from === 'name' || p.from === 'default').map((p) => p.name);
  return { script, params, note: guessed.length ? `${guessed.join(', ')}: the type${guessed.length === 1 ? ' is a guess' : 's are guesses'}; change the DECLARE and /explain-slow it again if the plan looks off.` : '' };
}

/** What Application Insights measured, in words: "40 calls over the last 24h (contoso-api): p95 2,400 ms, average 821 ms, 2 failed". */
export function measuredText(slow) {
  if (!slow) return '';
  const ms = (n) => `${Math.round(Number(n)).toLocaleString('en')} ms`;
  const head = `${slow.calls ?? '?'} call${slow.calls === 1 ? '' : 's'}${slow.span ? ` over the last ${slow.span}` : ''}${slow.app ? ` (${slow.app})` : ''}`;
  const parts = [slow.p95 != null ? `p95 ${ms(slow.p95)}` : null, slow.avg != null ? `average ${ms(slow.avg)}` : null, slow.failed ? `${slow.failed} failed` : null].filter(Boolean);
  return `${head}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

/** The indexes of `tables`, from buildTableExtras's `indexes` (by "schema.name" in lower case), one per line. */
export function indexText(tables, indexes) {
  const lines = [];
  for (const t of tables) {
    const rows = indexes?.get(objectName(t).toLowerCase()) ?? [];
    if (!rows.length) {
      lines.push(`${objectName(t)}: no indexes${t.kind === 'view' ? ' (a view)' : ' (a heap)'}`);
      continue;
    }
    for (const r of rows) {
      const kind = [r.is_primary_key ? 'primary key' : null, r.is_unique && !r.is_primary_key ? 'unique' : null, r.type_desc ? String(r.type_desc).toLowerCase() : null].filter(Boolean).join(', ');
      const included = r.included ? ` INCLUDE (${columnNames(r.included).join(', ')})` : '';
      lines.push(`${objectName(t)}: ${r.name} (${columnNames(r.columns).join(', ')})${included}${kind ? ` ${kind}` : ''}${r.filter_definition ? ` WHERE ${r.filter_definition}` : ''}`);
    }
  }
  return lines.join('\n');
}

export const SLOW_SYSTEM = `You help a developer speed up one SQL statement their application runs slowly in production. You get the database (its kind on the first line), what Application Insights measured for the statement (calls, average and 95th percentile duration), the statement with its parameters, its estimated execution plan (the statement was not run), the tables it touches with their columns, and the indexes those tables already have. No rows of data.
In plain text with no Markdown headings, at most about 20 short lines:
1. What in the plan most likely makes it slow (scans of big tables, key lookups, sorts, implicit conversions, a missing index warning), given the durations.
2. The index or indexes worth adding, each as a CREATE INDEX statement in one \`\`\`sql code block at the end, named IX_<table>_<columns>; say why each helps and what it costs writes. Don't propose an index that one listed already covers. If no index would help, say so and suggest the change to the statement instead, with no code block.
Write the DDL in the dialect the first line names. Never write DROP, ALTER of anything but an index, or any statement that changes data.`;

/** The prompt for /explain-slow: never rows, only names, the plan, and what was measured. */
export function slowPrompt({ sql, script, plan, database, label = 'SQL Server', how = 'SHOWPLAN_TEXT', slow = null, tables = [], indexes = '', params = [] }) {
  const parts = [`Database: ${database} (${label})`];
  parts.push('', `Measured in production by Application Insights: ${slow ? measuredText(slow) : 'nothing (the statement came from the console)'}`);
  parts.push('', 'Statement:', sql);
  if (params.length) parts.push('', 'Parameters (types as declared for the plan):', ...params.map((p) => `${p.name} ${p.type}${p.from === 'column' ? ` (compared with ${p.column})` : p.from === 'declared' ? '' : ' (a guess)'}`));
  if (script && script.trim() !== `${String(sql).trim().replace(/;\s*$/, '')};`) parts.push('', 'As planned:', script);
  parts.push('', `Estimated plan (${how}):`, plan || '(none came back)');
  parts.push('', 'Tables (schema.table(column type ...)):', tables.length ? tables.map(tableLine).join('\n') : '(none of its tables is in the schema Trawl read)');
  parts.push('', 'Their indexes:', indexes || '(not read)');
  return parts.join('\n');
}

/** Claude's answer split into its words and its DDL: { note, ddl: [statement…] } (every ```sql block). */
export function splitSuggestion(text) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n');
  const ddl = [];
  const note = t
    .replace(/```(?:sql|tsql|t-sql|postgresql|mysql)?[ \t]*\n([\s\S]*?)```/gi, (_, code) => {
      ddl.push(code.trim());
      return '';
    })
    .trim();
  return { note, ddl };
}

/**
 * The console tab /explain-slow leaves: what was measured and where, Claude's suggestion as comments,
 * its DDL as text (nothing runs it: read it, then alt+r if you want it), then the statement as planned
 * so p plans it again after a change.
 */
export function slowConsoleText({ where, slow, note = '', ddl = [], script, paramsNote = '', width = 100 }) {
  const comment = (s) => (s ? wrap(s, width - 3).map((l) => `-- ${l}`.trimEnd()) : []);
  const lines = [...comment(`Slow in production${where ? ` on ${where}` : ''}${slow ? `: ${measuredText(slow)}` : ''}.`)];
  if (note || ddl.length) {
    lines.push('--', ...comment(`Claude's suggestion (nothing has run; read it, then select the CREATE INDEX and alt+r to make it):`), ...comment(note));
    if (ddl.length) lines.push('', ...ddl.map((d) => d.replace(/;?\s*$/, ';')));
  }
  lines.push('', ...comment(`The statement, as planned${paramsNote ? `. ${paramsNote}` : ''}`), script);
  return `${lines.join('\n')}\n`;
}
