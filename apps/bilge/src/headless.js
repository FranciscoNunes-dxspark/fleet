// bilge audit and bilge sbom: the same reading and asking as the app, without the screen, for a
// pipeline. `audit` prints the findings (or --json) and its exit code says whether one is as bad as
// --fail-on (high unless given): 0 fine, 1 found, 2 couldn't run.
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SEVERITIES, countLine, counts, findings, rank } from './audit.js';
import { SEVERITY_LABEL, label, withoutIgnored } from './rows.js';
import { cyclonedx } from './sbom.js';

/** { command, dir, failOn, json, out } from the arguments after `bilge`; an `error` when they don't add up. */
export function parseArgs(args) {
  const [command, ...rest] = args;
  const opts = { command, dir: '.', failOn: 'high', json: false, out: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--fail-on') opts.failOn = String(rest[++i] ?? '').toLowerCase();
    else if (a === '-o' || a === '--output') opts.out = rest[++i] ?? null;
    else if (a.startsWith('-')) return { ...opts, error: `Unknown option ${a}` };
    else opts.dir = a;
  }
  if (opts.failOn !== 'none' && !SEVERITIES.includes(opts.failOn)) return { ...opts, error: `--fail-on is one of ${[...SEVERITIES.filter((s) => s !== 'unknown'), 'none'].join(', ')}` };
  return opts;
}

/** Runs `bilge audit` or `bilge sbom`; resolves the exit code. `write` prints, `provider` is provider.js's (demo.js's in tests). */
export async function runHeadless(args, { provider, config = {}, write = (s) => process.stdout.write(s), version = '0.0.0' }) {
  const opts = parseArgs(args);
  if (opts.error) {
    write(`bilge ${opts.command}: ${opts.error}\n`);
    return 2;
  }
  const dir = resolve(opts.dir);
  try {
    const scan = await provider.scan(dir);
    if (!scan.manifests.length) {
      write(`No package-lock.json, packages.lock.json or .NET project in ${dir}.\n`);
      return opts.command === 'audit' ? 0 : 2;
    }
    const { ids, details } = await provider.audit(scan.packages);
    const found = withoutIgnored(findings(scan.packages, ids, details), config.ignore ?? []);
    if (opts.command === 'sbom') {
      const bom = `${JSON.stringify(cyclonedx({ name: basename(dir), packages: scan.packages, found, tool: { name: 'Bilge', version }, serial: randomUUID() }), null, 2)}\n`;
      if (opts.out) {
        provider.writeFile(resolve(opts.out), bom);
        write(`${scan.packages.length} components in ${resolve(opts.out)}\n`);
      } else write(bom);
      return 0;
    }
    const failing = opts.failOn === 'none' ? [] : found.filter((f) => rank(f.severity) <= rank(opts.failOn) && f.severity !== 'unknown');
    if (opts.json) {
      write(`${JSON.stringify({ dir, packages: scan.packages.length, manifests: scan.manifests.map((m) => m.path), counts: counts(found), findings: found.map((f) => ({ package: f.pkg.name, version: f.pkg.version, ecosystem: f.pkg.ecosystem, direct: f.pkg.direct, dev: f.pkg.dev, severity: f.severity, fixed: f.fixed, where: f.pkg.where, advisories: f.advisories })) }, null, 2)}\n`);
    } else {
      write(`${scan.packages.length} packages in ${scan.manifests.length} manifest${scan.manifests.length === 1 ? '' : 's'} under ${dir}\n`);
      if (!found.length) write('Nothing known against them.\n');
      for (const f of found) {
        write(`\n${SEVERITY_LABEL[f.severity].padEnd(5)}${label(f.pkg)}${f.pkg.direct ? '' : ' (transitive)'}${f.pkg.dev ? ' (dev)' : ''}  ${f.fixed ? `fixed in ${f.fixed}` : 'no fix yet'}\n`);
        for (const a of f.advisories) write(`     ${a.id}${a.aliases.length ? ` (${a.aliases.join(', ')})` : ''} ${a.summary}\n`);
        write(`     in ${f.pkg.where.map((w) => `${w.path}${w.line ? `:${w.line}` : ''}`).join(', ')}\n`);
      }
      if (found.length) write(`\n${countLine(counts(found))}${failing.length ? ` · failing on ${opts.failOn} and above` : ''}\n`);
    }
    return failing.length ? 1 : 0;
  } catch (e) {
    write(`bilge ${opts.command}: ${String(e.message).split('\n')[0]}\n`);
    return 2;
  }
}
