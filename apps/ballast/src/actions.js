// Every user-facing operation, written once: keys and slash commands call these with `ctx` (App's).
// Questions before anything that runs a build live here (`ctx.confirm`).
import { basename } from 'node:path';
import { run } from '@fleet/kit/run.js';
import { contextIn, copiedNote, notMine, shareLine, takeLine } from '@fleet/kit/family.js';
import { resolveFolder, samePath } from '@fleet/kit/folders.js';
import { describeEnvironments, setEnvironment } from '@fleet/kit/environments.js';
import { findingsLine, countFindings, findingsText, withoutIgnoredFindings } from '@fleet/kit/findings.js';
import { THEMES, applyTheme, isColour, setAccent, theme } from './theme.js';
import { configFile } from './config.js';
import { MEASURES, formatBytes, formatDelta, formatPercent, sizeIn } from './sizes.js';
import { packageTotals, totals } from './build.js';
import { compareMarkdown, compareRuns, runLabel, summarize } from './compare.js';
import { budgetLine, growthFails, growthLine } from './budgets.js';
import { savedBase } from './base.js';
import { parentOf, safePackageName } from './packages.js';

const firstLine = (s) => String(s ?? '').split('\n')[0];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const SEVERITY_LABEL = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW', unknown: '?' };

/** "190.0 kB gzip in 5 files": a build's weight, as the activity line and the family's log say it. */
export const weightLine = (build, measure) => `${formatBytes(sizeIn(totals(build.chunks), measure))} ${measure} in ${plural(build.chunks.length, 'file')}`;

/**
 * Takes a build Ballast has just read or made: kept on screen, its summary saved for later comparisons
 * (with the commit it was built at), then compared again with what it was compared with before.
 */
async function took(ctx, build, signal) {
  const git = await ctx.provider.git(ctx.cwd(), { signal });
  const summary = summarize(build, { commit: git?.commit, branch: git?.branch, dirty: git?.dirty });
  if (build.chunks.length) ctx.provider.saveRun(build.root ?? ctx.cwd(), summary);
  ctx.setData((d) => ({ ...d, build, git, summary, budgets: ctx.provider.budgets(ctx.cwd()) }));
}

/**
 * The project's build, read again: the stats file (or `stats`, a file named), else its output folders.
 * With nothing there, asks to build it once with stats. Then compared with what the Compare view shows
 * (the last build, unless another base was chosen), from what's kept, without building anything.
 */
export async function read(ctx, { stats = null, offerBuild = true } = {}) {
  const dir = ctx.cwd();
  const r = await ctx.task(
    `read ${basename(dir) || dir}`,
    async (signal) => {
      const build = await ctx.provider.read(dir, { stats });
      await took(ctx, build, signal);
      if (!build.chunks.length) return { stdout: 'No stats file and no output folder (dist, build, .next/static, out) here.' };
      return { stdout: `${weightLine(build, ctx.measure)}, from ${build.source.label}` };
    },
    { label: 'Reading the build' },
  );
  if (!r.ok) return false;
  const build = ctx.data.build;
  if (!build.chunks.length) return offerBuild ? buildOnce(ctx) : true;
  ctx.logActivity(`Read ${basename(dir)}: ${weightLine(build, ctx.measure)}`, 'info');
  await compare(ctx, ctx.compareBase(), { quiet: true });
  return true;
}

/**
 * /build: the project's build once with stats turned on (buildplan.js says how: Vite with source maps
 * into a folder of Ballast's own, webpack --json, esbuild --metafile, else the build script), asked first.
 */
export async function buildOnce(ctx) {
  const dir = ctx.cwd();
  const plan = ctx.provider.plan(dir);
  if (!plan) return ctx.note('Nothing to read here, and nothing says how this builds (no build script in package.json). Build it, then ctrl+r; or /move to the project.', 'error') ?? false;
  const yes = await ctx.confirm({
    title: `Build ${basename(dir)} once with stats on?`,
    detail: `${plan.command} · ${plan.text}`,
    options: [{ label: 'Yes, build it', value: true }, { label: 'Copy the command', value: 'copy' }, { label: 'No', value: false }],
  });
  if (yes === 'copy') return ctx.copy(plan.command, 'the command') ?? true;
  if (!yes) return false;
  const r = await ctx.task(
    plan.command,
    async (signal) => {
      const build = await ctx.provider.build(dir, plan, { signal });
      await took(ctx, build, signal);
      if (!build.chunks.length) throw new Error(`${plan.command} ran, but left nothing Ballast could read.`);
      return { stdout: `${weightLine(build, ctx.measure)}, from ${build.source.label}` };
    },
    { label: `Building (${plan.tool})` },
  );
  if (!r.ok) return false;
  ctx.logActivity(`Built ${basename(dir)} with stats: ${weightLine(ctx.data.build, ctx.measure)}`, 'info');
  await compare(ctx, ctx.compareBase(), { quiet: true });
  return true;
}

/**
 * /compare [last|main|<ref>]: this build against the last one read, or a ref's. A ref whose build isn't
 * kept can be built in a git worktree of its own, after asking. `quiet` (after a read) only uses what's
 * kept, and says nothing when there's nothing.
 */
export async function compare(ctx, base = 'last', { quiet = false } = {}) {
  const summary = ctx.data?.summary;
  if (!summary || !ctx.data.build.chunks.length) return quiet ? false : (ctx.note('Nothing read yet: ctrl+r reads the build.', 'error') ?? false);
  const wanted = base || 'last';
  ctx.setCompareBase(wanted);
  let found = await savedBase(ctx.provider, ctx.cwd(), { base: wanted, key: summary.key });
  if (!found.run && found.canBuild && !quiet) {
    const yes = await ctx.confirm({
      title: `Build ${found.name} (${found.commit.slice(0, 7)}) to compare with?`,
      detail: `In a git worktree of its own: its packages installed from its lock file, built with stats, then the worktree removed. Kept in ~/.ballast, so it's done once.`,
      options: [{ label: 'Yes, build it', value: true }, { label: 'No', value: false }],
    });
    if (!yes) {
      ctx.setCompare({ base: wanted, name: found.name, missing: found.missing });
      return false;
    }
    const r = await ctx.task(
      `build ${found.name} ${found.commit.slice(0, 7)}`,
      async (signal) => {
        const built = await ctx.provider.buildRef(ctx.cwd(), found.commit, { signal, progress: (p) => ctx.progress(p) });
        const run = summarize(built, { commit: found.commit, branch: found.name });
        ctx.provider.saveRun(ctx.cwd(), run);
        found = { run, name: found.name, commit: found.commit };
        return { stdout: `${found.name}: ${weightLine(built, ctx.measure)}` };
      },
      { label: `Building ${found.name}` },
    );
    if (!r.ok) return false;
  }
  if (!found.run) {
    ctx.setCompare({ base: wanted, name: found.name, missing: found.missing });
    if (!quiet) ctx.note(found.missing, 'error');
    return false;
  }
  const result = compareRuns(found.run, summary, ctx.measure);
  ctx.setCompare({ base: wanted, name: found.name, run: found.run, result });
  if (!quiet) {
    ctx.note(`Against ${runLabel(found.run, found.name)}: ${result.headline}`, 'ok');
    ctx.setView('compare');
  }
  return true;
}

/** m or /markdown: the comparison as Markdown for a pull request, to read here and copy (alt+y). */
export async function markdown(ctx) {
  if (!ctx.compare?.result && !(await compare(ctx, ctx.compareBase()))) return false;
  const c = ctx.compare;
  ctx.showText('Markdown for a pull request (alt+y copies it all)', compareMarkdown(c.result, { base: c.run, head: ctx.data.summary, baseName: c.base === 'last' ? null : c.name }));
  return true;
}

/** The budgets' verdicts and the growth's, as `ballast check` says them. */
export function check(ctx) {
  const build = ctx.data?.build;
  if (!build?.chunks.length) return ctx.note('Nothing read yet: ctrl+r reads the build.', 'error') ?? false;
  const b = ctx.data.budgets ?? { budgets: [], failOn: [] };
  const m = ctx.measure;
  const lines = [`${weightLine(build, m)} (${build.source.label})`, ''];
  if (!b.budgets.length) lines.push('No budgets. Put them in ballast.json (or package.json\'s "fleet": { "ballast": … }):', '  { "budgets": { "dist/assets/index-*.js": "180kB", "total": "450kB" }, "failOn": ["budget", "growth>5%"] }');
  for (const x of ctx.checks) lines.push(budgetLine(x, m));
  const growth = (b.failOn ?? []).filter((c) => c.kind === 'growth');
  const c = ctx.compare;
  if (c?.result) lines.push('', `Against ${runLabel(c.run, c.name)}: ${c.result.headline}`);
  for (const g of growth) lines.push(!c?.result ? `----  ${g.text}: nothing to compare with (/compare)` : `${growthFails(g, c.result.total) ? 'FAIL' : 'ok  '}  ${g.text}: ${growthLine(c.result.total)}`);
  lines.push('', b.from ? `From ${b.from}. ballast check in a pipeline exits 1 on the same.` : 'ballast check --budget <glob>=<size> --fail-on growth>5% does the same in a pipeline.');
  ctx.showText('Budgets', lines.join('\n'));
  return true;
}

/** ↵ on a chunk: its modules, in the Modules view. */
export const showChunk = (ctx, chunk) => ctx.showModules(chunk.file);

/** Licences and advisories of a package's versions, asked of OSV once a session. */
async function advisoriesOf(ctx, pkg) {
  const want = pkg.versions.filter((v) => !ctx.advisories.has(`${pkg.name}@${v}`));
  if (!want.length) return true;
  const r = await ctx.task(
    `advisories ${pkg.name}`,
    async (signal) => {
      const found = await ctx.provider.advisories(want.map((version) => ({ name: pkg.name, version })), { signal });
      for (const [k, v] of found) ctx.advisories.set(k, v);
      const n = [...found.values()].reduce((s, l) => s + l.length, 0);
      return { stdout: n ? `${plural(n, 'advisory')} known` : 'Nothing known against it' };
    },
    { label: 'Asking OSV' },
  );
  return r.ok;
}

/**
 * p or /why <package>: what a bundled package weighs, where each copy is installed and what brought it
 * in, its licence (the lock file's), and the advisories OSV knows against each version (as Bilge
 * reads them).
 */
export async function packageDetail(ctx, name = '') {
  const build = ctx.data?.build;
  const all = build ? packageTotals(build.chunks, ctx.measure) : [];
  const wanted = String(name).trim();
  const pkg = all.find((p) => p.name === wanted) ?? all.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (!pkg) return ctx.note(wanted ? `${wanted} isn't in this build.` : '/why needs a package that is in the build: /why date-fns', 'error') ?? false;
  await advisoriesOf(ctx, pkg);
  const lines = [`${pkg.name}  ${formatBytes(pkg.bytes)} raw, ≈ ${formatBytes(pkg.size)} ${ctx.measure} · ${plural(pkg.modules, 'module')} in ${plural(pkg.chunks.length, 'file')}`, ''];
  for (const i of pkg.installs) {
    const parent = parentOf(i.installPath);
    lines.push(`${i.version ?? '?'}  ${i.installPath}  ${formatBytes(i.bytes)}  (${plural(i.modules, 'module')}${parent ? `, brought in by ${parent}` : ''})`);
    lines.push(`   in ${i.chunks.join(', ')}`);
  }
  lines.push('');
  for (const v of pkg.versions.length ? pkg.versions : [null]) {
    const licence = v ? build.licences?.[`${pkg.name}@${v}`] : null;
    lines.push(`${pkg.name}@${v ?? '?'}  Licence: ${licence ?? (v ? 'not in the lock file' : 'unknown: no version read')}`);
    const list = v ? (ctx.advisories.get(`${pkg.name}@${v}`) ?? null) : null;
    if (!list) lines.push(v ? '  Advisories: not asked (OSV couldn\'t be reached)' : '');
    else if (!list.length) lines.push('  No known advisories.');
    for (const a of list ?? []) lines.push(`  ${SEVERITY_LABEL[a.severity] ?? '?'}${a.score != null ? ` ${a.score}` : ''}  ${a.id}${a.aliases.length ? ` (${a.aliases.join(', ')})` : ''}  ${a.summary}`, `     Fixed in: ${a.fixed ?? 'no fix yet'} · ${a.url}`);
  }
  if (pkg.installs.length > 1) lines.push('', `Bundled ${pkg.installs.length} times: ${pkg.versions.length > 1 ? 'at different versions; one range that takes them all lets npm keep one (npm dedupe, or overrides in package.json)' : 'one version from two paths; npm dedupe (or a matching range) keeps one'}.`);
  lines.push('', 'w copies "/why <package>" for Bilge, which says which manifest brings it in and how to move it.');
  ctx.showText(`${pkg.name} · ${pkg.versions.join(', ') || '?'}`, lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n'));
  return true;
}

/** w: "/why <package>" for Bilge's prompt (Bilge takes no package context, so a line of its own command). */
export function whyForBilge(ctx, name) {
  if (!safePackageName(name)) return ctx.note(`${name} isn't a package name to hand Bilge.`, 'error') ?? false;
  const line = shareLine('why', [name]);
  ctx.copy(line, 'a line for Bilge');
  ctx.note(copiedNote('bilge', line));
  return true;
}

/** t on a module of the project's own: its file, for Splice's history (who made it heavy, and when). */
export function shareModule(ctx, node) {
  if (node.pkg) return ctx.note(`${node.id} is ${node.pkg.name}'s, not a file of the project: w copies /why ${node.pkg.name} for Bilge.`, 'error') ?? false;
  if (!node.id || /^\[|^vite\/|^webpack\/|^\(/.test(node.id) || node.id.startsWith('../')) return ctx.note(`${node.id ?? 'That'} isn't a file in the project.`, 'error') ?? false;
  const line = takeLine('file', { path: node.id });
  ctx.copy(line, 'a line for Splice');
  ctx.note(copiedNote('splice', line));
  return true;
}

/** ↵ on a module: where it is, what it weighs, and how to hand it on. */
export function showModule(ctx, node) {
  const chunk = ctx.data.build.chunks.find((c) => c.file === node.chunk);
  ctx.showText(node.id, [
    node.id,
    `${formatBytes(node.bytes)} of ${chunk ? `${chunk.file} (${formatBytes(chunk.raw)})` : node.chunk}, ≈ ${formatBytes(node.size)} ${ctx.measure}`,
    node.pkg ? `Package: ${node.pkg.name}${node.pkg.version ? `@${node.pkg.version}` : ''}, installed at ${node.pkg.installPath}` : 'The project\'s own code.',
    '',
    node.pkg ? 'p: the package (licence, advisories) · w: /why for Bilge' : 't: the file for Splice, whose history says who made it heavy',
  ].join('\n'));
}

/** ↵ on a duplicate: each copy, its version, size and what brings it in. */
export function showDuplicate(ctx, d) {
  ctx.showText(`${d.name} bundled ${d.installs.length} times`, [
    `${d.name}: ${d.kind === 'versions' ? `${d.versions.length} versions (${d.versions.join(', ')})` : `version ${d.versions[0] ?? '?'} from ${d.installs.length} paths`}, ${formatBytes(d.wasted)} more than one copy would be`,
    '',
    ...d.installs.flatMap((i) => [`${i.version ?? '?'}  ${i.installPath}  ${formatBytes(i.bytes)}  ${parentOf(i.installPath) ? `(brought in by ${parentOf(i.installPath)})` : '(at the top of node_modules)'}`, `   in ${i.chunks.join(', ')}`]),
    '',
    d.kind === 'versions' ? 'A dependency asks for a range the project\'s version isn\'t in: update it, or pin one version with overrides (npm), resolutions (Yarn) or pnpm.overrides.' : 'npm dedupe usually folds these into one; if not, a range that takes both versions does.',
    'p: licence and advisories · w: /why for Bilge, which says which manifest brings each in',
  ].join('\n'));
}

/** ↵ on a row of Compare: a chunk's or package's sizes before and after. */
export function showChange(ctx, row) {
  const m = ctx.compare.result.measure;
  const size = (x) => (x ? formatBytes(x[m] ?? x.raw) : '—');
  const lines = [row.name, `${size(row.before)} → ${size(row.after)}  ${formatDelta(row.delta)}${formatPercent(row.delta, row.before?.[m] ?? row.before?.raw) ? ` (${formatPercent(row.delta, row.before?.[m] ?? row.before?.raw)})` : ''} ${m}`];
  if (row.reason) lines.push(`Why: ${row.reason}`);
  if (row.before?.versions || row.after?.versions) lines.push(`Versions: ${row.before?.versions?.join(', ') || '—'} → ${row.after?.versions?.join(', ') || '—'}`, `Modules: ${row.before?.modules ?? 0} → ${row.after?.modules ?? 0}`);
  if (row.before?.file || row.after?.file) lines.push(`Files: ${row.before?.file ?? '—'} → ${row.after?.file ?? '—'}`);
  ctx.showText(row.name, lines.join('\n'));
}

/** /security: the output folders read for source maps and secrets in the bundles (findings.js's shape). */
export async function security(ctx) {
  const dir = ctx.cwd();
  const r = await ctx.task(
    `security ${basename(dir) || dir}`,
    async (signal) => {
      const result = await ctx.provider.security(dir, { signal });
      const found = withoutIgnoredFindings(result.findings, ctx.config.securityIgnore ?? []);
      ctx.setSecurity({ ...result, findings: found });
      return { stdout: result.dirs.length ? `${plural(result.files, 'file')} read: ${findingsLine(countFindings(found)) || 'nothing found'}` : 'No output folder to read.' };
    },
    { label: 'Reading the output' },
  );
  if (!r.ok) return false;
  const s = ctx.security;
  // Only the counts go to the family's log: a finding may be where a secret is.
  ctx.logActivity(`Security of ${basename(dir)}'s build: ${findingsLine(countFindings(s.findings)) || 'nothing found'}`, 'info');
  ctx.showText('Security of the build', findingsText(s.findings, { header: s.dirs.length ? `${s.files} files in ${s.dirs.map((d) => `${d}/`).join(', ')}` : 'No output folder (dist, build, .next/static, out): nothing built to read.' }));
  return true;
}

/** /budgets: what the budgets are and where they come from. */
export function budgets(ctx) {
  const b = ctx.data?.budgets;
  if (!b) return ctx.note('Nothing read yet.', 'error') ?? false;
  ctx.showText('Budgets', [
    b.from ? `From ${b.from}, measured ${b.measure}.` : 'No ballast.json, and no "ballast" key in package.json\'s "fleet" section.',
    '',
    ...(b.budgets.length ? b.budgets.map((x) => `  ${x.pattern}  ${formatBytes(x.limit)}`) : ['  none']),
    `Fail on: ${(b.failOn ?? []).map((c) => c.text).join(', ') || 'budget (the default)'}`,
    ...(b.errors?.length ? ['', ...b.errors.map((e) => `Not read: ${e}`)] : []),
    '',
    'ballast.json: { "budgets": { "dist/assets/index-*.js": "180kB", "total": "450kB" }, "failOn": ["budget", "growth>5%"], "measure": "gzip" }',
    'A path is a glob over the files as Ballast names them (* within a folder, ** across), each file held to it; "total" is all of them.',
  ].join('\n'));
  return true;
}

/** /measure [gzip|brotli|raw]: what sizes are shown and budgets held to here (ballast.json's measure until set). */
export function measure(ctx, value = '') {
  const v = value.trim().toLowerCase();
  if (!v) return ctx.note(`Measuring ${ctx.measure}. /measure ${MEASURES.join('|')} changes it.`);
  if (!MEASURES.includes(v)) return ctx.note(`Measure is one of ${MEASURES.join(', ')}.`, 'error') ?? false;
  ctx.setConfig((c) => ({ ...c, measure: v }));
  ctx.note(`Measuring ${v}`, 'ok');
  if (ctx.data?.summary) return compare(ctx, ctx.compareBase(), { quiet: true });
  return true;
}

/** /move <folder>: read another folder. */
export function move(ctx, folder = '') {
  const dir = ctx.cwd();
  if (!folder.trim()) return ctx.note(`Reading ${dir}. /move <folder> reads another (one beside this, in it, or a path).`);
  const target = resolveFolder(dir, folder);
  if (!target) return ctx.note(`There's no folder ${folder.trim()} here or beside ${basename(dir)}.`, 'error') ?? false;
  if (samePath(target, dir)) return ctx.note(`Ballast is reading ${basename(target)} already.`);
  ctx.moveTo(target);
  return read(ctx);
}

/** /env [name]: the project's environment; a name switches every app of the family to it. */
export function env(ctx, name = '') {
  if (!name.trim()) return ctx.note(describeEnvironments(ctx.cwd()));
  const r = setEnvironment(ctx.cwd(), name, { by: 'ballast' });
  if (!r.ok) return ctx.note(r.error, 'error') ?? false;
  ctx.note(`Environment: ${r.env.name}${r.env.prod ? ' (production)' : ''}, for every app.`, 'ok');
  return true;
}

/** /take: Ballast takes no context; it says whose one is. */
export function take(ctx, text) {
  const context = contextIn(text);
  if (!context) return ctx.note('/take needs what a sibling copied: a family:v1:… line.', 'error') ?? false;
  return ctx.note(notMine('ballast', context), 'error') ?? false;
}

/** ! and /run: a shell command in the folder, its output in the activity line (/last has it all). */
export async function raw(ctx, command) {
  if (!command) return ctx.note('Type a command after !, e.g. !npm run build', 'error') ?? false;
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
      `Measure          ${ctx.measure}${c.measure ? '' : ' (the project\'s, or gzip)'}       /measure gzip|brotli|raw`,
      `Security ignored ${(c.securityIgnore ?? []).join(', ') || 'none'}       "securityIgnore" in the file (a rule, or rule:where)`,
      `Update checks    ${on(c.checkForUpdates)}       "checkForUpdates" in the file`,
      `Auto-update      ${on(c.autoUpdate)}       "autoUpdate" in the file`,
      `History          ${(c.history ?? []).length} lines`,
      '',
      `Kept in ${configFile()}; each build's summary in ${configFile().replace(/config\.json$/, 'runs')}.`,
    ].join('\n'),
  );
  return true;
}

export { firstLine };
