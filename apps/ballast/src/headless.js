// ballast check, ballast compare and ballast security: the same reading as the app, without the
// screen, for a pipeline. `check` holds the build to its budgets and its growth against a base, and
// exits 1 when one fails (0 fine, 2 couldn't run), as `bilge audit --fail-on` does; `compare` prints
// the change against a base (--markdown: the table for a pull request); `security` prints the kit's
// findings (source maps shipped, secrets in the bundle), --json in the shape every app's security
// check prints, which Fleet's security overview adds up.
import { resolve } from 'node:path';
import { budgetLine, checkBudgets, growthFails, growthLine, parseBudget, parseFailOn } from './budgets.js';
import { compareMarkdown, compareRuns, runLabel, summarize } from './compare.js';
import { savedBase } from './base.js';
import { totals } from './build.js';
import { MEASURES, formatBytes, formatPercent, sizeIn } from './sizes.js';
import { sarifOf } from './security.js';
import { failingFindings, findingsText, parseFailOn as parseLevel, securityJson, withoutIgnoredFindings } from '@fleet/kit/findings.js';

export const HEADLESS = ['check', 'compare', 'security'];

/**
 * The options after `ballast <command>`: { command, dir, budgets, failOn, base, baseStats, stats,
 * measure, build, json, markdown, out, sarif, level }, or with `error` when they don't add up.
 */
export function parseArgs(args) {
  const [command, ...rest] = args;
  const opts = { command, dir: '.', budgets: [], failOn: [], base: null, baseStats: null, stats: null, measure: null, build: false, json: false, markdown: false, out: null, sarif: null, level: 'high' };
  const value = (i, name) => (rest[i] === undefined || (rest[i].startsWith('--') && rest[i] !== '-') ? { error: `${name} needs a value` } : { v: rest[i] });
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const take = () => {
      if (inline !== undefined) return { v: inline };
      const r = value(i + 1, flag);
      if (!r.error) i++;
      return r;
    };
    if (flag === '--json') opts.json = true;
    else if (flag === '--markdown' || flag === '--md') opts.markdown = true;
    else if (flag === '--build') opts.build = true;
    else if (flag === '--sarif') {
      if (inline !== undefined) opts.sarif = inline || '-';
      else opts.sarif = rest[i + 1] && !rest[i + 1].startsWith('-') ? rest[++i] : rest[i + 1] === '-' ? rest[++i] : '-';
    } else if (['--budget', '--fail-on', '--base', '--base-stats', '--stats', '--measure', '-o', '--output'].includes(flag)) {
      const r = take();
      if (r.error) return { ...opts, error: r.error };
      if (flag === '--budget') {
        const b = parseBudget(r.v);
        if (b.error) return { ...opts, error: b.error };
        opts.budgets.push(b);
      } else if (flag === '--fail-on') {
        if (command === 'security') {
          if (!parseLevel(r.v)) return { ...opts, error: '--fail-on is critical, high, medium, low or none' };
          opts.level = parseLevel(r.v);
        } else {
          const c = parseFailOn(r.v);
          if (c.error) return { ...opts, error: c.error };
          opts.failOn.push(c);
        }
      } else if (flag === '--base') opts.base = r.v;
      else if (flag === '--base-stats') opts.baseStats = r.v;
      else if (flag === '--stats') opts.stats = r.v;
      else if (flag === '--measure') {
        if (!MEASURES.includes(r.v)) return { ...opts, error: '--measure is gzip, brotli or raw' };
        opts.measure = r.v;
      } else opts.out = r.v;
    } else if (a.startsWith('-')) return { ...opts, error: `Unknown option ${a}` };
    else opts.dir = a;
  }
  if (opts.sarif && command !== 'security') return { ...opts, error: '--sarif is for security' };
  if (opts.sarif === '-' && opts.json) return { ...opts, error: '--json and --sarif both want the output: give --sarif a file (--sarif ballast.sarif)' };
  if (opts.markdown && opts.json) return { ...opts, error: '--markdown or --json, not both' };
  return opts;
}

/**
 * The build to judge: the stats file named, else what the folder has; with nothing there, the build
 * with stats is run only with --build (a pipeline never builds unasked). Throws a sentence otherwise.
 */
async function buildOf(provider, dir, opts, write) {
  const build = await provider.read(dir, { stats: opts.stats });
  if (build.chunks.length) return build;
  const plan = provider.plan(dir);
  if (!opts.build) throw new Error(`Nothing to read under ${dir}: no stats file and no output folder (dist, build, .next/static, out).${plan ? ` --build runs ${plan.command} once, with stats.` : ' Build it first.'}`);
  if (!plan) throw new Error(`Nothing to read under ${dir}, and nothing says how it builds (no build script in package.json).`);
  write(`Building with stats: ${plan.command}\n`);
  const built = await provider.build(dir, plan);
  if (!built.chunks.length) throw new Error(`${plan.command} ran, but left nothing Ballast could read.`);
  return built;
}

/** The base summary for `opts`, or { missing }: --base-stats's file, else a kept run, else (--build) a worktree build of the ref. */
async function baseOf(provider, dir, opts, key, write) {
  if (opts.baseStats) {
    const b = await provider.read(dir, { stats: opts.baseStats });
    if (!b.chunks.length) return { missing: `${opts.baseStats} holds no build.` };
    return { run: summarize(b, { at: null }), name: opts.baseStats };
  }
  const found = await savedBase(provider, dir, { base: opts.base ?? 'last', key });
  if (found.run || !found.canBuild) return found;
  if (!opts.build) return { ...found, missing: `${found.missing} --build builds it in a git worktree, or --base-stats <file> takes a stats file from a build of ${found.name}.` };
  write(`Building ${found.name} (${found.commit.slice(0, 7)}) in a git worktree…\n`);
  const built = await provider.buildRef(dir, found.commit, { progress: (p) => write(`  ${p}\n`) });
  const run = summarize(built, { commit: found.commit, branch: found.name });
  provider.saveRun(dir, run);
  return { run, name: found.name, commit: found.commit };
}

/** Runs one of HEADLESS; resolves the exit code. `write` prints, `provider` is provider.js's (demo.js's in tests). */
export async function runHeadless(args, { provider, config = {}, write = (s) => process.stdout.write(s), version = '0.0.0' }) {
  const opts = parseArgs(args);
  if (opts.error) {
    write(`ballast ${opts.command}: ${opts.error}\n`);
    return 2;
  }
  const dir = resolve(opts.dir);
  try {
    if (opts.command === 'security') return await runSecurity(opts, dir, { provider, config, write, version });
    return await runSizes(opts, dir, { provider, config, write });
  } catch (e) {
    write(`ballast ${opts.command}: ${String(e.message).split('\n')[0]}\n`);
    return 2;
  }
}

async function runSizes(opts, dir, { provider, write }) {
  const file = provider.budgets(dir);
  for (const e of file.errors ?? []) write(`${file.from}: ${e}\n`);
  const measure = opts.measure ?? file.measure ?? 'gzip';
  // A budget given here replaces the file's for the same files.
  const budgets = [...(file.budgets ?? []).filter((b) => !opts.budgets.some((o) => o.pattern === b.pattern)), ...opts.budgets];
  const failOn = opts.failOn.length ? opts.failOn : file.failOn?.length ? file.failOn : [{ kind: 'budget', text: 'budget' }];
  const say = (s) => (opts.json || opts.markdown ? undefined : write(s));

  const build = await buildOf(provider, dir, opts, say);
  const git = await provider.git(dir);
  const head = summarize(build, { commit: git?.commit, branch: git?.branch, dirty: git?.dirty });
  // Kept before the base is looked for: "last" passes over this build's own key.
  provider.saveRun(dir, head);
  const growth = failOn.filter((c) => c.kind === 'growth');
  const wantsBase = opts.command === 'compare' || growth.length || opts.base || opts.baseStats;
  const base = wantsBase ? await baseOf(provider, dir, opts, head.key, say) : null;
  const result = base?.run ? compareRuns(base.run, head, measure) : null;

  if (opts.command === 'compare') {
    if (!result) {
      write(`ballast compare: ${base.missing}\n`);
      return 2;
    }
    let text;
    if (opts.markdown) text = compareMarkdown(result, { base: base.run, head, baseName: base.name === 'the last build' ? null : base.name });
    else if (opts.json) text = `${JSON.stringify({ dir, base: { name: base.name, ...pick(base.run) }, head: pick(head), measure: result.measure, total: result.total, headline: result.headline, chunks: result.chunks.map(slim), packages: result.packages.map((p) => ({ ...slim(p), reason: p.reason })) }, null, 2)}\n`;
    else text = compareText(result, base, head);
    if (opts.out) {
      provider.writeFile(resolve(opts.out), text);
      write(`${result.headline}; written to ${resolve(opts.out)}\n`);
    } else write(text);
    return 0;
  }

  const checks = checkBudgets(build.chunks, budgets, measure);
  const failing = [];
  if (failOn.some((c) => c.kind === 'budget')) for (const b of checks.filter((x) => x.over)) failing.push(`budget ${b.pattern}`);
  for (const c of growth) if (result && growthFails(c, result.total)) failing.push(c.text);
  if (opts.json) {
    write(
      `${JSON.stringify(
        {
          dir,
          source: build.source.label,
          measure,
          total: totals(build.chunks),
          budgets: checks.map((b) => ({ pattern: b.pattern, limit: b.limit, size: b.size, over: b.over, matched: !b.none, files: b.files })),
          base: base ? (base.run ? { name: base.name, ...pick(base.run) } : { name: base.name, missing: base.missing }) : null,
          growth: result ? { ...result.total, headline: result.headline } : null,
          failOn: failOn.map((c) => c.text),
          failing,
        },
        null,
        2,
      )}\n`,
    );
    return failing.length ? 1 : 0;
  }
  const lines = [`${build.chunks.length} files under ${dir} (${build.source.label}): ${formatBytes(sizeIn(totals(build.chunks), measure))} ${measure}`];
  if (!budgets.length) lines.push(`No budgets: give --budget dist/assets/index-*.js=180kB, or put them in ballast.json.`);
  for (const b of checks) lines.push(budgetLine(b, measure));
  if (base) lines.push(result ? `Against ${runLabel(base.run, base.name)}: ${result.headline}${result.total.before ? ` (${formatPercent(result.total.delta, result.total.before)})` : ''}` : `Not compared: ${base.missing}`);
  for (const c of growth) lines.push(!result ? `----  ${c.text}: not checked, nothing to compare with` : `${growthFails(c, result.total) ? 'FAIL' : 'ok  '}  ${c.text}: ${growthLine(result.total)}`);
  lines.push(failing.length ? `Failing: ${failing.join(', ')}` : 'Within its budgets.');
  write(`${lines.join('\n')}\n`);
  return failing.length ? 1 : 0;
}

const pick = (run) => ({ key: run.key, commit: run.commit, branch: run.branch, at: run.at ? new Date(run.at).toISOString() : null, total: run.total });
const slim = (x) => ({ name: x.name, status: x.status, delta: x.delta, before: x.before ? x.before.gzip ?? x.before.raw : null, after: x.after ? x.after.gzip ?? x.after.raw : null });

/** The comparison as plain text: the headline, then each chunk and package that changed. */
export function compareText(result, base, head) {
  const m = result.measure;
  const lines = [`${result.headline}${result.total.before ? ` (${formatPercent(result.total.delta, result.total.before)})` : ''}`, `Against ${runLabel(base.run, base.name)}; this build ${runLabel(head, head.branch)}.`, ''];
  for (const c of result.chunks.filter((x) => x.status !== 'same')) lines.push(`${c.status === 'added' ? 'new ' : c.status === 'removed' ? 'gone' : c.delta > 0 ? 'more' : 'less'}  ${c.name}  ${c.before ? formatBytes(c.before[m] ?? c.before.raw) : '—'} → ${c.after ? formatBytes(c.after[m] ?? c.after.raw) : '—'}`);
  if (result.packages.length) lines.push('', 'Packages:', ...result.packages.slice(0, 20).map((p) => `  ${p.delta >= 0 ? '+' : '-'}${formatBytes(Math.abs(p.delta)).padStart(9)}  ${p.reason}`));
  return `${lines.join('\n')}\n`;
}

/** ballast security: the output folders' source maps and the bundles' secrets, without the config's securityIgnore. */
async function runSecurity(opts, dir, { provider, config, write, version }) {
  const result = await provider.security(dir);
  const all = withoutIgnoredFindings(result.findings, config.securityIgnore ?? []);
  const header = result.dirs.length ? `${result.files} files in ${result.dirs.map((d) => `${d}/`).join(', ')} under ${dir}` : `No output folder (dist, build, .next/static, out) under ${dir}: nothing built to read.`;
  const sarif = () => `${JSON.stringify(sarifOf(all, version), null, 2)}\n`;
  if (opts.sarif === '-') write(sarif());
  else {
    write(opts.json ? `${JSON.stringify(securityJson({ app: 'ballast', check: 'security', target: dir, findings: all, extra: { dirs: result.dirs, files: result.files } }), null, 2)}\n` : findingsText(all, { failOn: opts.level, header }));
    if (opts.sarif) {
      provider.writeFile(resolve(opts.sarif), sarif());
      if (!opts.json) write(`SARIF in ${resolve(opts.sarif)}\n`);
    }
  }
  return failingFindings(all, opts.level).length ? 1 : 0;
}
