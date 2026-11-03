// lookout security, lookout ca and lookout env: without the screen. `security` reports what the
// captured traffic says (security.js): from a HAR file when one is given, else from the last session
// the app kept (only its findings are kept, never the traffic), in the kit's findings shape that
// Fleet's security overview reads; its exit code says whether a finding is as bad as --fail-on (high
// unless given): 0 fine, 1 found, 2 couldn't run. `ca` makes the certificate authority when there's
// none and says how to trust it; `env` prints what sends traffic through the proxy.
import { resolve } from 'node:path';
import { failingFindings, findingsText, parseFailOn, securityJson } from '@fleet/kit/findings.js';
import { fromHar } from './har.js';
import { hosts } from './exchange.js';
import { sarifOf, trafficFindings } from './security.js';
import { demoExchanges } from './demo.js';
import { proxyLines, trustSteps } from './setup.js';
import { DEFAULT_PORT } from './proxy.js';

export const HEADLESS = ['security', 'ca', 'env'];

/** { command, file, failOn, json, sarif, port, pem } from the arguments after `lookout`; an `error` when they don't add up. */
export function parseArgs(args) {
  const [command, ...rest] = args;
  const opts = { command, file: null, failOn: 'high', json: false, sarif: null, port: null, pem: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--pem') opts.pem = true;
    else if (a === '--fail-on') opts.failOn = parseFailOn(rest[++i]) ?? `!${rest[i] ?? ''}`;
    else if (a === '--port') opts.port = Number(rest[++i]);
    else if (a.startsWith('--sarif=')) opts.sarif = a.slice('--sarif='.length) || '-';
    else if (a === '--sarif') opts.sarif = rest[i + 1] && !rest[i + 1].startsWith('-') ? rest[++i] : rest[i + 1] === '-' ? rest[++i] : '-';
    else if (a.startsWith('-')) return { ...opts, error: `Unknown option ${a}` };
    else opts.file = a;
  }
  if (String(opts.failOn).startsWith('!')) return { ...opts, error: '--fail-on is one of critical, high, medium, low, none' };
  if (opts.port != null && !(Number.isInteger(opts.port) && opts.port > 0 && opts.port < 65536)) return { ...opts, error: '--port is a number from 1 to 65535' };
  if (opts.sarif && command !== 'security') return { ...opts, error: '--sarif is for lookout security' };
  if (opts.sarif === '-' && opts.json) return { ...opts, error: '--json and --sarif both want the output: give --sarif a file (--sarif lookout.sarif)' };
  return opts;
}

/** Runs one of HEADLESS; resolves the exit code. `write` prints; `provider` is provider.js's (demo.js's with --demo). */
export async function runHeadless(args, { provider, config = {}, write = (s) => process.stdout.write(s), version = '0.0.0', demo = false }) {
  const opts = parseArgs(args);
  if (opts.error) {
    write(`lookout ${opts.command}: ${opts.error}\n`);
    return 2;
  }
  try {
    if (opts.command === 'env') {
      const ca = provider.caInfo();
      write(`${proxyLines(opts.port ?? config.port ?? DEFAULT_PORT, { caCert: config.intercept && ca.exists ? ca.paths.cert : null }).join('\n')}\n`);
      return 0;
    }
    if (opts.command === 'ca') {
      const r = provider.ensureCA();
      if (opts.pem) {
        write(provider.caInfo().cert);
        return 0;
      }
      write(`${r.made ? 'Made' : 'Kept'} ${r.paths.cert}\nSHA-256 ${r.fingerprint}\n\n${trustSteps(r.paths.cert).join('\n')}\n`);
      return 0;
    }
    return await runSecurity(opts, { provider, write, version, demo });
  } catch (e) {
    write(`lookout ${opts.command}: ${String(e.message).split('\n')[0]}\n`);
    return 2;
  }
}

/** lookout security [file.har]: the findings of a HAR file, the demo's, or the last session's. */
async function runSecurity(opts, { provider, write, version, demo }) {
  let findings;
  let target;
  let header;
  if (opts.file) {
    target = resolve(opts.file);
    const list = fromHar(provider.readFile(target));
    findings = trafficFindings(list);
    header = `${list.length} request${list.length === 1 ? '' : 's'} to ${hosts(list).length} host${hosts(list).length === 1 ? '' : 's'} in ${target}`;
  } else if (demo) {
    const list = demoExchanges();
    findings = trafficFindings(list);
    target = 'demo session';
    header = `${list.length} exchanges in the demo session`;
  } else {
    const kept = provider.loadFindings();
    findings = kept?.findings ?? [];
    target = kept?.target ?? 'last session';
    header = kept ? `The last session's traffic (${kept.requests ?? '?'} requests, kept ${kept.at})` : 'No session kept yet: run lookout and send something through it, or give a HAR file (lookout security capture.har).';
  }
  const sarif = () => `${JSON.stringify(sarifOf(findings, version), null, 2)}\n`;
  if (opts.sarif === '-') write(sarif());
  else {
    write(opts.json ? `${JSON.stringify(securityJson({ app: 'lookout', check: 'traffic', target, findings }), null, 2)}\n` : findingsText(findings, { failOn: opts.failOn, header }));
    if (opts.sarif) {
      const path = resolve(opts.sarif);
      provider.writeFile(path, sarif());
      if (!opts.json) write(`SARIF in ${path}\n`);
    }
  }
  return failingFindings(findings, opts.failOn).length ? 1 : 0;
}
