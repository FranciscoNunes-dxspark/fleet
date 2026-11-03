// chart check: a plan (a folder's, run now, or a saved one) without the screen, for a pipeline. It
// prints what the plan does and its exit code says whether it does what --fail-on names: 0 fine, 1
// it does, 2 couldn't run.
import { resolve } from 'node:path';
import { statSync, writeFileSync } from 'node:fs';
import { diffLines } from './diff.js';
import { summarize, summaryLine } from './plan.js';
import { ACTION_MARK, changeRows } from './rows.js';
import { markdownReport } from './share.js';
import { CURRENCIES, costWords, planCosts, totalWords } from './costs.js';
import { folderFindings, mergeFindings } from './security.js';
import { VERSION } from './app.js';
import { countFindings, failingFindings, findingsLine, findingsText, parseFailOn, securityJson, toSarif, withoutIgnoredFindings } from '@fleet/kit/findings.js';

export const FAIL_ON = ['destroy', 'replace', 'change', 'drift', 'none'];

/** { command, target, failOn, json, markdown, bin, currency, costs } from the arguments after `chart`; an `error` when they don't add up. */
export function parseArgs(args, { bin = 'terraform', currency = 'USD', costs = true } = {}) {
  const [command, ...rest] = args;
  const opts = { command, target: '.', failOn: 'destroy', json: false, markdown: false, bin, currency, costs };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--markdown') opts.markdown = true;
    else if (a === '--tofu') opts.bin = 'tofu';
    else if (a === '--fail-on') opts.failOn = String(rest[++i] ?? '').toLowerCase();
    else if (a === '--currency') opts.currency = String(rest[++i] ?? '').toUpperCase();
    else if (a === '--no-costs') opts.costs = false;
    else if (a.startsWith('-')) return { ...opts, error: `Unknown option ${a}` };
    else opts.target = a;
  }
  if (!FAIL_ON.includes(opts.failOn)) return { ...opts, error: `--fail-on is one of ${FAIL_ON.join(', ')}` };
  if (!CURRENCIES.includes(opts.currency)) return { ...opts, error: `--currency is one of ${CURRENCIES.join(', ')}` };
  return opts;
}

/** What the plan costs a month, or null when prices are off, or the price list couldn't be asked (a check never fails for want of them). */
async function costsFor(plan, provider, opts) {
  if (!opts.costs || !provider.prices) return null;
  try {
    return await planCosts(plan, { prices: (q) => provider.prices(q, { currency: opts.currency }), currency: opts.currency });
  } catch {
    return null;
  }
}

/** Whether `plan` does what `failOn` names: destroy (a delete or a replacement), replace, change (anything), drift. */
export function fails(plan, failOn) {
  const s = summarize(plan.changes);
  if (failOn === 'destroy') return Boolean(s.delete || s.replace);
  if (failOn === 'replace') return Boolean(s.replace);
  if (failOn === 'change') return plan.changes.some((c) => !['noop', 'read', 'ignore'].includes(c.action));
  if (failOn === 'drift') return plan.drift.length > 0;
  return false;
}

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Runs `chart check`; resolves the exit code. `provider` is iac.js's (demo.js's in tests). */
export async function runHeadless(args, { provider, config = {}, write = (s) => process.stdout.write(s) }) {
  const opts = parseArgs(args, { bin: config.terraform ?? 'terraform', currency: config.currency ?? 'USD', costs: config.costs !== false });
  if (opts.error) {
    write(`chart ${opts.command}: ${opts.error}\n`);
    return 2;
  }
  const target = resolve(opts.target);
  try {
    const read = isFile(target) ? await provider.readFile(target) : await provider.plan(target, { bin: opts.bin, refreshOnly: opts.failOn === 'drift' });
    if (read.kind === 'state') throw new Error(`${opts.target} is a state, not a plan.`);
    const plan = read;
    const failing = fails(plan, opts.failOn);
    const costs = await costsFor(plan, provider, opts);
    if (opts.json) {
      const cost = costs ? { currency: costs.currency, total: costs.priced ? Math.round(costs.total * 100) / 100 : null, priced: costs.priced, unpriced: costs.unpriced, usage: costs.usage, byAddress: costs.byAddress } : null;
      write(`${JSON.stringify({ target, tool: plan.tool, summary: summarize(plan.changes), fails: failing, changes: changeRows(plan.changes), drift: plan.drift, outputs: plan.outputs, cost, security: countFindings(plan.security ?? []) }, null, 2)}\n`);
    } else if (opts.markdown) write(markdownReport(plan, { label: opts.target, costs }));
    else {
      const rows = changeRows(plan.changes);
      write(`${summaryLine(summarize(plan.changes)) || 'No changes.'}\n`);
      for (const c of rows) {
        const cost = costWords(costs?.byAddress?.[c.address], opts.currency);
        write(`${ACTION_MARK[c.action]} ${c.address}${c.reason ? `  (${c.reason})` : ''}${cost ? `  ${cost}` : ''}\n`);
        for (const l of diffLines(c.diff.filter((d) => d.forces))) write(`    ${l}\n`);
      }
      if (plan.drift.length) {
        write(`\nChanged outside ${plan.tool === 'terraform' ? 'Terraform' : 'the template'}:\n`);
        for (const c of plan.drift) write(`~ ${c.address}: ${diffLines(c.diff).map((l) => l.slice(2)).join('; ')}\n`);
      }
      if (securityLine(plan)) write(`\n${securityLine(plan)}\n`);
      if (totalWords(costs)) write(`\nCost: ${totalWords(costs)}, from Azure's retail prices in ${opts.currency}\n`);
      if (failing) write(`\nFailing: the plan does what --fail-on ${opts.failOn} names.\n`);
    }
    return failing ? 1 : 0;
  } catch (e) {
    write(`chart ${opts.command}: ${String(e.message).split('\n')[0]}\n`);
    return 2;
  }
}

/** "Security: 1 critical · 2 high in what it deploys" for chart check's text, '' when nothing in it was found insecure. */
export const securityLine = (plan) => (plan.security?.length ? `Security: ${findingsLine(countFindings(plan.security))} in what it deploys (chart security lists them)` : '');

/**
 * { command, target, plan, source, bin, json, sarif, sarifFile, failOn } from `chart security`'s
 * arguments; an `error` when they don't add up. `--sarif` takes the next word as its file when it
 * ends in .sarif, so a target after it is still a target.
 */
export function parseSecurityArgs(args, { bin = 'terraform' } = {}) {
  const [command, ...rest] = args;
  const opts = { command, target: '.', plan: false, source: null, bin, json: false, sarif: false, sarifFile: null, failOn: 'high' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--sarif') {
      opts.sarif = true;
      if (/\.sarif$/i.test(rest[i + 1] ?? '')) opts.sarifFile = rest[++i];
    } else if (a === '--plan') opts.plan = true;
    else if (a === '--source') opts.source = rest[++i] ?? '';
    else if (a === '--tofu') opts.bin = 'tofu';
    else if (a === '--fail-on') {
      const v = parseFailOn(rest[++i]);
      if (!v) return { ...opts, error: '--fail-on is one of critical, high, medium, low, none' };
      opts.failOn = v;
    } else if (a.startsWith('-')) return { ...opts, error: `Unknown option ${a}` };
    else opts.target = a;
  }
  if (opts.json && opts.sarif && !opts.sarifFile) return { ...opts, error: '--json and --sarif both print: give --sarif a file (--sarif chart.sarif)' };
  if (opts.source === '') return { ...opts, error: '--source needs a folder' };
  return opts;
}

/**
 * `chart security`: security.js's checks without the screen. A plan or what-if file (JSON) is read and
 * what it would deploy judged; a folder's .tf, .tfvars, .bicep and .bicepparam files are read as they
 * are (nothing is run), and with --plan it is planned too (terraform, as chart check does). --source
 * adds a folder's files to a plan file's. Prints the findings (or --json, findings.js's securityJson,
 * or --sarif for code scanning) and exits 1 when one is as bad as --fail-on (high by default), 0
 * otherwise, 2 when it couldn't run. `config.securityIgnore` leaves out what it names.
 */
export async function runSecurity(args, { provider, config = {}, write = (s) => process.stdout.write(s), writeFile = (path, text) => writeFileSync(path, text) }) {
  const opts = parseSecurityArgs(args, { bin: config.terraform ?? 'terraform' });
  if (opts.error) {
    write(`chart security: ${opts.error}\n`);
    return 2;
  }
  const target = resolve(opts.target);
  try {
    let planned = [];
    let sourceDir = null;
    let resources = 0;
    if (isFile(target)) {
      const read = await provider.readFile(target);
      if (read.kind === 'state') throw new Error(`${opts.target} is a state, not a plan: terraform show -json plan.tfplan > plan.json makes one.`);
      planned = read.security ?? [];
      resources = read.changes.filter((c) => c.action !== 'delete').length;
      if (opts.source) sourceDir = resolve(opts.source);
    } else {
      sourceDir = target;
      if (opts.plan) {
        const p = await provider.plan(target, { bin: opts.bin });
        planned = p.security ?? [];
        resources = p.changes.filter((c) => c.action !== 'delete').length;
      }
    }
    const files = sourceDir ? await provider.sources(sourceDir) : [];
    const found = withoutIgnoredFindings(mergeFindings(planned, folderFindings(files)), config.securityIgnore ?? []);
    const failing = failingFindings(found, opts.failOn);
    if (opts.sarif) {
      // A plan's finding is about a resource, not a line: it points at the repository's root, its address in the message.
      const sarif = `${JSON.stringify(toSarif({ tool: 'Chart', version: VERSION, findings: found, isFile: (f) => Boolean(f.line) }), null, 2)}\n`;
      if (!opts.sarifFile) {
        write(sarif);
        return failing.length ? 1 : 0;
      }
      writeFile(resolve(opts.sarifFile), sarif);
    }
    const what = [resources ? `${resources} resource${resources === 1 ? '' : 's'} the plan deploys` : '', sourceDir ? `${files.length} source file${files.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    if (opts.json) write(`${JSON.stringify(securityJson({ app: 'chart', check: 'iac', target, findings: found, extra: { resources, files: files.length } }), null, 2)}\n`);
    else write(findingsText(found, { failOn: opts.failOn, header: `Read ${what || 'nothing'}${opts.sarifFile ? `; SARIF in ${resolve(opts.sarifFile)}` : ''}` }));
    return failing.length ? 1 : 0;
  } catch (e) {
    write(`chart security: ${String(e.message).split('\n')[0]}\n`);
    return 2;
  }
}
