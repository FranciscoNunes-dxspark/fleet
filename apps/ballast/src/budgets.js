// Budgets: how much a file (or the whole build) may weigh, and how much a build may grow, from
// ballast.json, the "ballast" key of package.json's "fleet" section, or `ballast check`'s own
// arguments. Pure; disk.js reads the files.
//
// ballast.json:
//   { "budgets": { "dist/assets/index-*.js": "180kB", "total": "450kB" },
//     "failOn": ["budget", "growth>5%"], "measure": "gzip", "stats": "dist/stats.json" }
// `budgets` may also be a list of { "path": …, "max": … }. A path is a glob over the files as Ballast
// names them (relative to the project, / between folders: * within a folder, ** across them, ?
// one character), each matching file held to the size on its own; `total` is every file together.
import { MEASURES, formatBytes, formatPercent, parseSize, sizeIn } from './sizes.js';
import { totals } from './build.js';

export const TOTAL = 'total';

/** A glob as a RegExp over /-separated paths. */
export function globToRegExp(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      // **/ matches no folder too.
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i++;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** `dist/assets/index-*.js=180kB` → { pattern, limit }, or { error }. */
export function parseBudget(arg) {
  const at = String(arg ?? '').lastIndexOf('=');
  if (at <= 0) return { error: `A budget is <file or glob>=<size> (dist/assets/index-*.js=180kB), not ${arg}` };
  const pattern = arg.slice(0, at).trim();
  const limit = parseSize(arg.slice(at + 1));
  if (limit == null) return { error: `${arg.slice(at + 1)} isn't a size: 180kB, 1.5MB, 200KiB or bytes` };
  return { pattern, limit };
}

/**
 * A --fail-on condition: `budget` (a file over its budget), `growth>5%` or `growth>10kB` (the build
 * against its base), `none`; { kind, percent? , bytes? } or { error }.
 */
export function parseFailOn(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (s === 'budget' || s === 'budgets') return { kind: 'budget', text: 'budget' };
  if (s === 'none') return { kind: 'none', text: 'none' };
  const m = /^growth\s*>\s*(.+)$/.exec(s);
  if (m) {
    const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(m[1]);
    if (pct) return { kind: 'growth', percent: Number(pct[1]), text: `growth>${pct[1]}%` };
    const bytes = parseSize(m[1]);
    if (bytes != null) return { kind: 'growth', bytes, text: `growth>${m[1].replace(/\s+/g, '')}` };
  }
  return { error: `--fail-on is budget, growth>5% (or growth>10kB) or none, not ${text}` };
}

/**
 * The budgets' settings from a ballast.json (or package.json's fleet.ballast) object: { budgets:
 * [{ pattern, limit }], failOn: [conditions], measure, stats, errors }. What doesn't read is in
 * `errors`, said rather than dropped.
 */
export function readBudgets(json = {}) {
  const errors = [];
  const budgets = [];
  const raw = json?.budgets ?? {};
  const entries = Array.isArray(raw) ? raw.map((b) => [b?.path ?? b?.pattern, b?.max ?? b?.limit]) : Object.entries(raw);
  for (const [pattern, max] of entries) {
    const limit = typeof max === 'number' ? max : parseSize(max);
    if (!pattern || limit == null) errors.push(`budget ${pattern ?? '?'}: ${max} isn't a size`);
    else budgets.push({ pattern: String(pattern), limit });
  }
  const failOn = [];
  for (const f of [].concat(json?.failOn ?? [])) {
    const c = parseFailOn(f);
    if (c.error) errors.push(c.error);
    else failOn.push(c);
  }
  const measure = MEASURES.includes(json?.measure) ? json.measure : 'gzip';
  if (json?.measure && !MEASURES.includes(json.measure)) errors.push(`measure is gzip, brotli or raw, not ${json.measure}`);
  return { budgets, failOn, measure, stats: typeof json?.stats === 'string' ? json.stats : null, errors };
}

/**
 * Each budget against `chunks`: [{ pattern, limit, files: [{ file, size, over }], size, over, none }].
 * A glob's files are each held to the limit (`size` the biggest); `total` adds every file up; `none`
 * says the pattern matched nothing (said, but never a failure: the build may have renamed it).
 */
export function checkBudgets(chunks, budgets, measure = 'gzip') {
  return budgets.map(({ pattern, limit }) => {
    if (pattern.toLowerCase() === TOTAL) {
      const size = sizeIn(totals(chunks), measure);
      return { pattern, limit, files: [], size, over: size > limit, none: false };
    }
    const re = globToRegExp(pattern);
    const files = chunks.filter((c) => re.test(c.file) || re.test(c.name)).map((c) => ({ file: c.file, size: sizeIn(c, measure), over: sizeIn(c, measure) > limit }));
    const size = files.reduce((n, f) => Math.max(n, f.size), 0);
    return { pattern, limit, files, size, over: files.some((f) => f.over), none: !files.length };
  });
}

/** Whether a growth condition fails for a comparison's total ({ before, delta }). */
export function growthFails(condition, total) {
  if (!total || total.delta <= 0) return false;
  if (condition.bytes != null) return total.delta > condition.bytes;
  return total.before > 0 && (total.delta / total.before) * 100 > condition.percent;
}

/** A budget's line: "OVER  dist/assets/index-*.js  198.4 kB > 180.0 kB  (dist/assets/index-B7xk2Lq9.js)". */
export function budgetLine(b, measure) {
  if (b.none) return `none  ${b.pattern}  matches no file of this build`;
  const worst = b.files.find((f) => f.over) ?? b.files[0];
  return `${b.over ? 'OVER' : 'ok  '}  ${b.pattern}  ${formatBytes(b.size)} ${measure} ${b.over ? '>' : '≤'} ${formatBytes(b.limit)}${worst && worst.file !== b.pattern ? `  (${worst.file}${b.files.length > 1 ? ` and ${b.files.length - 1} more` : ''})` : ''}`;
}

/** "grew 13.2% (+42.1 kB)": a growth condition's verdict, as `ballast check` says it. */
export const growthLine = (total) => `${total.delta >= 0 ? 'grew' : 'shrank'} ${formatPercent(total.delta, total.before).replace(/^[+-]/, '') || '—'}`;
