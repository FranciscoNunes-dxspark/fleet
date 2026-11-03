// /hygiene and `locker security`: what the hygiene check reads, and the list it shows. Reading goes
// through the same provider and folder reader as the rest of Locker, metadata only for a vault (its
// secrets' and certificates' listings, never a value); the judging is hygiene.js's, pure. An app's
// settings are read as the drift view reads them, and a value they hold goes no further than
// hygiene.js's shape tests and drift.js's keyed hash.
import { basename } from 'node:path';
import { fit } from '@fleet/kit/text.js';
import { countFindings, findingPlace, findingsLine } from '@fleet/kit/findings.js';
import { theme } from './theme.js';
import { label } from './azure/arm.js';
import { fingerprint } from './drift.js';
import { normKey } from './keys.js';
import { loadTarget, loadVault, mapLimited, referencedVaults } from './load.js';
import { hygieneFindings, jsonKeyLine, secretHolders } from './hygiene.js';
import { rotateSecret } from './rotate.js';

const firstLine = (s) => String(s ?? '').split('\n')[0];

/** A file's path from `dir`, '/'-separated; a file outside it (user secrets) as it is. */
export function relPath(dir, file) {
  const f = String(file ?? '').replace(/\\/g, '/');
  const d = String(dir ?? '').replace(/\\/g, '/').replace(/\/$/, '');
  return d && f.toLowerCase().startsWith(`${d.toLowerCase()}/`) ? f.slice(d.length + 1) : f;
}

/**
 * Everything the hygiene check judges: the folder's sources (appsettings entries with their lines),
 * which of its files git tracks, the app and its slots (every app and slot with `all`), and the
 * vaults: the one picked and those the apps refer to (every vault with `all`), listed without values.
 * `known` maps a vault's name to what was read of it already. What can't be read goes in `problems`.
 */
export async function readHygiene({ provider, local, azure = null, target = null, vault = null, all = false, known = new Map(), signal } = {}) {
  const problems = [];
  const dir = local.dir;
  const rel = (f) => relPath(dir, f);
  let sources = [];
  try {
    sources = await local.sources();
  } catch (e) {
    problems.push(`The folder: ${firstLine(e.message)}`);
  }
  // appsettings' flattened keys, with the line each is on, so a finding says where.
  sources = await Promise.all(
    sources.map(async (s) => {
      if (s.kind !== 'appsettings' || !local.text) return s;
      const text = await local.text(s.file).catch(() => null);
      return text ? { ...s, entries: s.entries.map((e) => ({ ...e, line: jsonKeyLine(text, e.key) ?? undefined })) } : s;
    }),
  );
  const list = local.tracked ? await local.tracked().catch(() => null) : null;
  const set = list ? new Set(list.map((p) => p.replace(/\\/g, '/'))) : null;
  if (!set) problems.push(`${basename(dir)} isn't in a git checkout (or git isn't there): which files git tracks wasn't checked.`);
  const tracked = set ? (s) => set.has(rel(s.file)) : null;

  let sites = [];
  const vaults = [];
  if (azure) {
    const chosen = all ? azure.sites : target ? azure.sites.filter((s) => s.name === target.name && s.resourceGroup === target.resourceGroup) : [];
    const read = await mapLimited(chosen, 4, async (site) => {
      try {
        const { settings, strings } = await loadTarget(provider, site, { signal });
        return { site, settings, strings };
      } catch (e) {
        if (e.cancelled || signal?.aborted) throw e;
        problems.push(`${label(site)}: ${firstLine(e.message)}`);
        return null;
      }
    });
    sites = read.filter(Boolean);
    const names = new Set(all ? azure.vaults.map((v) => v.name.toLowerCase()) : [vault?.name?.toLowerCase(), ...sites.flatMap((s) => referencedVaults(s))].filter(Boolean));
    for (const v of azure.vaults.filter((x) => names.has(x.name.toLowerCase()))) {
      const had = known.get(v.name);
      if (had?.secrets) {
        vaults.push({ vault: v, secrets: had.secrets, certificates: had.certificates ?? [] });
        continue;
      }
      try {
        vaults.push({ vault: v, ...(await loadVault(provider, v, { signal })) });
      } catch (e) {
        if (e.cancelled || signal?.aborted) throw e;
        problems.push(`${v.name}: ${firstLine(e.message)}`);
      }
    }
  }
  const holders = secretHolders({ local: sources, sites, rel, hash: fingerprint });
  return {
    dir,
    local: sources,
    tracked,
    rel,
    sites,
    vaults,
    holders,
    vault: vault?.name ?? vaults[0]?.vault.name,
    problems,
    scope: { folder: dir, sites: sites.map((s) => label(s.site)), vaults: vaults.map((v) => v.vault.name) },
  };
}

export const SEVERITY_TONE = { critical: 'del', high: 'del', medium: 'warn', low: 'dim', unknown: 'dim' };
const SEVERITY_WORD = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW', unknown: '?' };

/** What was read, in a few words: the folder · the apps · the vaults. */
const scopeWords = (read) => [basename(read.dir), read.scope.sites.join(', '), read.scope.vaults.join(', ')].filter(Boolean).join(' · ');

/** What y copies of a finding: the secret's, setting's or file's name, never a value. */
export const findingName = (f) => f.name ?? f.key ?? findingPlace(f);

/** s on a finding: the thing it is about in Locker's own view (a vault's in Vault, a setting's row in Drift). */
async function showWhere(ctx, f) {
  const azure = ctx.data.azure;
  if (f.scope === 'vault') {
    const v = azure?.vaults?.find((x) => x.name === f.vault);
    if (v && v.name !== ctx.data.vault?.name) await ctx.chooseVault(v);
    if (f.name) ctx.cursor('vault', `${f.itemKind}:${f.name}`);
    ctx.closeOverlay();
    return ctx.setView('vault');
  }
  if (!f.key) return ctx.note(`${findingPlace(f)} isn't in one of Locker's views.`, 'error');
  if (f.scope === 'app' && f.site && f.site !== label(ctx.data.target)) {
    const site = azure?.sites?.find((s) => label(s) === f.site);
    if (site) await ctx.chooseTarget(site);
  }
  ctx.setFilter('all');
  ctx.cursor('drift', normKey(f.key));
  ctx.closeOverlay();
  return ctx.setView('drift');
}

/**
 * /hygiene [all]: the check, read in a task and listed worst first. ↵ shows a finding (never a value),
 * y copies its name, f its fix, s shows it in the Vault or Drift view, r rotates a vault secret.
 */
export async function hygiene(ctx, arg = '') {
  const all = /^all$/i.test(String(arg).trim());
  if (arg && !all) return ctx.note('/hygiene takes nothing (the app, its slots and their vaults) or all (every app and vault in the subscription).', 'error') ?? false;
  const data = ctx.data;
  let read = null;
  let found = [];
  const r = await ctx.task(
    `Checking secret hygiene${all ? ' across the subscription' : ''}`,
    async (signal) => {
      read = await readHygiene({ provider: ctx.provider, local: ctx.local, azure: data.azure, target: data.target, vault: data.vault, all, known: data.vaults, signal });
      found = hygieneFindings(read).filter((f) => !(ctx.config.hygieneIgnore ?? []).some((i) => i === f.rule || i === `${f.rule}:${f.where}`));
      const line = findingsLine(countFindings(found));
      return { stdout: `${found.length ? line : 'Nothing found'} in ${scopeWords(read)}${read.problems.length ? `\n${read.problems.join('\n')}` : ''}` };
    },
    { label: 'Checking' },
  );
  if (!r.ok) return false;

  const rotate = (f) => {
    if (f.scope !== 'vault' || f.itemKind !== 'secret') return ctx.note('r rotates a vault secret.', 'error');
    if (f.vault !== ctx.data.vault?.name) return ctx.note(`${f.name} is in ${f.vault}: /vault ${f.vault} first, then /rotate ${f.name}.`, 'error');
    ctx.closeOverlay();
    return rotateSecret(ctx, f.name);
  };
  const keys = {
    y: (f) => ctx.copy(findingName(f), findingName(f)),
    f: (f) => (f.fix ? ctx.copy(f.fix, `the fix for ${findingName(f)}`) : ctx.note('No fix to copy.')),
    s: (f) => showWhere(ctx, f),
    r: (f) => rotate(f),
  };
  let shown = null;
  const details = (f) => {
    const rows = [
      ['severity', `${f.severity} · ${f.rule}`],
      ['where', findingPlace(f)],
      ...(f.excerpt ? [['seen', f.excerpt]] : []),
    ];
    const text = [f.title, '', ...rows.map(([k, v]) => `${k.padEnd(9)}${v}`), '', f.why ?? '', '', f.fix ?? ''].join('\n');
    ctx.showText(`${f.title} · ${findingPlace(f)}`, text, {
      lines: [
        [{ text: f.title, bold: true, color: theme[SEVERITY_TONE[f.severity]] }],
        [],
        ...rows.map(([k, v]) => [{ text: k.padEnd(9), color: theme.dim }, { text: v }]),
        [],
        [{ text: f.why ?? '' }],
        [],
        [{ text: f.fix ?? '', color: theme.warn }],
        [],
        [{ text: `y copies the name · f the fix · s shows it in its view${f.scope === 'vault' && f.itemKind === 'secret' ? ' · r rotates it' : ''} · esc back to the list`, color: theme.dim }],
      ],
      onKey: (input) => (keys[input] ? (keys[input](f), true) : false),
      onClose: () => setTimeout(() => ctx.showPicker(shown), 0),
    });
  };
  const counts = findingsLine(countFindings(found));
  shown = {
    title: `Secret hygiene: ${scopeWords(read)}${found.length ? ` (${counts})` : ''}`,
    hint: '↵ details · y copy name · f copy fix · s show it · r rotate',
    empty: `Nothing found${read.problems.length ? `; not read: ${read.problems.join('; ')}` : '.'}`,
    items: found.map((f) => ({
      f,
      segments: [
        { text: fit(SEVERITY_WORD[f.severity] ?? '?', 5), color: theme[SEVERITY_TONE[f.severity]], bold: f.severity === 'critical' || f.severity === 'high' },
        { text: fit(f.title, 46), strong: true },
        { text: `  ${findingPlace(f)}`, color: theme.dim },
      ],
    })),
    onPick: ({ f }) => details(f),
    keys: Object.fromEntries(Object.entries(keys).map(([k, fn]) => [k, ({ f }) => fn(f)])),
  };
  ctx.showPicker(shown);
  if (read.problems.length) ctx.note(`Not everything was read:\n${read.problems.join('\n')}`, 'error');
  return true;
}
