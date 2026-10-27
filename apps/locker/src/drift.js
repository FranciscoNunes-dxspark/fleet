// The drift view's matrix: every key of the chosen sources, one row each, and in every source's column
// whether it is there, and whether its value is the same as the others'. Values are compared by a keyed
// hash and never shown: a cell says which group of equal values it is in (A, B, …), so two sources that
// agree read alike without either value on screen. Pure, but for the hash's key, made once per run so a
// group letter means nothing outside it.
import { createHmac, randomBytes } from 'node:crypto';
import { isReference, normKey, parseReference, referenceText } from './keys.js';
import { isExpired } from './expiry.js';

const KEY = randomBytes(32);

/** A value's hash, keyed for this run only: equal values hash alike, and nothing about a value can be learned from it. */
export const fingerprint = (value) => createHmac('sha256', KEY).update(String(value ?? '')).digest('hex').slice(0, 16);

const GROUPS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Whether a Key Vault reference resolves: { ok, why }. `vaults` maps a vault's name (lower case) to its
 * secrets ([{ name, enabled, expires }]) when Locker could list them; `status` is what App Service itself
 * said (ARM's configreferences: 'Resolved', 'SecretNotFound', …), when it was read.
 */
export function checkReference(ref, vaults = new Map(), { status, now = Date.now() } = {}) {
  if (!ref || ref.problem) return { ok: false, why: `the reference is written wrong${ref?.problem ? `: ${ref.problem}` : ''}` };
  const secrets = vaults.get(ref.vault);
  if (secrets) {
    const s = secrets.find((x) => x.name.toLowerCase() === ref.secret.toLowerCase());
    if (!s) return { ok: false, why: `no secret ${ref.secret} in ${ref.vault}` };
    if (s.enabled === false) return { ok: false, why: `${ref.secret} is disabled in ${ref.vault}` };
    if (isExpired(s, now)) return { ok: false, why: `${ref.secret} has expired in ${ref.vault}` };
  }
  if (status && !/^resolved$/i.test(status)) return { ok: false, why: `App Service says ${String(status).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}` };
  if (!secrets) return { ok: true, why: status ? 'App Service resolved it' : `not checked: Locker hasn't listed ${ref.vault}'s secrets` };
  return { ok: true, why: `${ref.secret} is in ${ref.vault}${status ? ', and App Service resolved it' : ''}` };
}

/**
 * The matrix: { columns, rows }. `columns` are the sources, in order: { id, label, kind, entries }, where
 * a local or app column's entries are { key, value, status? } (status is App Service's word on a
 * reference) and a vault column's are its secrets { name, enabled, expires }; a column with `presence`
 * (an example file) only says that it names a key. A vault secret an app
 * column's reference names sits in that setting's row; the rest sit by their own names (Db--Password
 * is Db:Password). Each row: { key, norm, cells, missing, differs, broken }, a cell
 * { state, group?, why?, ref?, key? } with state one of
 *   missing   the source doesn't have it
 *   value     a value, in `group` (A, B, …: the same letter is the same value)
 *   ref       a Key Vault reference that resolves (or couldn't be checked)
 *   broken    a reference that doesn't resolve, or a vault secret that is disabled or has expired
 *   present   in the vault, enabled and current (its value isn't read to compare)
 */
export function driftMatrix(columns, { vaults = new Map(), now = Date.now() } = {}) {
  const rows = new Map();
  const row = (key) => {
    const norm = normKey(key);
    if (!rows.has(norm)) rows.set(norm, { key, norm, cells: columns.map(() => ({ state: 'missing' })) });
    return rows.get(norm);
  };
  // Which vault secrets a reference points at, by vault and name: they belong in the referring row.
  const referred = new Map();
  columns.forEach((col) => {
    if (col.kind === 'vault') return;
    for (const e of col.entries) {
      if (!isReference(e.value)) continue;
      const ref = parseReference(e.value);
      if (ref && !ref.problem) referred.set(`${ref.vault}/${ref.secret.toLowerCase()}`, normKey(e.key));
    }
  });
  columns.forEach((col, c) => {
    for (const e of col.entries) {
      if (col.kind === 'vault') {
        const where = referred.get(`${String(col.vault ?? col.label).toLowerCase()}/${e.name.toLowerCase()}`);
        const r = where ? rows.get(where) ?? row(e.name) : row(e.name);
        const off = e.enabled === false ? 'disabled' : isExpired(e, now) ? 'expired' : null;
        r.cells[c] = off ? { state: 'broken', why: off, key: e.name } : { state: 'present', key: e.name };
        continue;
      }
      const r = row(e.key);
      // An example file's values are placeholders: that it names the key is what it says.
      if (col.presence) {
        r.cells[c] = { state: 'present', key: e.key };
        continue;
      }
      if (isReference(e.value)) {
        const ref = parseReference(e.value);
        const check = checkReference(ref, vaults, { status: e.status, now });
        r.cells[c] = { state: check.ok ? 'ref' : 'broken', why: check.why, ref: referenceText(ref), key: e.key };
      } else {
        r.cells[c] = { state: 'value', hash: fingerprint(e.value), key: e.key };
      }
    }
  });
  const out = [];
  for (const r of rows.values()) {
    // Group letters in column order, so the first source's value is A.
    const letters = new Map();
    for (const cell of r.cells) {
      if (cell.state !== 'value') continue;
      if (!letters.has(cell.hash)) letters.set(cell.hash, GROUPS[letters.size] ?? '?');
      cell.group = letters.get(cell.hash);
      delete cell.hash;
    }
    out.push({
      ...r,
      // A vault holds the secrets, not every setting, so a key it lacks isn't missing there.
      missing: r.cells.some((x, i) => x.state === 'missing' && columns[i].kind !== 'vault'),
      differs: letters.size > 1,
      broken: r.cells.some((x) => x.state === 'broken'),
    });
  }
  out.sort((a, b) => a.norm.localeCompare(b.norm));
  return { columns, rows: out };
}

export const FILTERS = ['all', 'diff', 'missing'];

/** The rows a filter keeps: all; diff, where values differ or something is broken; missing, where a source lacks it. */
export function filterRows(rows, filter = 'all') {
  if (filter === 'diff') return rows.filter((r) => r.differs || r.broken);
  if (filter === 'missing') return rows.filter((r) => r.missing);
  return rows;
}

/** How many rows differ, are broken and are missing somewhere: { differs, broken, missing }. */
export function driftCounts(rows) {
  return { differs: rows.filter((r) => r.differs).length, broken: rows.filter((r) => r.broken).length, missing: rows.filter((r) => r.missing).length };
}

/** A cell of `row` as the matrix draws it: { text, tone } (tone a theme colour's name). */
export function cellMark(cell, row) {
  switch (cell.state) {
    case 'value': return { text: `= ${cell.group}`, tone: row?.differs ? 'warn' : 'add' };
    case 'ref': return { text: '→ vault', tone: 'info' };
    case 'present': return { text: '● set', tone: 'add' };
    case 'broken': return { text: '✗ broken', tone: 'del' };
    default: return { text: '· missing', tone: 'dim' };
  }
}
