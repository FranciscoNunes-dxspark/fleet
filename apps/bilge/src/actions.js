// Every user-facing operation, written once: keys and slash commands call these with `ctx` (App's).
// Questions before anything that changes a project live here (`ctx.confirm`).
import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { run } from '@fleet/kit/run.js';
import { contextIn, copiedNote, notMine, takeLine } from '@fleet/kit/family.js';
import { resolveFolder, samePath } from '@fleet/kit/folders.js';
import { THEMES, applyTheme, isColour, setAccent, theme } from './theme.js';
import { configFile } from './config.js';
import { countLine, counts, findings, licenceKind } from './audit.js';
import { fixPlan } from './fix.js';
import { cyclonedx } from './sbom.js';
import { packageUrl } from './registry.js';
import { SEVERITY_LABEL, findFinding, findPackage, label, licenceOf, withoutIgnored } from './rows.js';
import { fileData, markdownReport } from './share.js';
import { bumpOf } from './versions.js';
import { VERSION } from './app.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const packages = (ctx) => ctx.data?.packages ?? [];
const found = (ctx) => ctx.found ?? [];

/** The folder's lock files and projects, read again; then, unless the setting is off or `audit` false, OSV is asked about them. */
export async function scan(ctx, { audit: thenAudit = ctx.config.autoAudit !== false } = {}) {
  const dir = ctx.cwd();
  const r = await ctx.task(
    `scan ${basename(dir) || dir}`,
    async () => {
      const result = await ctx.provider.scan(dir);
      ctx.setData((d) => ({ ...result, audit: null, latest: d?.root === result.root ? d.latest : null }));
      const n = result.manifests.length;
      return { stdout: n ? `${plural(result.packages.length, 'package')} in ${plural(n, 'manifest')}` : 'No package-lock.json, packages.lock.json or .NET project here.' };
    },
    { label: 'Reading lock files' },
  );
  if (r.ok && thenAudit && packages(ctx).length) return audit(ctx);
  return r.ok;
}

/** /audit: OSV's advisories for every package found. */
export async function audit(ctx) {
  const list = packages(ctx);
  if (!list.length) return ctx.note(ctx.data?.manifests?.length ? 'No packages with exact versions to ask about.' : 'Nothing read yet: /scan reads this folder.', 'error') ?? false;
  const r = await ctx.task(
    `audit ${plural(list.length, 'package')}`,
    async (signal) => {
      const { ids, details } = await ctx.provider.audit(list, { signal });
      ctx.setData((d) => ({ ...d, audit: { ids, details, at: Date.now() } }));
      const line = countLine(counts(withoutIgnored(findings(list, ids, details), ctx.config.ignore ?? [])));
      return { stdout: line || 'Nothing known against them.' };
    },
    { label: 'Asking OSV' },
  );
  if (r.ok) {
    const c = ctx.counts;
    // What was found goes to the family's activity log, so /timeline in the others shows when it changed.
    ctx.logActivity(countLine(c) ? `Audited ${basename(ctx.cwd())}: ${countLine(c)}` : `Audited ${basename(ctx.cwd())}: nothing known`, 'info');
  }
  return r.ok;
}

/** /outdated [all]: the registries' newest versions of the direct packages (or of all of them), and their licences. */
export async function outdated(ctx, which = '') {
  const all = /^all$/i.test(which.trim());
  const list = packages(ctx).filter((p) => all || p.direct);
  if (!list.length) return ctx.note('No packages to look up: /scan reads this folder.', 'error') ?? false;
  const r = await ctx.task(
    `outdated ${all ? 'all' : 'direct'}: ${plural(list.length, 'package')}`,
    async (signal) => {
      const latest = await ctx.provider.latest(list, { signal, onProgress: (n, of) => ctx.progress(`${n}/${of}`) });
      ctx.setData((d) => ({ ...d, latest: new Map([...(d.latest ?? []), ...latest]) }));
      const behind = list.filter((p) => bumpOf(p.version, latest.get(p.key)?.latest));
      const failed = [...latest.values()].filter((x) => x.error).length;
      return { stdout: `${plural(behind.length, 'package')} behind${failed ? `; ${failed} the registry couldn't answer for` : ''}` };
    },
    { label: 'Asking the registries' },
  );
  if (r.ok) ctx.showPackages({ filter: 'outdated' });
  return r.ok;
}

function advisoryLines(a) {
  const cve = a.aliases.length ? ` (${a.aliases.join(', ')})` : '';
  return [`${SEVERITY_LABEL[a.severity]}${a.score != null ? ` ${a.score}` : ''}  ${a.id}${cve}`, `  ${a.summary}`, `  Fixed in: ${a.fixed ?? 'no fix yet'}`, `  ${a.url}${a.advisoryUrl && a.advisoryUrl !== a.url ? `\n  ${a.advisoryUrl}` : ''}`];
}

/** The manifest a package was found in first, for its fix and its line. */
const manifestOf = (ctx, pkg, path = pkg.where[0]?.path) => ctx.data.manifests.find((m) => m.path === path);

/** ↵ on a finding: its advisories, where it is, and how to fix it. */
export function showFinding(ctx, f) {
  const plan = fixPlan(f, manifestOf(ctx, f.pkg));
  ctx.showText(`${label(f.pkg)} · ${plural(f.advisories.length, 'advisory')}`, [
    `${label(f.pkg)}  ${f.pkg.ecosystem}${f.pkg.direct ? ', direct' : ', brought in by another package'}${f.pkg.dev ? ', development only' : ''}`,
    `Found in: ${f.pkg.where.map((w) => `${w.path}${w.line ? `:${w.line}` : ''}`).join(', ')}`,
    '',
    ...f.advisories.flatMap((a) => [...advisoryLines(a), '']),
    plan ? `Fix (f): ${plan.text}` : 'No version fixes all of these yet.',
  ].join('\n'));
}

/** ↵ on a package: what's known about it. */
export function showPackage(ctx, p) {
  const latest = ctx.data.latest?.get(p.key);
  const licence = licenceOf(p, ctx.data.latest);
  const f = found(ctx).find((x) => x.key === p.key);
  ctx.showText(label(p), [
    `${label(p)}  ${p.ecosystem}${p.direct ? ', direct' : ', brought in by another package'}${p.dev ? ', development only' : ''}`,
    `Licence: ${licence ?? 'unknown (/outdated asks the registry)'}${licence ? `  (${licenceKind(licence)})` : ''}`,
    `Newest: ${latest ? (latest.error ? `couldn't ask: ${latest.error}` : `${latest.latest ?? '?'}${bumpOf(p.version, latest.latest) ? `  (${bumpOf(p.version, latest.latest)} behind)` : '  (up to date)'}`) : 'not asked yet (/outdated)'}`,
    ...(latest?.deprecated ? [`Deprecated: ${latest.deprecated}`] : []),
    `Found in: ${p.where.map((w) => `${w.path}${w.line ? `:${w.line}` : ''}`).join(', ')}`,
    `Registry: ${packageUrl(p)}`,
    '',
    ...(f ? f.advisories.flatMap((a) => [...advisoryLines(a), '']) : [ctx.data.audit ? 'No known advisories.' : 'Not audited yet (/audit).']),
  ].join('\n'));
}

/**
 * f or /fix: moves a vulnerable package to the version that fixes it, with the ecosystem's own command
 * run where its manifest is (asked first); where no command does it, says what to change. Then reads
 * the folder again.
 */
export async function fix(ctx, target) {
  const f = typeof target === 'object' ? target : findFinding(found(ctx), target);
  if (!f) return ctx.note(target ? `No finding matches "${target}".` : '/fix needs a vulnerable package or an advisory id.', 'error') ?? false;
  const manifest = manifestOf(ctx, f.pkg);
  const plan = manifest && fixPlan(f, manifest);
  if (!plan) return ctx.note(`No version of ${f.pkg.name} fixes ${f.advisories.length === 1 ? f.advisories[0].id : 'all of these'} yet.`, 'error') ?? false;
  if (!plan.run) return ctx.showText(`Fixing ${label(f.pkg)}`, plan.text) ?? true;
  const yes = await ctx.confirm({ title: `Move ${f.pkg.name} from ${f.pkg.version} to ${f.fixed}?`, detail: plan.text, options: [{ label: 'Yes, run it', value: true }, { label: 'Copy the command', value: 'copy' }, { label: 'No', value: false }] });
  if (yes === 'copy') return ctx.copy(plan.run.command, 'the command') ?? true;
  if (!yes) return false;
  const r = await ctx.task(plan.run.command, (signal) => ctx.provider.run(plan.run.command, { cwd: plan.run.cwd, signal }), {
    label: `Moving ${f.pkg.name}`,
    activity: `Moved ${f.pkg.name} ${f.pkg.version} → ${f.fixed} in ${manifest.path}`,
  });
  if (r.ok) await scan(ctx, { audit: true });
  return r.ok;
}

/** x or /ignore: an advisory (or every one of a finding's) left out of the list and the counts, kept in the config. */
export async function ignore(ctx, target) {
  const f = typeof target === 'object' ? target : findFinding(found(ctx), target);
  const id = typeof target === 'string' ? target.trim() : null;
  const ids = f ? (id && f.advisories.some((a) => a.id === id) ? [id] : f.advisories.map((a) => a.id)) : id ? [id] : [];
  if (!ids.length) return ctx.note('/ignore needs an advisory id (GHSA-…, CVE-…) or a vulnerable package.', 'error') ?? false;
  const yes = await ctx.confirm({ title: `Ignore ${ids.length === 1 ? ids[0] : plural(ids.length, 'advisory')}?`, detail: `It stays out of the list, the counts and bilge audit's exit code until /unignore. Kept in ${configFile()}.` });
  if (!yes) return false;
  ctx.setConfig((c) => ({ ...c, ignore: [...new Set([...(c.ignore ?? []), ...ids])] }));
  ctx.note(`Ignoring ${ids.join(', ')}`, 'ok');
  return true;
}

/** /unignore [id|all]: back in the list; alone, says which are ignored. */
export function unignore(ctx, id = '') {
  const list = ctx.config.ignore ?? [];
  if (!id.trim()) return ctx.note(list.length ? `Ignored: ${list.join(', ')}. /unignore <id> or /unignore all.` : 'Nothing is ignored.');
  const next = /^all$/i.test(id.trim()) ? [] : list.filter((x) => x.toLowerCase() !== id.trim().toLowerCase());
  if (next.length === list.length) return ctx.note(`${id.trim()} isn't ignored.`, 'error') ?? false;
  ctx.setConfig((c) => ({ ...c, ignore: next }));
  ctx.note(next.length ? `Not ignoring ${id.trim()} any more.` : 'Nothing is ignored now.', 'ok');
  return true;
}

/** /deny [licence…|none]: the licences flagged in red (SPDX ids or their start, GPL- covering every GPL); alone, says which. */
export function deny(ctx, rest = '') {
  const words = rest.split(/[\s,]+/).filter(Boolean);
  if (!words.length) return ctx.note(`Licences flagged: ${(ctx.config.deny ?? []).join(', ') || 'none'} (copyleft ones are marked anyway). /deny GPL- AGPL- or /deny none.`);
  const next = words.length === 1 && /^none$/i.test(words[0]) ? [] : words;
  ctx.setConfig((c) => ({ ...c, deny: next }));
  ctx.note(next.length ? `Flagging ${next.join(', ')}` : 'No licences flagged.', 'ok');
  return true;
}

/** o: the advisory (for a finding) or the package's page on its registry, in the browser. */
export function open(ctx, what) {
  const url = what.advisories ? what.advisories[0].advisoryUrl ?? what.advisories[0].url : packageUrl(what);
  ctx.openUrl(url);
  ctx.note(`Opening ${url}`);
  return true;
}

/** t: where a package is in its manifest, for Splice to blame (who brought it in, and when). */
export function shareWhere(ctx, pkg) {
  const where = pkg.where[0];
  if (!where) return ctx.note(`${pkg.name} isn't in a manifest Bilge read.`, 'error') ?? false;
  const line = takeLine('file', fileData(where));
  ctx.copy(line, 'a line for Splice');
  ctx.note(copiedNote('splice', line));
  return true;
}

/** t on a manifest: the file itself, for Splice's history of it. */
export function shareManifest(ctx, manifest) {
  const line = takeLine('file', { path: manifest.path });
  ctx.copy(line, 'a line for Splice');
  ctx.note(copiedNote('splice', line));
  return true;
}

/** /sbom [file]: a CycloneDX bill of materials (sbom.cdx.json in the folder unless named), asking before replacing one. */
export async function sbom(ctx, file = '') {
  const list = packages(ctx);
  if (!list.length) return ctx.note('No packages to list: /scan reads this folder.', 'error') ?? false;
  const name = file.trim() || 'sbom.cdx.json';
  const path = isAbsolute(name) ? name : resolve(ctx.cwd(), name);
  if (ctx.provider.name !== 'demo' && existsSync(path)) {
    const yes = await ctx.confirm({ title: `Replace ${name}?`, detail: path, danger: true });
    if (!yes) return false;
  }
  const bom = cyclonedx({ name: basename(ctx.cwd()), packages: list, found: found(ctx), licences: ctx.data.latest ?? new Map(), tool: { name: 'Bilge', version: VERSION }, serial: randomUUID() });
  const r = await ctx.task(`sbom ${name}`, async () => {
    ctx.provider.writeFile(path, `${JSON.stringify(bom, null, 2)}\n`);
    return { stdout: `${plural(list.length, 'component')}${bom.vulnerabilities ? `, ${plural(bom.vulnerabilities.length, 'vulnerability')}` : ''} in ${path}` };
  }, { label: 'Writing' });
  return r.ok;
}

/** /report: the audit as Markdown, to read here and copy (y) into a pull request or a ticket. */
export function report(ctx) {
  if (!ctx.data?.audit) return ctx.note('Not audited yet: /audit first.', 'error') ?? false;
  ctx.showText('Report (alt+y copies it all)', markdownReport({ name: basename(ctx.cwd()), manifests: ctx.data.manifests, packages: packages(ctx), found: found(ctx) }));
  return true;
}

/** /move <folder>: read another folder: a path, or a folder beside this one or in it. */
export function move(ctx, folder = '') {
  const dir = ctx.cwd();
  if (!folder.trim()) return ctx.note(`Reading ${dir}. /move <folder> reads another (one beside this, in it, or a path).`);
  const target = resolveFolder(dir, folder);
  if (!target) return ctx.note(`There's no folder ${folder.trim()} here or beside ${basename(dir)}.`, 'error') ?? false;
  if (samePath(target, dir)) return ctx.note(`Bilge is reading ${basename(target)} already.`);
  ctx.moveTo(target);
  return scan(ctx);
}

/** /take: Bilge takes no sibling's context yet; says whose it is. */
export function take(ctx, text) {
  const context = contextIn(text);
  if (!context) return ctx.note('/take needs what a sibling copied: a family:v1:… line.', 'error') ?? false;
  return ctx.note(notMine('bilge', context), 'error') ?? false;
}

/** /why <package>: every manifest a package is in, and whether it's asked for there or brought in. */
export function why(ctx, name) {
  const p = findPackage(packages(ctx), name);
  if (!p) return ctx.note(name ? `No package ${name} here.` : '/why needs a package.', 'error') ?? false;
  return showPackage(ctx, p) ?? true;
}

/** ! and /run: a shell command in the folder, its output in the activity line (/last has it all). */
export async function raw(ctx, command) {
  if (!command) return ctx.note('Type a command after !, e.g. !npm ls lodash', 'error') ?? false;
  const r = await ctx.task(command, (signal) => run(command, { cwd: ctx.cwd(), signal }), { label: 'Running' });
  return r.ok;
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
      `Theme            ${c.theme ?? 'auto'} (${theme.mode} here)       /theme dark|light|auto`,
      `Accent colour    ${c.accent ?? 'default'}       /accent #rrggbb`,
      `Mouse            ${on(c.mouse)}       /mouse on|off`,
      `Audit on start   ${on(c.autoAudit)}       "autoAudit" in the file (OSV is asked about the packages' names and versions)`,
      `Ignored          ${(c.ignore ?? []).join(', ') || 'none'}       /ignore, /unignore`,
      `Licences flagged ${(c.deny ?? []).join(', ') || 'none'}       /deny`,
      `Update checks    ${on(c.checkForUpdates)}       "checkForUpdates" in the file`,
      `Auto-update      ${on(c.autoUpdate)}       "autoUpdate" in the file`,
      `History          ${(c.history ?? []).length} lines`,
      '',
      `Kept in ${configFile()}`,
    ].join('\n'),
  );
  return true;
}
