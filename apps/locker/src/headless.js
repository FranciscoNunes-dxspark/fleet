// locker security: the hygiene check without the screen, for a pipeline. It reads what /hygiene reads
// (the folder, the App Service app named as it or with --app and its slots, their vaults; --all for
// every app and vault in the subscription) and prints the findings, as JSON with --json (the kit's
// securityJson, which Fleet adds up) or SARIF with --sarif. The exit code says whether one is as bad
// as --fail-on (high unless given): 0 fine, 1 found, 2 couldn't run. No value is ever printed: a
// finding names the secret, the setting or the file and line, and the JSON leaves out even the
// redacted excerpt.
import { resolve } from 'node:path';
import { failingFindings, findingsText, parseFailOn, securityJson, toSarif, withoutIgnoredFindings } from '@fleet/kit/findings.js';
import { label } from './azure/arm.js';
import { azProblem } from './azure/az.js';
import { loadSubscription, pickTarget } from './load.js';
import { hygieneFindings } from './hygiene.js';
import { readHygiene } from './security.js';

const firstLine = (s) => String(s ?? '').split('\n')[0];

/** { dir, json, sarif, failOn, app, vault, all } from the arguments after `locker security`; an `error` when they don't add up. */
export function parseSecurityArgs(args) {
  const opts = { dir: '.', json: false, sarif: false, failOn: 'high', app: null, vault: null, all: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--sarif') opts.sarif = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--demo') continue;
    else if (a === '--fail-on') {
      const v = parseFailOn(args[++i]);
      if (!v) return { ...opts, error: '--fail-on is one of critical, high, medium, low, none' };
      opts.failOn = v;
    } else if (a === '--app') opts.app = args[++i] ?? null;
    else if (a === '--vault') opts.vault = args[++i] ?? null;
    else if (a.startsWith('-')) return { ...opts, error: `Unknown option ${a}` };
    else opts.dir = a;
  }
  if (opts.json && opts.sarif) return { ...opts, error: '--json or --sarif, not both' };
  return opts;
}

/**
 * Runs `locker security`; resolves the exit code. `provider` is arm.js's (demo.js's in tests),
 * `makeLocal(dir)` local.js's createLocal (or `local`, the demo's folder), `write` prints.
 */
export async function runSecurity(args, { provider, local, makeLocal, config = {}, write = (s) => process.stdout.write(s), version = '0.0.0', now = Date.now() }) {
  const opts = parseSecurityArgs(args);
  if (opts.error) {
    write(`locker security: ${opts.error}\n`);
    return 2;
  }
  try {
    const folder = local ?? makeLocal(resolve(opts.dir));
    const problems = [];
    let azure = null;
    try {
      azure = await loadSubscription(provider, { saved: config.subscription });
    } catch (e) {
      problems.push(`Azure wasn't read: ${azProblem(e.message) ?? firstLine(e.message)}`);
    }
    let target = null;
    let vault = null;
    if (azure) {
      if (opts.app) {
        target = azure.sites.find((s) => label(s).toLowerCase() === opts.app.toLowerCase()) ?? null;
        if (!target) {
          write(`locker security: no app ${opts.app} in ${azure.subscription.name}\n`);
          return 2;
        }
      } else target = pickTarget(azure.sites, { saved: config.target, dir: folder.dir });
      if (opts.vault) {
        vault = azure.vaults.find((v) => v.name.toLowerCase() === opts.vault.toLowerCase()) ?? null;
        if (!vault) {
          write(`locker security: no key vault ${opts.vault} in ${azure.subscription.name}\n`);
          return 2;
        }
      } else vault = azure.vaults.find((v) => v.name === config.vault) ?? (azure.vaults.length === 1 ? azure.vaults[0] : null);
    }
    const read = await readHygiene({ provider, local: folder, azure, target, vault, all: opts.all });
    problems.push(...read.problems);
    const found = withoutIgnoredFindings(hygieneFindings(read, { now }), config.hygieneIgnore ?? []);
    if (opts.json) {
      const extra = { site: target ? label(target) : null, sites: read.scope.sites, vaults: read.scope.vaults, problems };
      write(`${JSON.stringify(securityJson({ app: 'locker', check: 'hygiene', target: read.dir, findings: found, extra, now: new Date(now) }), null, 2)}\n`);
    } else if (opts.sarif) {
      // Only a file's finding points at the file: the rest (a vault secret, an app's setting) at the root.
      write(`${JSON.stringify(toSarif({ tool: 'Locker', version, findings: found.map(({ excerpt, ...f }) => f), isFile: (f) => f.scope === 'file' }), null, 2)}\n`);
    } else {
      const header = `Secret hygiene in ${[read.dir, ...read.scope.sites, ...read.scope.vaults].join(', ')}`;
      write(findingsText(found, { failOn: opts.failOn, header }));
      for (const p of problems) write(`Not read: ${p}\n`);
    }
    return failingFindings(found, opts.failOn).length ? 1 : 0;
  } catch (e) {
    write(`locker security: ${firstLine(e.message)}\n`);
    return 2;
  }
}
