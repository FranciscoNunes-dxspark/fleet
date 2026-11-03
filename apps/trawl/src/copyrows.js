// /copy-rows: rows of one table, and the rows they refer to through foreign keys, from the database
// you're on to another connection (production to dev, say), with personal data swapped for made-up
// values that stay the same for the same input (so joins still meet). actions.js reads the rows;
// everything here is pure: which columns are personal, the reads, the order, and the script, which
// skips rows the target already has.
import { fakeValue, guessFor } from './generate.js';
import { valueLiteral } from './edit.js';
import { objectName } from './schema.js';

/** `/copy-rows <target> [table] [--where <condition>] [--no-mask]` as { target, table, where, mask }. */
export function parseCopyRowsArgs(rest) {
  let s = String(rest ?? '').trim();
  let mask = true;
  s = s.replace(/(^|\s)--no-mask(?=\s|$)/i, () => ((mask = false), ' ')).trim();
  let where = null;
  const at = s.search(/(^|\s)--where(\s|$)/i);
  if (at >= 0) {
    where = s.slice(at).replace(/^\s*--where\s*/i, '').trim().replace(/^"(.*)"$/s, '$1').trim();
    s = s.slice(0, at).trim();
    if (!where) throw new Error('--where takes a condition: /copy-rows <target> [table] --where "Id < 100"');
  }
  const words = s.match(/"[^"]*"|\S+/g)?.map((w) => w.replace(/^"(.*)"$/, '$1')) ?? [];
  if (words.length > 2) throw new Error(`Too many words before --where: /copy-rows <target> [table] [--where <condition>] [--no-mask]`);
  const [target = null, table = null] = words;
  return { target, table, where, mask };
}

// Column names (lower case, without spaces, _ and -) that hold personal data, and the fake each gets.
// A secret (a password, its hash or salt, a token, a key) gets none: it becomes NULL ('secret').
const PERSONAL = [
  [/password|passwd|^pwd|pwd$|passphrase|hash$|^hash|salt$|token|secret|apikey|accesskey|privatekey|securitystamp|recoverycode|^otp|totp|^pin$|pincode/, 'secret'],
  [/e?mail/, 'email'],
  [/(^|address|client|remote|source|user|last|login)ip$|^ip(address|addr|v4|v6)?$/, 'ip'],
  [/phone|mobile|^tel$|telephone|^fax$|faxnumber|cellular/, 'phone'],
  [/firstname|givenname|forename/, 'first'],
  [/lastname|surname|familyname/, 'last'],
  [/fullname|displayname|contactname|personname|customername|employeename/, 'person'],
  [/zip|postal|postcode/, 'zip'],
  [/address|street|addr\d*$|addressline/, 'street'],
  [/city|town/, 'city'],
  [/birth|^dob$|dateofbirth/, 'birth'],
  [/(^|social)ssn$|^ssn|socialsecurity|^nif$|nif$|^nin$|^nino$|nationalinsurance|taxid|taxnumber|iban|^bic$|swift|accountnumber|accountno|bankaccount|^account(no|num)$|(^|credit|debit)card(number|no|num)?$|cardnumber|^pan$|^cvv|passport|nationalid|idcard|driverslicen[cs]e|licen[cs]enumber/, 'scramble'],
];

// Types that never hold personal data however a column is named (EmailConfirmed bit, TokenExpiresAt
// datetime2), and those that always hold an address.
const NEVER = /^(bit|bool|boolean|tinyint\(1\))$/;
const DATES = /^(date|datetime|datetime2|smalldatetime|datetimeoffset|time|timestamp|timestamptz|interval)\b/;

/**
 * The fake a column of `table` gets (fakeValue's kinds, or 'secret' for one that becomes NULL), or
 * null when it isn't personal data. A plain Name column counts when the table holds people
 * (/generate's guess), not clubs or products. `type`, when given, rules out a flag or a timestamp
 * named like personal data, and a Postgres inet column is an IP address whatever its name.
 */
export function personalKind(column, table = '', type = '') {
  const t = String(type ?? '').trim().toLowerCase();
  if (NEVER.test(t)) return null;
  if (/^(inet|cidr)$/.test(t)) return 'ip';
  const n = String(column).toLowerCase().replace(/[\s_-]+/g, '');
  for (const [re, kind] of PERSONAL) {
    if (!re.test(n)) continue;
    // Only a birth date is personal as a date: a token's expiry or a password's change isn't.
    if (DATES.test(t) && kind !== 'birth') return null;
    return kind;
  }
  return guessFor(column, table) === 'person' ? 'person' : null;
}

const COPYROWS_USAGE = '/copyrows <table> to <connection|environment> [where <condition>] [limit n] [--keep col] [--mask col]';

/**
 * `/copyrows <table> to <target> [where <condition>] [limit n] [--keep col] [--mask col] [--no-mask]`
 * as { table, target, where, limit, overrides, mask }: `where` runs to `limit` or the end, and
 * `overrides` maps a column (lower case, "table.column" for one table's) to 'keep' or 'mask'. --keep
 * and --mask take a column or several with commas, and come anywhere. Nothing typed: table null.
 */
export function parseCopyrowsArgs(rest) {
  let s = String(rest ?? '').trim();
  const overrides = new Map();
  s = s.replace(/(^|\s)--(keep|mask)(?:\s+|=)("[^"]*"|[^\s"]+)/gi, (_, sp, which, list) => {
    for (const name of list.replace(/^"(.*)"$/, '$1').split(',').map((x) => x.trim()).filter(Boolean)) overrides.set(name.toLowerCase(), which.toLowerCase());
    return ' ';
  });
  if (/(^|\s)--(keep|mask)\s*$/i.test(s)) throw new Error(`--keep and --mask take a column, or several with commas: ${COPYROWS_USAGE}`);
  let mask = true;
  s = s.replace(/(^|\s)--no-mask(?=\s|$)/i, () => ((mask = false), ' ')).trim();
  let limit = null;
  s = s.replace(/(?:^|\s)limit\s+(\d+)\s*$/i, (_, n) => ((limit = Number(n)), '')).trim();
  if (limit === 0) throw new Error('limit takes a number of rows above 0.');
  let where = null;
  const at = s.search(/(^|\s)where(\s|$)/i);
  if (at >= 0) {
    where = s.slice(at).replace(/^\s*where\s*/i, '').trim().replace(/^"(.*)"$/s, '$1').trim();
    s = s.slice(0, at).trim();
    if (!where) throw new Error(`where takes a condition: ${COPYROWS_USAGE}`);
  }
  const words = s.match(/"[^"]*"|\S+/g)?.map((w) => w.replace(/^"(.*)"$/, '$1')) ?? [];
  if (!words.length) return { table: null, target: null, where, limit, overrides, mask };
  if (words.length !== 3 || words[1].toLowerCase() !== 'to') throw new Error(`Which table, to where? ${COPYROWS_USAGE}`);
  return { table: words[0], target: words[2], where, limit, overrides, mask };
}

/**
 * "Email=keep, Name=mask, Players.Token=null" (what the question takes) as a map like
 * parseCopyrowsArgs' `overrides`; throws on a rule it doesn't know.
 */
export function parseRuleChanges(text) {
  const out = new Map();
  for (const part of String(text ?? '').split(/[,;]/).map((p) => p.trim()).filter(Boolean)) {
    const m = /^([^=\s]+)\s*[=:\s]\s*(keep|mask|null)$/i.exec(part);
    if (!m) throw new Error(`"${part}" isn't a column and a rule: Email=keep, Name=mask or Token=null.`);
    out.set(m[1].toLowerCase(), m[2].toLowerCase());
  }
  return out;
}

const RULE_WORDS = { email: 'an email', ip: 'an IP address', phone: 'a phone number', first: 'a first name', last: 'a last name', person: "a person's name", zip: 'a postcode', street: 'an address', city: 'a city', birth: 'a birth date', scramble: 'scrambled, letters for letters and digits for digits' };

/**
 * How each of `columns` of `obj` is copied: [{ name, rule, kind, why }], `rule` being 'keep', 'fake'
 * (with fakeValue's `kind`) or 'null'. Personal columns are found by name and type; `overrides`
 * (parseCopyrowsArgs') changes any, by "table.column" before a bare name. A password, hash or token
 * becomes NULL, or is scrambled where the column is NOT NULL. `mask: false` keeps all but overrides.
 */
export function maskingRules(obj, columns, { overrides = new Map(), mask = true } = {}) {
  return columns.map((c) => {
    const col = obj.columns.find((x) => x.name.toLowerCase() === c.name.toLowerCase()) ?? c;
    const name = c.name.toLowerCase();
    const over = overrides.get(`${objectName(obj)}.${name}`.toLowerCase()) ?? overrides.get(`${obj.name}.${name}`.toLowerCase()) ?? overrides.get(name);
    const guessed = personalKind(c.name, obj.name, col.type);
    const as = (kind, why) => (kind === 'secret' ? (col.nullable ? { name: c.name, rule: 'null', why } : { name: c.name, rule: 'fake', kind: 'scramble', why: `${why}; NOT NULL, so scrambled rather than NULL` }) : { name: c.name, rule: 'fake', kind, why });
    if (over === 'keep') return { name: c.name, rule: 'keep', why: 'kept as asked' };
    if (over === 'null') return as('secret', 'asked for');
    if (over === 'mask') return as(guessed ?? 'scramble', 'asked for');
    if (!guessed) return { name: c.name, rule: 'keep', why: '' };
    if (!mask) return { name: c.name, rule: 'keep', why: '--no-mask' };
    return as(guessed, 'by its name');
  });
}

/** A rule as words: "kept", "NULL", "made up: an email". */
export const ruleText = (r) => (r.rule === 'keep' ? 'kept' : r.rule === 'null' ? 'NULL' : `made up: ${RULE_WORDS[r.kind] ?? r.kind}`);

/**
 * The rows of `set` (from `obj`, a schema table) with each personal column's values faked:
 * { rows, masked: [column names], rules }. Keys are faked too when they're personal, the same way
 * everywhere. `rules` (maskingRules') say how; without them the columns are guessed by name.
 */
export function maskRows(obj, set, { kind = 'sqlserver', rules = maskingRules(obj, set.columns) } = {}) {
  const masked = rules.filter((r) => r.rule !== 'keep').map((r) => r.name);
  const cols = set.columns.map((c) => obj.columns.find((x) => x.name.toLowerCase() === c.name.toLowerCase()) ?? c);
  const rows = set.rows.map((row) => row.map((v, i) => (rules[i].rule === 'null' ? null : rules[i].rule === 'fake' ? fakeValue(rules[i].kind, v, cols[i], kind) : v)));
  return { rows, masked, rules };
}
/** The foreign keys from `obj` (schema.foreignKeys entries whose `from` is it). */
export const foreignKeysFrom = (schema, obj) => (schema?.foreignKeys ?? []).filter((f) => f.from.toLowerCase() === objectName(obj).toLowerCase());

/** Why `obj` can't be copied, or null: it must be a table with a primary key, to know a row that's already there. */
export function copyRefusal(obj) {
  if (!obj) return 'there is no such table';
  if (obj.kind !== 'table') return `${objectName(obj)} is a ${obj.kind}, not a table`;
  if (!obj.columns.some((c) => c.pk)) return `${objectName(obj)} has no primary key, so a row already in the target can't be told from a new one`;
  return null;
}

const cell = (set, row, name) => row[set.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase())];

const plainKey = (v) => (v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? v.toString('hex') : typeof v === 'bigint' || typeof v === 'number' ? String(v) : typeof v === 'string' ? v.toLowerCase() : v);

/** A key's values as one string, to tell keys apart (text ignoring case, as SQL Server compares it). */
export const tupleKey = (t) => JSON.stringify(t.map(plainKey));

/** The values (each an array, in `cols`' order) `set`'s rows hold in those columns, without repeats or NULLs. */
export function keyTuples(set, cols) {
  const seen = new Map();
  for (const row of set.rows) {
    const t = cols.map((c) => cell(set, row, c));
    if (t.some((v) => v == null)) continue;
    const k = tupleKey(t);
    if (!seen.has(k)) seen.set(k, t);
  }
  return [...seen.values()];
}

const quoted = (dialect, obj) => `${dialect.quote(obj.schema)}.${dialect.quote(obj.name)}`;
const typeOf = (obj, name) => obj.columns.find((c) => c.name.toLowerCase() === name.toLowerCase())?.type ?? '';

/** The read of the rows to copy: the first `limit` of `obj`, those `where` picks when it's given. */
export const rowsSql = (dialect, obj, { where = null, limit }) => `-- trawl:copy-rows read\n${dialect.selectTop(quoted(dialect, obj), limit, where)};`;

/**
 * The reads of `obj`'s rows whose `cols` hold one of `tuples` (the rows a foreign key refers to), a
 * few hundred values a query.
 */
export function parentSql(dialect, obj, cols, tuples, { chunk = 300 } = {}) {
  const out = [];
  const lit = (v, c) => valueLiteral(v, typeOf(obj, c), dialect.kind);
  for (let i = 0; i < tuples.length; i += chunk) {
    const part = tuples.slice(i, i + chunk);
    const where =
      cols.length === 1
        ? `${dialect.quote(cols[0])} IN (${part.map((t) => lit(t[0], cols[0])).join(', ')})`
        : part.map((t) => `(${cols.map((c, k) => `${dialect.quote(c)} = ${lit(t[k], c)}`).join(' AND ')})`).join(' OR ');
    out.push(`-- trawl:copy-rows read\nSELECT * FROM ${quoted(dialect, obj)} WHERE ${where};`);
  }
  return out;
}

/** A row's primary key, as a string to tell rows apart. */
export const rowKey = (obj, set, row) => tupleKey(obj.columns.filter((c) => c.pk).map((c) => cell(set, row, c.name)));

/**
 * The tables in the order their rows go in: those referred to before those referring to them (a
 * table referring to itself orders its own rows). `groups` are { obj, set } by objectName; `fks` the
 * schema's foreign keys. Returns { order: [names], cycle: bool }.
 */
export function insertOrder(groups, fks) {
  const names = [...groups.keys()];
  const deps = new Map(names.map((n) => [n, new Set()]));
  for (const f of fks) {
    const from = names.find((n) => n.toLowerCase() === f.from.toLowerCase());
    const to = names.find((n) => n.toLowerCase() === f.to.toLowerCase());
    if (from && to && from !== to) deps.get(from).add(to);
  }
  const order = [];
  const left = new Set(names);
  let cycle = false;
  while (left.size) {
    const ready = [...left].filter((n) => [...deps.get(n)].every((d) => !left.has(d)));
    const next = ready.length ? ready : [[...left][0]];
    if (!ready.length) cycle = true;
    for (const n of next) (order.push(n), left.delete(n));
  }
  return { order, cycle };
}

/** A table's rows ordered so a row another row of it refers to (a manager, a parent category) comes first. */
export function selfOrder(obj, set, fks) {
  const self = fks.filter((f) => f.from.toLowerCase() === objectName(obj).toLowerCase() && f.to.toLowerCase() === objectName(obj).toLowerCase());
  if (!self.length) return set.rows;
  const keyOf = (row, cols) => tupleKey(cols.map((c) => cell(set, row, c)));
  // Per foreign key, the first row holding each value it can refer to: looking for it among every row,
  // for every row on every pass, took seconds for a couple of thousand.
  const referred = self.map((f) => {
    const cols = f.columns.map(([, to]) => to);
    const first = new Map();
    for (const r of set.rows) {
      const k = keyOf(r, cols);
      if (!first.has(k)) first.set(k, r);
    }
    return first;
  });
  const placed = new Set();
  const out = [];
  let left = [...set.rows];
  while (left.length) {
    const ready = left.filter((row) =>
      self.every((f, i) => {
        const refs = f.columns.map(([from]) => cell(set, row, from));
        if (refs.some((v) => v == null)) return true;
        const there = referred[i].get(tupleKey(refs));
        return !there || there === row || placed.has(there);
      }),
    );
    const next = ready.length ? ready : left;
    for (const r of next) (out.push(r), placed.add(r));
    left = left.filter((r) => !placed.has(r));
  }
  return out;
}

// Columns no INSERT can give a value: computed ones, and SQL Server's rowversion.
const insertable = (c) => !c.computed && !/^(rowversion|timestamp)$/i.test(String(c.type).trim());

/**
 * The script that puts the rows in on the target, in one transaction: each table's rows (`tables`:
 * [{ obj, set, rows }] in insertOrder), skipping any whose key is there already. SQL Server: IF NOT
 * EXISTS before each INSERT, with IDENTITY_INSERT on around a table that has an identity; Postgres:
 * ON CONFLICT DO NOTHING (OVERRIDING SYSTEM VALUE for identity columns); MySQL: INSERT IGNORE.
 * A table with `stop` (/copyrows' own rows) stops the whole copy instead when a key is there: SQL
 * Server THROWs saying which, which XACT_ABORT rolls back; the others' plain INSERT fails on the key.
 * `head` lines go first as comments. Returns { script, rows }.
 */
export function copyScript(tables, dialect, { head = [] } = {}) {
  const kind = dialect.kind;
  const out = ['-- trawl:copy-rows insert', ...head.map((h) => `-- ${h}`)];
  let total = 0;
  out.push(kind === 'sqlserver' ? 'SET XACT_ABORT ON;\nBEGIN TRANSACTION;' : `${dialect.begin}`);
  for (const { obj, set, rows, stop = false } of tables) {
    if (!rows.length) continue;
    const name = quoted(dialect, obj);
    const cols = set.columns.map((c, i) => ({ c: obj.columns.find((x) => x.name.toLowerCase() === c.name.toLowerCase()) ?? { ...c, pk: false }, i })).filter(({ c }) => insertable(c));
    const keys = obj.columns.filter((c) => c.pk);
    const identity = cols.some(({ c }) => c.identity);
    const list = cols.map(({ c }) => dialect.quote(c.name)).join(', ');
    const values = (row) => cols.map(({ c, i }) => valueLiteral(row[i], c.type, kind)).join(', ');
    out.push('', `-- ${objectName(obj)}: ${rows.length} row${rows.length === 1 ? '' : 's'}`);
    if (kind === 'sqlserver' && identity) out.push(`SET IDENTITY_INSERT ${name} ON;`);
    for (const row of rows) {
      total++;
      if (kind === 'sqlserver') {
        const where = keys.map((k) => `${dialect.quote(k.name)} = ${valueLiteral(cell(set, row, k.name), k.type, kind)}`).join(' AND ');
        if (stop) {
          const said = `${objectName(obj)} has a row with ${keys.map((k) => `${k.name} = ${valueLiteral(cell(set, row, k.name), k.type, kind)}`).join(', ')} already, so nothing was copied.`;
          out.push(`IF EXISTS (SELECT 1 FROM ${name} WHERE ${where}) THROW 50000, N'${said.replace(/'/g, "''")}', 1;`, `INSERT INTO ${name} (${list}) VALUES (${values(row)});`);
        } else out.push(`IF NOT EXISTS (SELECT 1 FROM ${name} WHERE ${where}) INSERT INTO ${name} (${list}) VALUES (${values(row)});`);
      } else if (kind === 'postgres') out.push(`INSERT INTO ${name} (${list})${identity ? ' OVERRIDING SYSTEM VALUE' : ''} VALUES (${values(row)})${stop ? '' : ' ON CONFLICT DO NOTHING'};`);
      else out.push(`INSERT${stop ? '' : ' IGNORE'} INTO ${name} (${list}) VALUES (${values(row)});`);
    }
    if (kind === 'sqlserver' && identity) out.push(`SET IDENTITY_INSERT ${name} OFF;`);
  }
  out.push('', kind === 'sqlserver' ? 'COMMIT TRANSACTION;' : dialect.commit);
  return { script: `${out.join('\n')}\n`, rows: total };
}

/** How many rows a run of the script added, from its "n rows affected" messages. */
export const insertedRows = (messages) => (messages ?? []).reduce((n, m) => n + Number(/^(\d+) rows? affected/.exec(m)?.[1] ?? 0), 0);
