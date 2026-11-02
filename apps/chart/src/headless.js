// chart check: a plan (a folder's, run now, or a saved one) without the screen, for a pipeline. It
// prints what the plan does and its exit code says whether it does what --fail-on names: 0 fine, 1
// it does, 2 couldn't run.
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { diffLines } from './diff.js';
import { summarize, summaryLine } from './plan.js';
import { ACTION_MARK, changeRows } from './rows.js';
import { markdownReport } from './share.js';
import { CURRENCIES, costWords, planCosts, totalWords } from './costs.js';

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
      write(`${JSON.stringify({ target, tool: plan.tool, summary: summarize(plan.changes), fails: failing, changes: changeRows(plan.changes), drift: plan.drift, outputs: plan.outputs, cost }, null, 2)}\n`);
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
      if (totalWords(costs)) write(`\nCost: ${totalWords(costs)}, from Azure's retail prices in ${opts.currency}\n`);
      if (failing) write(`\nFailing: the plan does what --fail-on ${opts.failOn} names.\n`);
    }
    return failing ? 1 : 0;
  } catch (e) {
    write(`chart ${opts.command}: ${String(e.message).split('\n')[0]}\n`);
    return 2;
  }
}
