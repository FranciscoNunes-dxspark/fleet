// Every user-facing operation, written once: keys and slash commands call these with `ctx` (App's).
// Questions before anything that changes something, or puts a value where it can be seen, live here
// (`ctx.confirm`). A value is never put in a note, a task's output, the activity log or a hand-off:
// it goes only to the screen on an explicit reveal, to the clipboard, or into the file it was asked into.
import { run } from '@fleet/kit/run.js';
import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { folderChoices, resolveFolder, samePath } from '@fleet/kit/folders.js';
import { fit, relTime } from '@fleet/kit/text.js';
import { APP_NAMES, FAMILY, MASK, contextIn, copiedNote, describeContext, notMine, projectAt, projectWiring, readActivity } from '@fleet/kit/family.js';
import { THEMES, applyTheme, isColour, setAccent, theme } from './theme.js';
import { clearAfter, configFile, expiryDays } from './config.js';
import { label } from './azure/arm.js';
import { envKey } from './local.js';
import { isReference, isVaultName, normKey, vaultName } from './keys.js';
import { cellMark } from './drift.js';
import { expiryWords } from './expiry.js';
import { isShown } from './load.js';
import { familyChoices, siteIn, siteNamed, sonarLine } from './share.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const firstLine = (s) => String(s ?? '').split('\n')[0];

/** The value a column holds for a row: { value } for a local or app value, { vault, name } for a vault secret, null for none. */
export function valueIn(ctx, row, i) {
  const col = ctx.data.columns[i];
  const cell = row.cells[i];
  if (!col || !cell) return null;
  if (col.kind === 'vault') return cell.state === 'present' ? { vault: ctx.data.vault, name: cell.key } : null;
  if (cell.state !== 'value') return null;
  const e = col.entries.findLast((x) => normKey(x.key) === row.norm);
  return e ? { value: e.value } : null;
}

/** A value, read: what a column holds, or the secret fetched from the vault (only ever on an explicit ask). */
async function readValue(ctx, held, signal) {
  if ('value' in held) return held.value;
  return ctx.provider.secretValue(held.vault, held.name, { signal });
}

/** ↵ on a row: where the setting is and what each source says of it, without a value. */
export function showRow(ctx, row) {
  const { columns } = ctx.data;
  const w = Math.min(36, Math.max(8, ...columns.map((c) => c.label.length)));
  const lines = [[{ text: row.key, bold: true }], [{ text: row.differs ? 'The values differ: the same letter is the same value.' : row.broken ? 'Something here does not resolve.' : row.missing ? 'Not every source has it.' : 'Every source that has it agrees.', color: theme.dim }], []];
  const text = [row.key, ''];
  columns.forEach((col, i) => {
    const cell = row.cells[i];
    const mark = cellMark(cell, row);
    const said = [cell.key && normKey(cell.key) === row.norm && cell.key !== row.key ? `as ${cell.key}` : cell.key && cell.key !== row.key ? `the secret ${cell.key}` : '', cell.ref ? `→ ${cell.ref}` : '', cell.why ?? ''].filter(Boolean).join('  ');
    lines.push([{ text: fit(col.label, w), color: theme.dim }, { text: `  ${fit(mark.text, 10)}`, color: theme[mark.tone] }, { text: `  ${said}`, color: theme.dim }]);
    text.push(`${fit(col.label, w)}  ${fit(mark.text, 10)}  ${said}`);
  });
  lines.push([], [{ text: 'v shows the values · y copies one · a adds it to .env from another source', color: theme.dim }]);
  ctx.showText(`${row.key}`, text.join('\n'), { lines });
}

/** v on a row: every source's value, the vault's read now. Shown until esc, and kept nowhere else. */
export async function revealRow(ctx, row) {
  const { columns } = ctx.data;
  const w = Math.min(36, Math.max(8, ...columns.map((c) => c.label.length)));
  let shown = null;
  const r = await ctx.task(
    `Revealing ${row.key}`,
    async (signal) => {
      const lines = [];
      for (const [i, col] of columns.entries()) {
        const held = valueIn(ctx, row, i);
        const cell = row.cells[i];
        let value;
        if (held) {
          try {
            value = await readValue(ctx, held, signal);
          } catch (e) {
            if (e.cancelled) throw e;
            value = null;
            lines.push({ col, value: `(couldn't read it: ${firstLine(e.message)})`, dim: true });
            continue;
          }
        }
        lines.push({ col, value: held ? value : cell.state === 'ref' || cell.state === 'broken' ? (cell.ref ? `→ ${cell.ref}${cell.why ? `  (${cell.why})` : ''}` : cell.why ?? '') : '—', dim: !held });
      }
      shown = lines;
      return { stdout: `${plural(lines.filter((l) => !l.dim).length, 'value')} shown until esc` };
    },
    { label: 'Reading' },
  );
  if (!r.ok || !shown) return false;
  ctx.showText(
    `${row.key} · values`,
    shown.map((l) => `${fit(l.col.label, w)}  ${l.value}`).join('\n'),
    { secret: true, lines: [[{ text: `${row.key}: the values, until esc`, bold: true }], [], ...shown.map((l) => [{ text: fit(l.col.label, w), color: theme.dim }, { text: `  ${l.value}`, color: l.dim ? theme.dim : undefined }])] },
  );
  return true;
}

/** v on a vault secret: its value, read now, shown until esc. */
export async function revealSecret(ctx, vault, secret) {
  if (!vault || !secret) return false;
  let value = null;
  const r = await ctx.task(
    `Revealing ${secret.name} in ${vault.name}`,
    async (signal) => {
      value = await ctx.provider.secretValue(vault, secret.name, { signal });
      return { stdout: 'Shown until esc' };
    },
    { label: 'Reading' },
  );
  if (!r.ok) return false;
  ctx.showText(`${secret.name} · ${vault.name}`, value, { secret: true, lines: [[{ text: `${secret.name} in ${vault.name}, until esc`, bold: true }], [], ...value.split('\n').map((l) => [{ text: l }])] });
  return true;
}

/** Puts a value on the clipboard, after asking, cleared again after the setting's seconds; the activity log says what was copied, never the value. */
async function copyValue(ctx, { what, from, held }) {
  const secs = clearAfter(ctx.config);
  const yes = await ctx.confirm({ title: `Copy ${what}'s value from ${from} to the clipboard?`, detail: secs ? `It is cleared from the clipboard after ${secs} s.` : 'It stays on the clipboard (clearClipboard is 0).' });
  if (!yes) return false;
  let value = null;
  const r = await ctx.task(
    `Copying ${what} from ${from}`,
    async (signal) => {
      value = await readValue(ctx, held, signal);
      return { stdout: `On the clipboard${secs ? ` for ${secs} s` : ''}` };
    },
    { label: 'Reading', activity: `Copied ${what}'s value from ${from} to the clipboard`, kind: 'secret' },
  );
  if (!r.ok) return false;
  ctx.copySecret(value, `${what} from ${from}`);
  return true;
}

/** The columns of a row that hold a value to take (a local or app value, or a vault secret), [{ i, col, cell }]. */
const holders = (ctx, row) => ctx.data.columns.map((col, i) => ({ i, col, cell: row.cells[i] })).filter(({ i }) => valueIn(ctx, row, i));

/** y on a row: one source's value to the clipboard (a list to pick from when several have one). */
export function copyRow(ctx, row) {
  const list = holders(ctx, row);
  if (!list.length) return ctx.note(`No source has a value for ${row.key} to copy.`, 'error') ?? false;
  const go = ({ i, col }) => copyValue(ctx, { what: row.key, from: col.label, held: valueIn(ctx, row, i) });
  if (list.length === 1) return go(list[0]);
  ctx.showPicker({
    title: `Copy ${row.key}'s value from`,
    hint: '↵ copy it',
    items: list.map((h) => ({ ...h, segments: [{ text: fit(h.col.label, 32), strong: true }, { text: `  ${cellMark(h.cell, row).text}`, color: theme[cellMark(h.cell, row).tone] }] })),
    onPick: (h) => (ctx.closeOverlay(), go(h)),
  });
  return true;
}

/** y on a vault secret. */
export const copySecret = (ctx, vault, secret) => copyValue(ctx, { what: secret.name, from: vault.name, held: { vault, name: secret.name } });

/**
 * a on a row: the setting added to a .env file that lacks it (.env itself first), its value taken from
 * a source that has one (a list when several do); asks first, and writes the file.
 */
export function addToEnv(ctx, row) {
  const { columns } = ctx.data;
  const envs = columns.map((col, i) => ({ col, i })).filter(({ col, i }) => col.source?.writable && row.cells[i].state === 'missing');
  const local = ctx.data.local.filter((s) => s.writable);
  const lacking = envs.length ? envs.map((e) => e.col.source) : local.filter((s) => !s.entries.some((e) => normKey(e.key) === row.norm));
  // .env before .env.local and the rest, and never an example file: its values are only examples.
  const target = [...lacking].filter((s) => !/example|sample|template/i.test(s.label)).sort((a, b) => (a.label === '.env' ? -1 : b.label === '.env' ? 1 : a.label.localeCompare(b.label)))[0];
  if (!target && local.some((s) => s.label === '.env')) return ctx.note(`.env has ${row.key} already.`) ?? false;
  const file = target?.file ?? null;
  const fileLabel = target?.label ?? '.env';
  const list = holders(ctx, row).filter(({ col }) => col.id !== target?.id);
  if (!list.length) return ctx.note(`No source has a value for ${row.key} to add to ${fileLabel}.`, 'error') ?? false;
  const key = envKey(row.cells.find((c) => c.key)?.key ?? row.key);
  const go = async ({ i, col }) => {
    const yes = await ctx.confirm({ title: `Add ${key} to ${fileLabel}, with the value from ${col.label}?`, detail: `${target ? 'Written at the end of' : 'A new file,'} ${fileLabel} in ${ctx.cwd()}. Keep it out of git.` });
    if (!yes) return false;
    const held = valueIn(ctx, row, i);
    const r = await ctx.task(
      `Adding ${key} to ${fileLabel}`,
      async (signal) => {
        const value = await readValue(ctx, held, signal);
        await ctx.local.addToEnv(file ?? '.env', key, value);
        return { stdout: `Added ${key} to ${fileLabel} (the value from ${col.label})` };
      },
      { label: 'Writing', activity: `Added ${key} to ${fileLabel} (the value from ${col.label})`, project: ctx.cwd(), reload: { local: true } },
    );
    return r.ok;
  };
  if (list.length === 1) return go(list[0]);
  ctx.showPicker({
    title: `Add ${key} to ${fileLabel} from`,
    hint: '↵ take its value',
    items: list.map((h) => ({ ...h, segments: [{ text: fit(h.col.label, 32), strong: true }, { text: `  ${cellMark(h.cell, row).text}`, color: theme[cellMark(h.cell, row).tone] }] })),
    onPick: (h) => (ctx.closeOverlay(), go(h)),
  });
  return true;
}

/** The vault the Vault view and the secret commands act on, or a note saying how to pick one. */
function needVault(ctx) {
  if (ctx.data.vault) return ctx.data.vault;
  ctx.note(ctx.data.azure ? 'Pick a key vault first: /vault.' : 'Locker has no key vault to look at: Azure could not be read (/refresh tries again).', 'error');
  return null;
}

/**
 * e (and /set): a new value for a secret, typed hidden, asked about before it is saved as the secret's
 * new version (the old one stays, as a version); n and /set with a new name make one.
 */
export async function setSecret(ctx, name, { vault: given } = {}) {
  const vault = given ?? needVault(ctx);
  if (!vault) return false;
  let secretName = String(name ?? '').trim();
  if (!secretName) {
    secretName = (await ctx.askText({ title: `A new secret in ${vault.name}: its name`, detail: 'Letters, digits and dashes; Section--Key is read by .NET as Section:Key.' }))?.trim();
    if (!secretName) return false;
  }
  if (!isVaultName(secretName)) {
    const suggested = vaultName(secretName);
    return ctx.note(`"${secretName}" can't be a secret's name: letters, digits and dashes only${suggested && isVaultName(suggested) ? ` (${suggested} would do)` : ''}.`, 'error') ?? false;
  }
  const existing = ctx.data.vaults.get(vault.name)?.secrets?.find((s) => s.name.toLowerCase() === secretName.toLowerCase());
  const value = await ctx.askSecret({ title: existing ? `A new value for ${existing.name} in ${vault.name}` : `The value of ${secretName} in ${vault.name}`, detail: 'Typed hidden; ↵ goes on, esc cancels.' });
  if (value == null) return false;
  if (!value) return ctx.note('An empty value: nothing was set.', 'error') ?? false;
  const yes = await ctx.confirm({
    title: existing ? `Set a new version of ${existing.name} in ${vault.name}?` : `Create ${secretName} in ${vault.name}?`,
    detail: existing ? `Whatever reads its latest version gets the new value; the old one stays as a version.${existing.expires ? ' The new version has no expiry date.' : ''}` : 'A new secret, enabled, with no expiry date.',
    danger: Boolean(existing),
  });
  if (!yes) return false;
  const shownName = existing?.name ?? secretName;
  const r = await ctx.task(
    `${existing ? 'Rotating' : 'Creating'} ${shownName} in ${vault.name}`,
    async (signal) => {
      await ctx.provider.setSecret(vault, shownName, value, { signal });
      return { stdout: `${existing ? 'A new version of' : 'Created'} ${shownName} in ${vault.name}` };
    },
    { label: 'Saving', activity: `${existing ? 'Set a new version of' : 'Created'} the secret ${shownName} in ${vault.name}`, reload: { vault: vault.name } },
  );
  return r.ok;
}

/** x on a vault secret: disable it (asks first; whatever reads it then fails), or enable a disabled one. */
export async function toggleSecret(ctx, secret) {
  const vault = needVault(ctx);
  if (!vault || !secret) return false;
  if (secret.kind === 'certificate') return ctx.note(`${secret.name} is a certificate: Locker only disables secrets.`, 'error') ?? false;
  const enable = secret.enabled === false;
  const users = ctx.data.matrix.rows.filter((r) => r.cells.some((c, i) => ctx.data.columns[i].kind === 'vault' && c.key === secret.name) && r.cells.some((c) => c.state === 'ref'));
  const yes = await ctx.confirm({
    title: `${enable ? 'Enable' : 'Disable'} ${secret.name} in ${vault.name}?`,
    detail: enable ? 'Its latest version can be read again.' : `Nothing can read it until it is enabled again${users.length ? `: ${users.map((u) => u.key).slice(0, 3).join(', ')} ${users.length === 1 ? 'refers' : 'refer'} to it` : ''}.`,
    danger: !enable,
  });
  if (!yes) return false;
  const r = await ctx.task(
    `${enable ? 'Enabling' : 'Disabling'} ${secret.name} in ${vault.name}`,
    async (signal) => {
      await ctx.provider.enableSecret(vault, secret.name, enable, { signal });
      return { stdout: `${enable ? 'Enabled' : 'Disabled'} ${secret.name}` };
    },
    { label: enable ? 'Enabling' : 'Disabling', activity: `${enable ? 'Enabled' : 'Disabled'} the secret ${secret.name} in ${vault.name}`, reload: { vault: vault.name } },
  );
  return r.ok;
}

/** ↵ on a vault secret or certificate: what Key Vault says of it, never its value. */
export function showSecret(ctx, vault, s) {
  const when = (t) => (t ? `${t.slice(0, 16).replace('T', ' ')} (${relTime(Date.parse(t))} ago)` : '—');
  const rows = [
    ['kind', s.kind],
    ['enabled', s.enabled === false ? 'no' : 'yes'],
    ['expires', s.expires ? `${s.expires.slice(0, 10)} · ${expiryWords(s.expires)}` : 'never'],
    ['updated', when(s.updated)],
    ['created', when(s.created)],
    ...(s.contentType && s.kind !== 'certificate' ? [['type', s.contentType]] : []),
    ...(s.thumbprint ? [['thumbprint', s.thumbprint]] : []),
  ];
  const usedBy = ctx.data.matrix.rows.filter((r) => r.cells.some((c, i) => ctx.data.columns[i].kind === 'vault' && c.key === s.name)).map((r) => r.key);
  const text = [`${s.name} in ${vault.name}`, '', ...rows.map(([k, v]) => `${k.padEnd(11)}${v}`), ...(usedBy.length ? ['', `In the drift view as ${usedBy.join(', ')}`] : [])];
  const isSecret = s.kind === 'secret';
  // The overlay has the keys, so the keys its hint names are its own: each acts on this secret and replaces the overlay.
  const onKey = isSecret
    ? (input) => {
        const act = { v: revealSecret, y: copySecret, e: (c, vlt, sec) => setSecret(c, sec.name), x: (c, vlt, sec) => toggleSecret(c, sec) }[input];
        if (!act) return false;
        act(ctx, vault, s);
        return true;
      }
    : undefined;
  ctx.showText(s.name, text.join('\n'), {
    onKey,
    lines: [[{ text: `${s.name} in ${vault.name}`, bold: true }], [], ...rows.map(([k, v]) => [{ text: k.padEnd(11), color: theme.dim }, { text: v, color: k === 'expires' && s.expires ? theme[/expired|today/.test(v) ? 'del' : 'warn'] : undefined }]), ...(usedBy.length ? [[], [{ text: `In the drift view as ${usedBy.join(', ')}`, color: theme.dim }]] : []), ...(isSecret ? [[], [{ text: 'v shows its value · y copies it · e sets a new one · x disables it', color: theme.dim }]] : [])],
  });
}

/** t (and /sonar): the app or slot, handed to Sonar as /appsettings there. */
export function toSonar(ctx) {
  const target = ctx.data.target;
  if (!target) return ctx.note('Pick an App Service app first: /app.', 'error') ?? false;
  const line = sonarLine(target);
  ctx.copy(line, 'a line for Sonar');
  ctx.note(copiedNote('sonar', line), 'ok');
  return true;
}

/** /take: what a sibling copied. An app (a `site`, from Sonar) opens its settings in the drift view. */
export async function take(ctx, text) {
  const context = contextIn(text);
  if (!context) return ctx.note('/take needs what a sibling copied: a family:v1:… line.', 'error') ?? false;
  if (context.kind !== 'site') return ctx.note(notMine('locker', context), 'error') ?? false;
  const sites = ctx.data.azure?.sites ?? [];
  if (!sites.length) return ctx.note(`Locker can't see ${describeContext(context)}: ${ctx.data.azureProblem ?? 'no apps were read from Azure'}.`, 'error') ?? false;
  const site = siteIn(sites, context.data);
  if (!site) return ctx.note(`No ${describeContext(context)} in ${ctx.data.azure.subscription.name}${context.data.subscription && context.data.subscription !== ctx.data.azure.subscription.id ? ' (it is in another subscription: /sub picks it)' : ''}.`, 'error') ?? false;
  ctx.setView('drift');
  return ctx.chooseTarget(site);
}

/** /app: an App Service app or slot to compare, named or picked; /app none leaves the column out. */
export function chooseApp(ctx, name) {
  const sites = ctx.data.azure?.sites ?? [];
  if (/^(none|off)$/i.test(String(name ?? '').trim())) return ctx.chooseTarget(null);
  if (!sites.length) return ctx.note(ctx.data.azureProblem ?? 'No App Service apps were read from Azure.', 'error') ?? false;
  if (name?.trim()) {
    const site = siteNamed(sites, name);
    if (!site) return ctx.note(`No single app or slot matches "${name.trim()}".`, 'error') ?? false;
    return ctx.chooseTarget(site);
  }
  const w = Math.min(40, Math.max(...sites.map((s) => label(s).length)));
  ctx.showPicker({
    title: `App Service apps in ${ctx.data.azure.subscription.name}`,
    hint: '↵ compare its settings',
    items: sites.map((s) => ({
      s,
      segments: [
        { text: s.slot ? '  ' : '', color: theme.dim },
        { text: fit(label(s), w), strong: true, color: ctx.data.target?.id === s.id ? theme.accent : undefined },
        { text: `  ${s.kind === 'function' ? 'function app' : 'web app'}${s.slot ? ' slot' : ''}`, color: theme.dim },
        { text: `  ${s.resourceGroup}`, color: theme.dim },
      ],
    })),
    onPick: ({ s }) => (ctx.closeOverlay(), ctx.chooseTarget(s)),
  });
  return true;
}

/** /vault: the key vault to compare and list, named or picked. */
export function chooseVault(ctx, name) {
  const vaults = ctx.data.azure?.vaults ?? [];
  if (/^(none|off)$/i.test(String(name ?? '').trim())) return ctx.chooseVault(null);
  if (!vaults.length) return ctx.note(ctx.data.azureProblem ?? 'No key vaults were read from Azure.', 'error') ?? false;
  if (name?.trim()) {
    const n = name.trim().toLowerCase();
    const v = vaults.find((x) => x.name.toLowerCase() === n) ?? (vaults.filter((x) => x.name.toLowerCase().startsWith(n)).length === 1 ? vaults.find((x) => x.name.toLowerCase().startsWith(n)) : null);
    if (!v) return ctx.note(`No single key vault matches "${name.trim()}".`, 'error') ?? false;
    return ctx.chooseVault(v);
  }
  ctx.showPicker({
    title: `Key vaults in ${ctx.data.azure.subscription.name}`,
    hint: '↵ look at its secrets',
    items: vaults.map((v) => ({ v, segments: [{ text: fit(v.name, 28), strong: true, color: ctx.data.vault?.name === v.name ? theme.accent : undefined }, { text: `  ${v.resourceGroup}`, color: theme.dim }] })),
    onPick: ({ v }) => (ctx.closeOverlay(), ctx.chooseVault(v)),
  });
  return true;
}

/** /sub: another subscription, named or picked. */
export function chooseSubscription(ctx, name) {
  const subs = ctx.data.azure?.subscriptions ?? [];
  if (!subs.length) return ctx.note(ctx.data.azureProblem ?? 'No subscriptions were read from Azure.', 'error') ?? false;
  const n = name?.trim().toLowerCase();
  if (n) {
    const sub = subs.find((s) => s.name.toLowerCase() === n || s.id === n) ?? subs.find((s) => s.name.toLowerCase().includes(n));
    if (!sub) return ctx.note(`No subscription matches "${name.trim()}".`, 'error') ?? false;
    return ctx.chooseSubscription(sub);
  }
  ctx.showPicker({
    title: 'Subscriptions',
    hint: '↵ read it',
    items: subs.map((s) => ({ s, segments: [{ text: fit(s.name, 40), strong: true, color: ctx.data.azure.subscription.id === s.id ? theme.accent : undefined }, { text: `  ${s.id}`, color: theme.dim }] })),
    onPick: ({ s }) => (ctx.closeOverlay(), ctx.chooseSubscription(s)),
  });
  return true;
}

/** c in Drift (and /columns): which sources are columns, ↵ turning one on or off; remembered. */
export function chooseColumns(ctx) {
  const all = () => [
    ...ctx.data.local.map((s) => ({ id: s.id, label: s.label, kind: s.kind, entries: s.entries.length, problem: s.problem })),
    ...(ctx.data.target ? [{ id: 'app', label: label(ctx.data.target), kind: 'app' }] : []),
    ...(ctx.data.vault ? [{ id: 'vault', label: ctx.data.vault.name, kind: 'vault' }] : []),
  ];
  const items = () =>
    all().map((s) => {
      const on = isShown(s, ctx.config.columns);
      return { s, segments: [{ text: on ? '[x] ' : '[ ] ', color: theme.accent, bold: true }, { text: fit(s.label, 34), strong: on, color: on ? undefined : theme.dim }, { text: `  ${s.kind}${s.entries != null ? ` · ${plural(s.entries, 'key')}` : ''}${s.problem ? ` · ${s.problem}` : ''}`, color: s.problem ? theme.warn : theme.dim }] };
    });
  ctx.showPicker({
    title: 'Columns of the drift view',
    hint: '↵ show or hide it',
    items,
    onPick: ({ s }) => {
      const choices = { ...(ctx.config.columns ?? {}), [s.id]: !isShown(s, ctx.config.columns) };
      ctx.setConfig({ ...ctx.config, columns: choices });
      ctx.refreshPicker();
    },
  });
  return true;
}

/** ↵ on a source in Sources: its keys, each with a mark for whether it has a value, never the value. */
export function showSource(ctx, source) {
  const w = Math.min(48, Math.max(8, ...source.entries.map((e) => e.key.length)));
  const lines = source.entries.map((e) => `${fit(e.key, w)}  ${e.value === '' ? '(empty)' : isReference(e.value) ? e.value : MASK}`);
  ctx.showText(`${source.label} · ${plural(source.entries.length, 'key')}`, [`${source.file}`, '', ...lines].join('\n'));
}

/** Whether `dir` has settings Locker reads: .env files, appsettings*.json, a .csproj (user secrets) or Hail's env files. */
export function hasSettings(dir) {
  try {
    return readdirSync(dir).some((f) => /^\.env(\..+)?$|^appsettings(\.[\w-]+)?\.json$|\.csproj$|^http-client(\.private)?\.env\.json$/i.test(f));
  } catch {
    return false;
  }
}

/**
 * /move [folder]: Locker reads another folder's settings: a path, or a folder beside this one or inside
 * it; without one, a list of the folders read lately and the ones beside this one.
 */
export function move(ctx, folder) {
  const dir = ctx.cwd();
  if (!folder?.trim()) {
    const items = folderChoices(dir, ctx.config.projects ?? [], { has: hasSettings });
    if (!items.length) return ctx.note('There are no other folders beside this one: /move <path>.');
    return ctx.showPicker({
      title: 'Move to',
      hint: 'the folders read lately first · ↵ reads its settings',
      items: items.map((it) => ({ ...it, segments: [{ text: it.name, strong: it.has }, { text: it.has ? '' : '  (no settings found)', color: theme.dim }] })),
      onPick: (it) => {
        ctx.closeOverlay();
        move(ctx, it.path);
      },
    });
  }
  const target = resolveFolder(dir, folder);
  if (!target) return ctx.note(`There's no folder ${folder.trim()} here or beside ${basename(dir)}.`, 'error');
  if (samePath(target, dir)) return ctx.note(`Locker is in ${basename(target)} already.`);
  return ctx.moveTo(target);
}

/** /family: what the folder Locker started in offers the other apps, a line for one's prompt each; ↵ copies it. */
export function family(ctx) {
  const project = projectAt(ctx.cwd());
  const choices = familyChoices(project, { target: ctx.data.target });
  if (!choices.length) return ctx.note(`${project.dir} is nothing the other apps open: no git checkout, nothing for Bosun to run, no .http files, no databases in appsettings*.json or .env, and no App Service app picked.`);
  ctx.showPicker({
    title: `What ${project.dir} is to the other apps`,
    hint: "↵ copy it for that app's prompt",
    items: choices.map((c) => ({ c, segments: [{ text: `${APP_NAMES[c.app].padEnd(7)}`, color: theme.accent, bold: true }, { text: `${c.line}  `, strong: true }, { text: c.what, color: theme.dim }] })),
    onPick: ({ c }) => {
      ctx.copy(c.line, `a line for ${APP_NAMES[c.app]}`);
      ctx.note(copiedNote(c.app, c.line), 'ok');
    },
  });
  return true;
}

/** /wiring: what the folder points at (family.js projectWiring: addresses, hosts, ports, connection strings, secrets masked), by file. */
export function wiring(ctx) {
  const dir = ctx.cwd();
  const found = projectWiring(dir);
  if (!found.length) return ctx.note(`Nothing in ${dir} points anywhere: no addresses, hosts, ports or connection strings in appsettings*.json, .env files or http-client env files.`);
  const bySource = new Map();
  for (const w of found) {
    if (!bySource.has(w.source)) bySource.set(w.source, []);
    bySource.get(w.source).push(w);
  }
  const text = [];
  for (const [source, list] of bySource) {
    const keyW = Math.min(40, Math.max(...list.map((w) => w.key.length)));
    if (text.length) text.push('');
    text.push(source);
    for (const w of list) text.push(`  ${fit(w.key, keyW)}  ${w.value}`);
  }
  ctx.showText(`What ${dir} points at (${found.length})`, text.join('\n'));
  return true;
}

/** /timeline: what the family's apps did that changed something, newest first; p this project's only, ↵ an entry whole. */
export function timeline(ctx, { mine = false, replace = false } = {}) {
  const dir = ctx.cwd();
  const list = readActivity({ project: mine ? dir : undefined, limit: 500 });
  const appW = Math.max(...FAMILY.map((x) => (APP_NAMES[x] ?? x).length));
  const base = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  ctx.showPicker(
    {
      title: `Timeline${mine ? ` of ${base(dir) || dir}` : ': the family'} (${list.length})`,
      hint: `↵ the whole entry · p ${mine ? 'every project' : 'this project only'} · y copy it`,
      empty: mine ? `Nothing logged for ${dir} yet. p shows every project.` : 'Nothing logged yet: the apps add what they change (a push, a restart, a secret rotated) as they do it.',
      items: list.map((e) => ({
        e,
        segments: [
          { text: fit(relTime(e.at), 4, 'right'), color: theme.dim },
          { text: `  ${fit(APP_NAMES[e.app] ?? e.app, appW)}`, color: e.app === 'locker' ? theme.accent : theme.info, bold: true },
          { text: `  ${e.text}` },
          ...(!mine && e.project ? [{ text: `  ${base(e.project)}`, color: theme.dim }] : []),
        ],
      })),
      onPick: ({ e }) => ctx.showText(`${APP_NAMES[e.app] ?? e.app}: ${e.kind ?? 'info'}`, [e.text, '', `app      ${APP_NAMES[e.app] ?? e.app}`, `when     ${new Date(e.at).toISOString().slice(0, 19).replace('T', ' ')}`, `kind     ${e.kind ?? 'info'}`, ...(e.project ? [`project  ${e.project}`] : [])].join('\n')),
      keys: { y: ({ e }) => ctx.copy(e.text, 'the entry') },
      actions: { p: () => timeline(ctx, { mine: !mine, replace: true }) },
    },
    { replace },
  );
  return true;
}

/** ! and /run: a shell command, its output in the activity line (/last has it all). */
export async function raw(ctx, command) {
  if (!command) return ctx.note('Type a command after !, e.g. !az keyvault list -o table', 'error') ?? false;
  const r = await ctx.task(command, (signal) => run(command, { signal, cwd: ctx.cwd() }), { label: 'Running' });
  return r.ok;
}

/** /expiry: how many days ahead counts as soon (30 by default). */
export function setExpiryDays(ctx, value) {
  if (!value) return ctx.note(`Secrets and certificates are listed as expiring ${expiryDays(ctx.config)} days ahead. /expiry <days> changes it.`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 3650) return ctx.note('/expiry takes a number of days, 1 to 3650.', 'error') ?? false;
  ctx.setConfig({ ...ctx.config, expiryDays: n });
  ctx.note(`Expiring: within ${n} days`);
  return true;
}

/** /clear-after: how many seconds a copied value stays on the clipboard (0 leaves it). */
export function setClearAfter(ctx, value) {
  if (!value) return ctx.note(`A copied value is cleared from the clipboard after ${clearAfter(ctx.config)} s. /clear-after <seconds> changes it (0 leaves it there).`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 3600) return ctx.note('/clear-after takes seconds, 0 to 3600.', 'error') ?? false;
  ctx.setConfig({ ...ctx.config, clearClipboard: n });
  ctx.note(n ? `Copied values are cleared after ${n} s` : 'Copied values stay on the clipboard');
  return true;
}

/** /theme: dark, light or auto; with no argument says which. */
export function setTheme(ctx, value) {
  if (!value) return ctx.note(`Theme: ${ctx.config.theme ?? 'auto'} (${theme.mode} here). /theme ${THEMES.join('|')} changes it.`);
  if (!THEMES.includes(value)) return ctx.note(`Theme is one of ${THEMES.join(', ')}.`, 'error') ?? false;
  const next = { ...ctx.config, theme: value };
  ctx.setConfig(next);
  applyTheme(next);
  ctx.note(`Theme: ${value}`);
  return true;
}

/** /accent: a #rrggbb colour, or `default`. */
export function accent(ctx, value) {
  if (!value) return ctx.note(`Accent: ${ctx.config.accent ?? 'default'} (${theme.accent}). /accent #rrggbb changes it.`);
  if (value !== 'default' && !isColour(value)) return ctx.note('An accent is #rrggbb, or "default".', 'error') ?? false;
  const next = { ...ctx.config };
  if (value === 'default') delete next.accent;
  else next.accent = value;
  ctx.setConfig(next);
  setAccent(next.accent);
  ctx.note(`Accent: ${value}`);
  return true;
}

/** /mouse: on or off. */
export function mouse(ctx, value) {
  if (!['on', 'off'].includes(value)) return ctx.note(`Mouse is ${ctx.config.mouse === false ? 'off' : 'on'}. /mouse on|off changes it.`);
  ctx.setConfig({ ...ctx.config, mouse: value === 'on' });
  ctx.note(`Mouse: ${value}${value === 'off' ? ' (the terminal selects text again)' : ''}`);
  return true;
}

/** /settings: what's set, and where it's kept. */
export function settings(ctx) {
  const c = ctx.config;
  const on = (v) => (v === false ? 'off' : 'on');
  ctx.showText(
    'Settings',
    [
      `App              ${c.target?.label ?? 'none'}       /app`,
      `Key vault        ${c.vault ?? 'none'}       /vault`,
      `Expiring within  ${expiryDays(c)} days       /expiry <days>`,
      `Clipboard clear  ${clearAfter(c) ? `after ${clearAfter(c)} s` : 'never'}       /clear-after <seconds>`,
      `Expiry notice    ${on(c.notify)}       "notify" in the file`,
      `Theme            ${c.theme ?? 'auto'} (${theme.mode} here)       /theme dark|light|auto`,
      `Accent colour    ${c.accent ?? 'default'}       /accent #rrggbb`,
      `Mouse            ${on(c.mouse)}       /mouse on|off`,
      `Family moods     ${on(c.familyMoods)}       "familyMoods" in the file`,
      `Update checks    ${on(c.checkForUpdates)}       "checkForUpdates" in the file`,
      `Auto-update      ${on(c.autoUpdate)}       "autoUpdate" in the file`,
      `History          ${(c.history ?? []).length} lines`,
      '',
      `Kept in ${configFile()} (which app and vault, never a value)`,
    ].join('\n'),
  );
  return true;
}
