// bilge audit, bilge code, bilge supply, bilge security, bilge sbom and bilge report: the same reading
// and asking as the app, without the screen, for a pipeline. `audit` prints the findings (or --json, or
// --sarif for code scanning) and its exit code says whether one is as bad as --fail-on (high unless
// given): 0 fine, 1 found, 2 couldn't run. `security` is the three checks together, in the JSON every
// app's security check prints (the kit's findings.js), which Fleet's security overview reads.
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SEVERITIES, countLine, counts, findings, rank } from './audit.js';
import { SEVERITY_LABEL, label, withoutIgnored } from './rows.js';
import { cyclonedx } from './sbom.js';
import { markdownReport } from './share.js';
import { allSupply, withoutIgnoredSupply } from './supply.js';
import { auditFindings, codeFindings, sarifOf } from './security.js';
import { findingWhere, withoutIgnoredCode } from '@fleet/kit/codescan.js';
import { failingFindings, findingsText, securityJson } from '@fleet/kit/findings.js';

export const HEADLESS = ['audit', 'code', 'supply', 'security', 'sbom', 'report'];

/**
 * { command, dir, failOn, json, out, sarif } from the arguments after `bilge`; an `error` when they
 * don't add up. `sarif` is null, '-' for the output, or a file: --sarif=<file>, or --sarif followed by
 * anything that isn't an option (so a folder goes before it).
 */
export function parseArgs(args) {
  const [command, ...rest] = args;
  const opts = { command, dir: '.', failOn: 'high', json: false, out: null, sarif: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--fail-on') opts.failOn = String(rest[++i] ?? '').toLowerCase();
    else if (a === '-o' || a === '--output') opts.out = rest[++i] ?? null;
    else if (a.startsWith('--sarif=')) opts.sarif = a.slice('--sarif='.length) || '-';
    else if (a === '--sarif') opts.sarif = rest[i + 1] && !rest[i + 1].startsWith('-') ? rest[++i] : rest[i + 1] === '-' ? rest[++i] : '-';
    else if (a.startsWith('-')) return { ...opts, error: `Unknown option ${a}` };
    else opts.dir = a;
  }
  if (opts.failOn !== 'none' && !SEVERITIES.includes(opts.failOn)) return { ...opts, error: `--fail-on is one of ${[...SEVERITIES.filter((s) => s !== 'unknown'), 'none'].join(', ')}` };
  if (opts.sarif && !['audit', 'code', 'supply', 'security'].includes(command)) return { ...opts, error: '--sarif is for audit, code, supply and security' };
  if (opts.sarif === '-' && opts.json) return { ...opts, error: '--json and --sarif both want the output: give --sarif a file (--sarif bilge.sarif)' };
  return opts;
}

/**
 * Prints a command's result: SARIF alone when it goes to the output, else the text (or --json), and
 * the SARIF written to its file beside it. `findings` are in the kit's shape.
 */
function output(opts, { text, json, findings }, { provider, write, version }) {
  const sarif = () => `${JSON.stringify(sarifOf(findings, version), null, 2)}\n`;
  if (opts.sarif === '-') return write(sarif());
  write(opts.json ? `${JSON.stringify(json(), null, 2)}\n` : text());
  if (opts.sarif) {
    const path = resolve(opts.sarif);
    provider.writeFile(path, sarif());
    if (!opts.json) write(`SARIF in ${path}\n`);
  }
}

/** Runs one of HEADLESS; resolves the exit code. `write` prints, `provider` is provider.js's (demo.js's in tests). */
export async function runHeadless(args, { provider, config = {}, write = (s) => process.stdout.write(s), version = '0.0.0' }) {
  const opts = parseArgs(args);
  if (opts.error) {
    write(`bilge ${opts.command}: ${opts.error}\n`);
    return 2;
  }
  const dir = resolve(opts.dir);
  const io = { provider, config, write, version };
  try {
    if (opts.command === 'code') return await runCode(opts, dir, io);
    if (opts.command === 'supply' || opts.command === 'security') return await runSecurity(opts, dir, io);
    const scan = await provider.scan(dir);
    const none = `No lock file (package-lock.json, yarn.lock, pnpm-lock.yaml, packages.lock.json) or .NET project in ${dir}.\n`;
    if (!scan.manifests.length) {
      if (opts.command !== 'audit') return write(none) ?? 2;
      // Still an answer for a pipeline that uploads it: an empty SARIF, or the JSON with nothing in it.
      output(opts, { text: () => none, json: () => ({ dir, packages: 0, manifests: [], counts: counts([]), findings: [] }), findings: [] }, io);
      return 0;
    }
    // A pipeline's verdict is today's: OSV is asked about every package, not answered from the cache.
    const { ids, details } = await provider.audit(scan.packages, { fresh: true });
    const found = withoutIgnored(findings(scan.packages, ids, details), config.ignore ?? []);
    if (opts.command === 'sbom') {
      const bom = `${JSON.stringify(cyclonedx({ name: basename(dir), packages: scan.packages, found, tool: { name: 'Bilge', version }, serial: randomUUID() }), null, 2)}\n`;
      if (opts.out) {
        provider.writeFile(resolve(opts.out), bom);
        write(`${scan.packages.length} components in ${resolve(opts.out)}\n`);
      } else write(bom);
      return 0;
    }
    if (opts.command === 'report') {
      const md = markdownReport({ name: basename(dir), manifests: scan.manifests, packages: scan.packages, found });
      if (opts.out) {
        provider.writeFile(resolve(opts.out), md);
        write(`Report in ${resolve(opts.out)}\n`);
      } else write(md);
      return 0;
    }
    const failing = opts.failOn === 'none' ? [] : found.filter((f) => rank(f.severity) <= rank(opts.failOn) && f.severity !== 'unknown');
    const text = () => {
      const lines = [`${scan.packages.length} packages in ${scan.manifests.length} manifest${scan.manifests.length === 1 ? '' : 's'} under ${dir}\n`];
      if (!found.length) lines.push('Nothing known against them.\n');
      for (const f of found) {
        lines.push(`\n${SEVERITY_LABEL[f.severity].padEnd(5)}${label(f.pkg)}${f.pkg.direct ? '' : ' (transitive)'}${f.pkg.dev ? ' (dev)' : ''}  ${f.fixed ? `fixed in ${f.fixed}` : 'no fix yet'}\n`);
        for (const a of f.advisories) lines.push(`     ${a.id}${a.aliases.length ? ` (${a.aliases.join(', ')})` : ''} ${a.summary}\n`);
        lines.push(`     in ${f.pkg.where.map((w) => `${w.path}${w.line ? `:${w.line}` : ''}`).join(', ')}\n`);
      }
      if (found.length) lines.push(`\n${countLine(counts(found))}${failing.length ? ` · failing on ${opts.failOn} and above` : ''}\n`);
      return lines.join('');
    };
    const json = () => ({ dir, packages: scan.packages.length, manifests: scan.manifests.map((m) => m.path), counts: counts(found), findings: found.map((f) => ({ package: f.pkg.name, version: f.pkg.version, ecosystem: f.pkg.ecosystem, direct: f.pkg.direct, dev: f.pkg.dev, severity: f.severity, fixed: f.fixed, where: f.pkg.where, advisories: f.advisories })) });
    output(opts, { text, json, findings: auditFindings(found) }, io);
    return failing.length ? 1 : 0;
  } catch (e) {
    write(`bilge ${opts.command}: ${String(e.message).split('\n')[0]}\n`);
    return 2;
  }
}

/**
 * bilge code: the folder's own files through codescan.js, as the Code view reads them, without the
 * codeIgnore entries. Exits as audit does: 1 when a finding is as bad as --fail-on.
 */
async function runCode(opts, dir, io) {
  const result = await io.provider.code(dir);
  const found = withoutIgnoredCode(result.findings, io.config.codeIgnore ?? []);
  const failing = opts.failOn === 'none' ? [] : found.filter((f) => rank(f.severity) <= rank(opts.failOn));
  const text = () => {
    const lines = [`${result.files} files read under ${dir}${result.truncated ? ' (stopped early)' : ''}\n`];
    if (!found.length) lines.push('Nothing found.\n');
    for (const f of found) lines.push(`${SEVERITY_LABEL[f.severity].padEnd(5)}${f.title}  ${findingWhere(f)}${f.test ? ' (test)' : ''}\n     ${f.fix}\n`);
    if (found.length) lines.push(`\n${countLine(counts(found))}${failing.length ? ` · failing on ${opts.failOn} and above` : ''}\n`);
    return lines.join('');
  };
  // The excerpt is redacted already; it stays out of the JSON all the same, which ends up in build logs.
  const json = () => ({ dir, files: result.files, truncated: result.truncated, counts: counts(found), findings: found.map(({ excerpt, why, key, ...f }) => f) });
  output(opts, { text, json, findings: codeFindings(found) }, io);
  return failing.length ? 1 : 0;
}

/**
 * bilge supply: the lock files' supply-chain findings (supply.js), without supplyIgnore's. bilge
 * security: those, the audit's advisories (OSV asked afresh, /ignore's left out) and the code's,
 * together. Both print the kit's findings text, or its securityJson with --json.
 */
async function runSecurity(opts, dir, io) {
  const { provider, config } = io;
  const scan = await provider.scan(dir);
  const all = withoutIgnoredSupply(allSupply(scan.manifests), config.supplyIgnore ?? []);
  const said = [`${scan.packages.length} packages in ${scan.manifests.length} manifest${scan.manifests.length === 1 ? '' : 's'}`];
  if (opts.command === 'security') {
    if (scan.packages.length) {
      const { ids, details } = await provider.audit(scan.packages, { fresh: true });
      all.push(...auditFindings(withoutIgnored(findings(scan.packages, ids, details), config.ignore ?? [])));
    }
    const code = await provider.code(dir);
    all.push(...codeFindings(withoutIgnoredCode(code.findings, config.codeIgnore ?? [])));
    said.push(`${code.files} files read${code.truncated ? ' (stopped early)' : ''}`);
  }
  output(opts, {
    text: () => findingsText(all, { failOn: opts.failOn, header: `${said.join(', ')} under ${dir}` }),
    json: () => securityJson({ app: 'bilge', check: opts.command, target: dir, findings: all }),
    findings: all,
  }, io);
  return failingFindings(all, opts.failOn).length ? 1 : 0;
}
