// Every user-facing operation, written once: keys and slash commands call these with `ctx` (App's).
// Questions before anything that changes a project live here (`ctx.confirm`).
import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { run } from '@fleet/kit/run.js';
import { contextIn, copiedNote, notMine, shareLine, takeLine } from '@fleet/kit/family.js';
import { resolveFolder, samePath } from '@fleet/kit/folders.js';
import { describeEnvironments, productionQuestion, setEnvironment } from '@fleet/kit/environments.js';
import { THEMES, applyTheme, isColour, setAccent, theme } from './theme.js';
import { configFile } from './config.js';
import { countLine, counts, findings, licenceKind } from './audit.js';
import { fixPlan } from './fix.js';
import { cyclonedx } from './sbom.js';
import { hasRegistry, packageUrl } from './registry.js';
import { safeImage } from './image.js';
import { mergePackages } from './lockfiles.js';
import { SEVERITY_LABEL, findFinding, findPackage, label, licenceOf, withoutIgnored } from './rows.js';
import { fileData, markdownReport } from './share.js';
import { bumpOf } from './versions.js';
import { nodeOf, problems, targetsOf } from './compat.js';
import { branchName, folderLabel, upgradeCandidates } from './upgrade.js';
import { breakingInput, breakingPrompt } from './breaking.js';
import { findingWhere, withoutIgnoredCode } from '@fleet/kit/codescan.js';
import { VERSION } from './app.js';

const firstLine = (s) => String(s ?? '').split('\n')[0];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const packages = (ctx) => ctx.data?.packages ?? [];
const found = (ctx) => ctx.found ?? [];

/**
 * The folder's lock files and projects, read again; then, unless the setting is off or `audit` false,
 * OSV is asked about them (`fresh`: about every package, not taking its recent answers from the cache).
 */
export async function scan(ctx, { audit: thenAudit = ctx.config.autoAudit !== false, fresh = false } = {}) {
  const dir = ctx.cwd();
  const r = await ctx.task(
    `scan ${basename(dir) || dir}`,
    async () => {
      const result = await ctx.provider.scan(dir);
      ctx.setData((d) => {
        // An image taken from Wharf isn't on the disk: it stays while Bilge reads the same folder.
        const same = d?.root === result.root;
        const images = same ? (d.manifests ?? []).filter((m) => m.kind === 'image') : [];
        const manifests = images.length ? [...result.manifests, ...images] : result.manifests;
        return { ...result, manifests, packages: images.length ? mergePackages(manifests) : result.packages, audit: null, latest: same ? d.latest : null };
      });
      const n = result.manifests.length;
      return { stdout: n ? `${plural(result.packages.length, 'package')} in ${plural(n, 'manifest')}` : 'No lock file (package-lock.json, yarn.lock, pnpm-lock.yaml, packages.lock.json) or .NET project here.' };
    },
    { label: 'Reading lock files' },
  );
  if (r.ok && thenAudit && packages(ctx).length) return audit(ctx, { fresh });
  return r.ok;
}

/**
 * /audit [fresh]: OSV's advisories for every package found. What OSV said in the last six hours (a
 * day for an advisory's record) comes from the cache; `fresh` asks about everything again.
 */
export async function audit(ctx, { fresh = false } = {}) {
  const list = packages(ctx);
  if (!list.length) return ctx.note(ctx.data?.manifests?.length ? 'No packages with exact versions to ask about.' : 'Nothing read yet: /scan reads this folder.', 'error') ?? false;
  const r = await ctx.task(
    `audit ${plural(list.length, 'package')}${fresh ? ', fresh' : ''}`,
    async (signal) => {
      const { ids, details, cached = 0 } = await ctx.provider.audit(list, { signal, fresh });
      ctx.setData((d) => ({ ...d, audit: { ids, details, at: Date.now() } }));
      const line = countLine(counts(withoutIgnored(findings(list, ids, details), ctx.config.ignore ?? [])));
      const kept = cached ? `\n${cached === list.length ? 'All' : `${cached} of ${list.length}`} from OSV's answers of the last few hours (/audit fresh asks again)` : '';
      return { stdout: `${line || 'Nothing known against them.'}${kept}` };
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

/**
 * /outdated [all]: the registries' newest versions of the direct packages (or of all of them), and
 * their licences. Where the newest one wouldn't fit the project (a framework it isn't built for, a Node
 * it doesn't run on, a peer it won't take), the newest that would is asked for too.
 */
export async function outdated(ctx, which = '') {
  const all = /^all$/i.test(which.trim());
  const list = packages(ctx).filter((p) => hasRegistry(p) && (all || p.direct));
  if (!list.length) return ctx.note('No packages to look up: /scan reads this folder.', 'error') ?? false;
  const r = await ctx.task(
    `outdated ${all ? 'all' : 'direct'}: ${plural(list.length, 'package')}`,
    async (signal) => {
      const latest = await ctx.provider.latest(list, { signal, onProgress: (n, of) => ctx.progress(`${n}/${of}`) });
      const behind = list.filter((p) => bumpOf(p.version, latest.get(p.key)?.latest));
      const blocked = behind.filter((p) => problems(p, latest.get(p.key).latest, latest.get(p.key).needs, ctx.data).length);
      let n = 0;
      for (const p of blocked) {
        ctx.progress(`newest that fits ${++n}/${blocked.length}`);
        const fits = (version, needs) => !problems(p, version, needs, ctx.data).length;
        const found = await ctx.provider.fitting(p, fits, { signal }).catch((e) => {
          if (e.cancelled || signal.aborted) throw e;
          return undefined;
        });
        if (found !== undefined) latest.set(p.key, { ...latest.get(p.key), fits: found });
      }
      ctx.setData((d) => ({ ...d, latest: new Map([...(d.latest ?? []), ...latest]) }));
      const failed = [...latest.values()].filter((x) => x.error).length;
      return { stdout: `${plural(behind.length, 'package')} behind${blocked.length ? `, ${blocked.length} whose newest version doesn't fit this project` : ''}${failed ? `; ${failed} the registry couldn't answer for` : ''}` };
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

/** What the project runs on, as a package sees it: its frameworks, or the Node it says. */
function runsOnLine(ctx, p) {
  if (p.ecosystem === 'NuGet') {
    const targets = [...new Set(targetsOf(p, ctx.data).map((t) => t.framework))];
    return `Project targets: ${targets.join(', ') || 'unknown (no TargetFramework read, so frameworks aren\'t checked)'}`;
  }
  const node = nodeOf(p, ctx.data);
  return `Project's Node: ${node ? `${node.range ?? node.version} (${node.from})` : 'not said (engines.node in package.json or .nvmrc), so Node isn\'t checked'}`;
}

/** Whether the newest version fits the project, and if not, why, and the newest that does. */
function fitLines(ctx, p, latest) {
  if (!latest?.latest || !bumpOf(p.version, latest.latest)) return [];
  const found = problems(p, latest.latest, latest.needs, ctx.data);
  if (!found.length) return [`Fits: nothing Bilge checks stands in the way of ${latest.latest}`, runsOnLine(ctx, p)];
  const instead = latest.fits === undefined ? [] : [latest.fits ? `Newest that fits: ${latest.fits.version}` : 'Newest that fits: none newer than this one'];
  return [`Before moving to ${latest.latest}:`, ...found.map((x) => `  · ${x}`), ...instead, runsOnLine(ctx, p)];
}

/** ↵ on a package: what's known about it. */
export function showPackage(ctx, p) {
  const latest = ctx.data.latest?.get(p.key);
  const licence = licenceOf(p, ctx.data.latest);
  const f = found(ctx).find((x) => x.key === p.key);
  ctx.showText(label(p), [
    `${label(p)}  ${p.ecosystem}${!hasRegistry(p) ? `, in the image${p.binaries ? ` as ${p.binaries.join(', ')}` : ''}` : p.direct ? ', direct' : ', brought in by another package'}${p.dev ? ', development only' : ''}`,
    `Licence: ${licence ?? 'unknown (/outdated asks the registry)'}${licence ? `  (${licenceKind(licence)})` : ''}`,
    `Newest: ${latest ? (latest.error ? `couldn't ask: ${latest.error}` : `${latest.latest ?? '?'}${bumpOf(p.version, latest.latest) ? `  (${bumpOf(p.version, latest.latest)} behind)` : '  (up to date)'}`) : 'not asked yet (/outdated)'}`,
    ...(latest?.deprecated ? [`Deprecated: ${latest.deprecated}`] : []),
    ...fitLines(ctx, p, latest),
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
  // What the fixed version needs, against the project: said in the question, the whole of it a key away.
  const warnings = await fixWarnings(ctx, f);
  const options = [{ label: 'Yes, run it', value: true }, { label: 'Copy the command', value: 'copy' }, ...(warnings.length ? [{ label: 'See why it may not fit', value: 'why' }] : []), { label: 'No', value: false }];
  const yes = await ctx.confirm({
    title: `Move ${f.pkg.name} from ${f.pkg.version} to ${f.fixed}?${warnings.length ? ` It may not fit: ${plural(warnings.length, 'problem')}` : ''}`,
    detail: warnings.length ? warnings.join(' · ') : plan.text,
    ...(warnings.length ? { danger: true } : {}),
    options,
  });
  if (yes === 'why') return ctx.showText(`Fixing ${label(f.pkg)}`, [`Moving to ${f.fixed} may not fit this project:`, ...warnings.map((w) => `  · ${w}`), '', `The fix: ${plan.text}`, '', 'f again runs it anyway; a newer version may fit (↵ in Packages says).'].join('\n')) ?? false;
  if (yes === 'copy') return ctx.copy(plan.run.command, 'the command') ?? true;
  if (!yes || !(await productionOk(ctx, `Move ${f.pkg.name} to ${f.fixed}`))) return false;
  const r = await ctx.task(plan.run.command, (signal) => ctx.provider.run(plan.run.command, { cwd: plan.run.cwd, signal }), {
    label: `Moving ${f.pkg.name}`,
    activity: `Moved ${f.pkg.name} ${f.pkg.version} → ${f.fixed} in ${manifest.path}`,
  });
  if (!r.ok) return false;
  await scan(ctx, { audit: true });
  // Whether the project still holds together: npm ls or dotnet restore, last so /last has what it said.
  if (plan.check) {
    const c = await ctx.task(plan.check.command, (signal) => ctx.provider.run(plan.check.command, { cwd: plan.check.cwd, signal }), { label: 'Checking' });
    if (!c.ok && !c.error?.cancelled) ctx.note(`${plan.check.command} found a problem after moving ${f.pkg.name}: /last says what.`, 'error');
  }
  return true;
}

/**
 * /upgrade: every direct package with a newer version that fits the project (the newest, else the
 * newest that fits), from the last /outdated (asked first when it hasn't been). One question lists
 * them; then, on a clean working tree, a branch of their own (bilge/updates-<date>), each update's
 * command where its manifest is, the project's tests, and a commit, saying how each step went. A
 * failed step stops it there, the branch left for the person. Splice gets the branch.
 */
export async function upgrade(ctx) {
  if (!packages(ctx).length) return ctx.note('No packages to update: /scan reads this folder.', 'error') ?? false;
  const asked = packages(ctx).some((p) => p.direct && hasRegistry(p) && ctx.data.latest?.has(p.key));
  if (!asked && !(await outdated(ctx))) return false;
  const list = upgradeCandidates(ctx.data);
  if (!list.length) return ctx.note("Nothing to update: every direct package is at its newest version, or no newer one fits this project (↵ in Packages says why).") ?? true;
  const root = ctx.cwd();
  const steps = list.flatMap((u) => u.steps.map((s) => ({ ...s, pkg: u.pkg, to: u.to })));
  const lines = list.map((u) => `${u.pkg.name} ${u.pkg.version} → ${u.to}${u.capped ? ' (the newest that fits)' : ''}`);
  const yes = await ctx.confirm({
    title: `Update ${plural(list.length, 'package')} on a branch of their own, then run the tests?`,
    detail: lines.join(' · '),
    options: [{ label: 'Yes, update them', value: true }, { label: 'Copy the commands', value: 'copy' }, { label: 'See the list', value: 'list' }, { label: 'No', value: false }],
  });
  if (yes === 'list') return ctx.showText(`Updates that fit (${list.length})`, [...lines, '', 'The commands:', ...steps.map((s) => `  ${s.command}  (in ${folderLabel(root, s.cwd)})`), '', '/upgrade again runs them on a new branch.'].join('\n')) ?? false;
  if (yes === 'copy') {
    const byFolder = [...new Set(steps.map((s) => folderLabel(root, s.cwd)))].flatMap((f) => [`# in ${f}`, ...steps.filter((s) => folderLabel(root, s.cwd) === f).map((s) => s.command)]);
    return ctx.copy(byFolder.join('\n'), 'the commands') ?? true;
  }
  if (!yes || !(await productionOk(ctx, `Update ${plural(list.length, 'package')}`))) return false;

  const done = [];
  const say = (ok, text) => done.push(`${ok ? '✓' : '✗'} ${text}`);
  const report = (title, tail) => ctx.showText(title, [...done, ...(tail ? ['', ...tail] : [])].join('\n'));
  const step = (command, cwd, opts) => ctx.task(command, (signal) => ctx.provider.run(command, { cwd, signal }), opts);

  // Only on a clean tree: the commit should hold the updates and nothing else.
  const status = await step('git status --porcelain', root, { label: 'Checking the working tree' });
  if (!status.ok) return ctx.note(`/upgrade needs a git repository here: ${firstLine(status.error.message)}`, 'error') ?? false;
  if (status.out.trim()) return ctx.note('The working tree has changes: commit or stash them first (Splice does both), then /upgrade again. Nothing was changed.', 'error') ?? false;
  const branch = await newBranch(ctx, root);
  if (!branch) return false;
  say(true, `on a new branch, ${branch}`);

  for (const [i, s] of steps.entries()) {
    const r = await step(s.command, s.cwd, { label: `Updating ${i + 1}/${steps.length}`, activity: `Updated ${s.pkg.name} ${s.pkg.version} → ${s.to} in ${s.manifest.path} on ${branch}` });
    say(r.ok, `${s.command}  (in ${folderLabel(root, s.cwd)})`);
    if (!r.ok) {
      report(`Upgrade stopped at step ${i + 1} of ${steps.length}`, [`${s.command} failed: /last says what it printed.`, `${branch} is left as it is, with the updates before it uncommitted, for you to finish or drop (Splice: /discard, /checkout).`]);
      return false;
    }
  }
  const tests = await ctx.provider.tests([...new Set(steps.map((s) => s.manifest))], root);
  for (const t of tests) {
    const r = await step(t.command, t.cwd, { label: 'Testing' });
    say(r.ok, `${t.command}  (in ${folderLabel(root, t.cwd)})`);
    if (!r.ok) {
      report(`Upgrade stopped: ${t.command} failed`, [`/last says what it printed. The updates are on ${branch}, not committed, for you to look into.`]);
      return false;
    }
  }
  if (!tests.length) say(true, 'no tests found to run (a test script in package.json, a .sln or a .csproj)');
  const message = `Update ${plural(list.length, 'package')}`;
  for (const command of ['git add -A', `git commit -m "${message}"`]) {
    const r = await step(command, root, { label: 'Committing' });
    say(r.ok, command);
    if (!r.ok) {
      report('Upgrade not committed', [`/last says why. The updates are on ${branch}, tested, for you to commit.`]);
      return false;
    }
  }
  ctx.logActivity(`${message} on ${branch} in ${basename(root)}`, 'change');
  await scan(ctx, { audit: true });
  // Splice pushes it and opens the pull request: the line that checks the branch out there.
  const line = shareLine('checkout', [branch]);
  ctx.copy(line, 'a line for Splice');
  report(`${message} on ${branch}`, [`Committed "${message}". Push it from Splice (/push, then /pr) to open its pull request.`]);
  ctx.note(copiedNote('splice', line));
  return true;
}

/**
 * /breaking <package>: for a package a major version behind, Claude says what changes between the
 * installed version and the newest for this code: the package, the versions, its registry page and
 * repository, and the project's lines that import it. The newest is asked for first when /outdated
 * hasn't been.
 */
export async function breaking(ctx, name = '') {
  const p = findPackage(packages(ctx), name);
  if (!p) return ctx.note(name.trim() ? `No package ${name.trim()} here.` : '/breaking needs a package: /breaking express', 'error') ?? false;
  if (p.ecosystem !== 'npm' && p.ecosystem !== 'NuGet') return ctx.note(`${p.name} isn't from npm or NuGet: /breaking is for those.`, 'error') ?? false;
  if (!ctx.data.latest?.get(p.key)?.latest) {
    const r = await ctx.task(`newest ${p.name}`, async (signal) => {
      const latest = await ctx.provider.latest([p], { signal });
      ctx.setData((d) => ({ ...d, latest: new Map([...(d.latest ?? []), ...latest]) }));
      return { stdout: latest.get(p.key)?.error ?? `${p.name} ${latest.get(p.key)?.latest ?? '?'}` };
    }, { label: 'Asking the registry' });
    if (!r.ok) return false;
  }
  const latest = ctx.data.latest?.get(p.key);
  if (!latest?.latest) return ctx.note(`The registry didn't say what ${p.name}'s newest version is.`, 'error') ?? false;
  if (bumpOf(p.version, latest.latest) !== 'major') {
    return ctx.note(`${p.name} ${p.version} → ${latest.latest} isn't a major version: /breaking is for those, where what a package offers can change.${bumpOf(p.version, latest.latest) ? '' : ' It is up to date.'}`) ?? true;
  }
  let answer = '';
  let used = [];
  const r = await ctx.task(
    `claude: ${p.name} ${p.version} → ${latest.latest}`,
    async (signal) => {
      used = await ctx.provider.usages(ctx.cwd(), p, { signal });
      ctx.progress(`with ${plural(used.length, 'line')} that import it`);
      answer = await ctx.provider.claude(breakingPrompt(p, p.version, latest.latest, { page: packageUrl(p), repository: latest.repository }), { input: breakingInput(p, used), cwd: ctx.cwd(), signal });
      return { stdout: `${plural(used.length, 'line')} that import it, and Claude's answer` };
    },
    { label: 'Asking Claude' },
  );
  if (!r.ok) return false;
  ctx.showText(`${p.name} ${p.version} → ${latest.latest}: what breaks here (Claude)`, `${answer}\n\n${used.length ? `Lines that import it: ${used.length} (${[...new Set(used.map((u) => u.path))].slice(0, 5).join(', ')}${new Set(used.map((u) => u.path)).size > 5 ? ', …' : ''})` : 'No line imports it by its name.'}`);
  return true;
}

/** `git checkout -b` the day's branch, or the day's second, third… when that one's taken. */
async function newBranch(ctx, root) {
  const base = branchName();
  for (let n = 1; n <= 9; n++) {
    const branch = n === 1 ? base : `${base}-${n}`;
    const r = await ctx.task(`git checkout -b ${branch}`, (signal) => ctx.provider.run(`git checkout -b ${branch}`, { cwd: root, signal }), { label: 'Making the branch' });
    if (r.ok) return branch;
    if (!/already exists/i.test(r.error?.message ?? '')) {
      ctx.note(`Couldn't make the branch ${branch}: ${firstLine(r.error?.message)}`, 'error');
      return null;
    }
  }
  ctx.note(`${base} and the next eight are taken: delete some in Splice, then /upgrade again.`, 'error');
  return null;
}

/**
 * Whether to go on with `what`, which changes the project: asked once more when the project's
 * environment is production (.fleet/project.json's "prod": true), straight on otherwise.
 */
async function productionOk(ctx, what) {
  const question = productionQuestion(ctx.env, what);
  return !question || (await ctx.confirm(question)) === true;
}

/** /env [name]: the project's environment; a name switches every app of the family to it. */
export function env(ctx, name = '') {
  if (!name.trim()) return ctx.note(describeEnvironments(ctx.cwd()));
  const r = setEnvironment(ctx.cwd(), name, { by: 'bilge' });
  if (!r.ok) return ctx.note(r.error, 'error') ?? false;
  ctx.note(`Environment: ${r.env.name}${r.env.prod ? ' (production: fixes and /upgrade ask first)' : ''}, for every app.`, 'ok');
  return true;
}

/** What stands in the way of a fix's version, asked of the registry (a few seconds at most); a failure to ask says so. */
async function fixWarnings(ctx, f) {
  try {
    const needs = await ctx.provider.needs(f.pkg, f.fixed, { signal: AbortSignal.timeout(10000) });
    return needs ? problems(f.pkg, f.fixed, needs, ctx.data) : [];
  } catch (e) {
    return [`Couldn't ask the registry what ${f.fixed} needs: ${String(e.message).split('\n')[0]}`];
  }
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
  const where = pkg.where.find((w) => !w.path.startsWith('image '));
  if (!where && pkg.where.length) return ctx.note(`${pkg.name} is in an image, not in a file Splice has: its Dockerfile's base image brings it in.`, 'error') ?? false;
  if (!where) return ctx.note(`${pkg.name} isn't in a manifest Bilge read.`, 'error') ?? false;
  const line = takeLine('file', fileData(where));
  ctx.copy(line, 'a line for Splice');
  ctx.note(copiedNote('splice', line));
  return true;
}

/** t on a manifest: the file itself, for Splice's history of it. */
export function shareManifest(ctx, manifest) {
  if (manifest.kind === 'image') return ctx.note(`${manifest.image} is an image, not a file Splice has.`, 'error') ?? false;
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

/** /report [file]: the audit as Markdown, to read here and copy (alt+y) into a pull request or a ticket, or written to a file (asking before replacing one). */
export async function report(ctx, file = '') {
  if (!ctx.data?.audit) return ctx.note('Not audited yet: /audit first.', 'error') ?? false;
  const md = markdownReport({ name: basename(ctx.cwd()), manifests: ctx.data.manifests, packages: packages(ctx), found: found(ctx), code: ctx.code ? codeFound(ctx) : null });
  const name = file.trim();
  if (!name) {
    ctx.showText('Report (alt+y copies it all)', md);
    return true;
  }
  const path = isAbsolute(name) ? name : resolve(ctx.cwd(), name);
  if (ctx.provider.name !== 'demo' && existsSync(path)) {
    const yes = await ctx.confirm({ title: `Replace ${name}?`, detail: path, danger: true });
    if (!yes) return false;
  }
  const r = await ctx.task(`report ${name}`, async () => {
    ctx.provider.writeFile(path, md);
    return { stdout: `Report in ${path}` };
  }, { label: 'Writing' });
  return r.ok;
}

/** The code findings as shown: the last /code's, without what the config ignores. */
export const codeFound = (ctx) => withoutIgnoredCode(ctx.code?.findings ?? [], ctx.config.codeIgnore ?? []);

/**
 * /code: the folder's own files read for what an attacker looks for first (codescan.js): secrets in
 * the code, code that runs what it's given, TLS checks off, a container running as root, a .env git
 * would commit. It reads the files and nothing else: nothing is run or sent.
 */
export async function code(ctx) {
  const dir = ctx.cwd();
  const r = await ctx.task(
    `code ${basename(dir) || dir}`,
    async (signal) => {
      const result = await ctx.provider.code(dir, { signal, onProgress: (n) => ctx.progress(`${n} files`) });
      ctx.setCode(result);
      const shown = codeFound(ctx);
      const line = countLine(counts(shown));
      const more = result.truncated ? `\nStopped after ${result.files} files: /move to a smaller folder to read the rest.` : '';
      return { stdout: `${plural(result.files, 'file')} read: ${line || 'nothing found'}${more}` };
    },
    { label: 'Reading the code' },
  );
  if (r.ok) {
    const c = counts(codeFound(ctx));
    // Only the counts go to the family's log, never what was found: a finding may be a secret's place.
    ctx.logActivity(`Code of ${basename(dir)}: ${countLine(c) || 'nothing found'}`, 'info');
    ctx.setView('code');
  }
  return r.ok;
}

/** ↵ on a code finding: what it is, where, why it matters and what to do. */
export function showCodeFinding(ctx, f) {
  ctx.showText(`${f.title} · ${findingWhere(f)}`, [
    `${SEVERITY_LABEL[f.severity]}  ${f.title}${f.test ? '  (in a test, an example or a fixture: one step milder)' : ''}`,
    `In: ${findingWhere(f)}`,
    '',
    `  ${f.excerpt}`,
    '',
    f.why,
    '',
    `Fix: ${f.fix}`,
    '',
    f.kind === 'secret' ? 'A secret that was ever committed stays in the history: rotate it, removing it is not enough.' : '',
    `x ignores ${f.rule} in this file; a "bilge-ignore" comment on the line (or the one above) leaves just that line out.`,
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n'));
}

/** t on a code finding: its file and line, for Splice to blame (who wrote it, and when). */
export function shareCode(ctx, f) {
  const line = takeLine('file', fileData({ path: f.path, line: f.line || undefined }));
  ctx.copy(line, 'a line for Splice');
  ctx.note(copiedNote('splice', line));
  return true;
}

/** x on a code finding: its rule in its file left out (kept in the settings as `rule:path`). */
export async function ignoreCode(ctx, f) {
  const key = `${f.rule}:${f.path}`;
  const yes = await ctx.confirm({ title: `Ignore ${f.title.toLowerCase()} in ${f.path}?`, detail: `It stays out of the Code view and bilge code's exit code until it's taken out of "codeIgnore" in ${configFile()}.` });
  if (!yes) return false;
  ctx.setConfig((c) => ({ ...c, codeIgnore: [...new Set([...(c.codeIgnore ?? []), key])] }));
  ctx.note(`Ignoring ${key}`, 'ok');
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

/** /take: an image Wharf handed over (its system packages, audited); any other context says whose it is. */
export function take(ctx, text) {
  const context = contextIn(text);
  if (!context) return ctx.note('/take needs what a sibling copied: a family:v1:… line.', 'error') ?? false;
  if (context.kind === 'image') return takeImage(ctx, String(context.data.image ?? ''));
  return ctx.note(notMine('bilge', context), 'error') ?? false;
}

/**
 * The operating-system packages of a container image, read out of it without running it (the
 * provider's `image`: docker create, docker cp of dpkg's or apk's database and os-release, docker rm),
 * added to what's shown as a manifest of its own, and audited with the rest.
 */
async function takeImage(ctx, image) {
  if (!safeImage(image)) return ctx.note(`${image || 'That'} isn't an image name Bilge will put in a command.`, 'error') ?? false;
  const r = await ctx.task(
    `image ${image}`,
    async (signal) => {
      const manifest = await ctx.provider.image(image, { signal });
      ctx.setData((d) => {
        const manifests = [...(d?.manifests ?? []).filter((m) => m.path !== manifest.path), manifest];
        return { ...(d ?? { root: ctx.cwd(), latest: null }), manifests, packages: mergePackages(manifests), audit: null };
      });
      return { stdout: manifest.note };
    },
    { label: 'Reading the image' },
  );
  if (!r.ok) return false;
  ctx.setView('vulns');
  return packages(ctx).length ? audit(ctx) : true;
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
      `Code ignored     ${(c.codeIgnore ?? []).join(', ') || 'none'}       x in Code; "codeIgnore" in the file`,
      `Update checks    ${on(c.checkForUpdates)}       "checkForUpdates" in the file`,
      `Auto-update      ${on(c.autoUpdate)}       "autoUpdate" in the file`,
      `History          ${(c.history ?? []).length} lines`,
      '',
      `Kept in ${configFile()}`,
    ].join('\n'),
  );
  return true;
}
