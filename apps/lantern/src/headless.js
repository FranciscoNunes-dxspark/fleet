// lantern audit, lantern security and lantern domains: the same checks as the app, without the screen,
// for a pipeline. Exit codes: 0 fine, 1 something failed --fail-on, 2 couldn't run. `security` prints the
// JSON every app's security check prints (the kit's findings.js), which Fleet's security overview reads.
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentEnvironment } from '@fleet/kit/environments.js';
import { countFindings, failingFindings, findingPlace, findingsLine, findingsText, parseFailOn as parseLevel, securityJson } from '@fleet/kit/findings.js';
import { domainLines } from '@fleet/kit/webchecks.js';
import { CATEGORY_SHORT, vitalsLine } from './audit.js';
import { failures, parseFailOn } from './failon.js';
import { normalUrl } from './pages.js';
import { CHECKS_AT_ONCE, pool } from './provider.js';
import { sarifOf, withoutIgnored } from './security.js';

export const HEADLESS = ['audit', 'security', 'domains'];

const LABEL = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW', unknown: '?' };
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** { command, targets, dir, failOn, json, sarif, runs, env, all, links } from the arguments after `lantern`; `error` when they don't add up. */
export function parseArgs(args) {
  const [command, ...rest] = args;
  const opts = { command, targets: [], dir: '.', failOn: 'high', json: false, sarif: null, runs: null, env: null, all: false, links: true };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--fail-on') opts.failOn = String(rest[++i] ?? '');
    else if (a.startsWith('--fail-on=')) opts.failOn = a.slice('--fail-on='.length);
    else if (a === '--runs') opts.runs = Number(rest[++i]);
    else if (a === '--env') opts.env = rest[++i] ?? null;
    else if (a === '--all') opts.all = true;
    else if (a === '--no-links') opts.links = false;
    else if (a.startsWith('--sarif=')) opts.sarif = a.slice('--sarif='.length) || '-';
    else if (a === '--sarif') opts.sarif = rest[i + 1] && !rest[i + 1].startsWith('-') ? rest[++i] : rest[i + 1] === '-' ? rest[++i] : '-';
    else if (a.startsWith('-')) return { ...opts, error: `Unknown option ${a}` };
    else if (isDir(a)) opts.dir = a;
    else opts.targets.push(a);
  }
  if (opts.runs !== null && !(Number.isInteger(opts.runs) && opts.runs >= 1 && opts.runs <= 9)) return { ...opts, error: '--runs takes 1 to 9' };
  if (command === 'audit') {
    const f = parseFailOn(opts.failOn);
    if (f.error) return { ...opts, error: `--fail-on ${f.error}` };
    opts.terms = f.terms;
  } else if (!parseLevel(opts.failOn)) return { ...opts, error: '--fail-on is one of critical, high, medium, low, none' };
  if (opts.sarif === '-' && opts.json) return { ...opts, error: '--json and --sarif both want the output: give --sarif a file (--sarif lantern.sarif)' };
  if (command !== 'domains') {
    const bad = opts.targets.find((t) => !normalUrl(t));
    if (bad) return { ...opts, error: `${bad} is neither a URL nor a folder` };
  }
  return opts;
}

/** The pages to look at: the URLs given, else the folder's (the chosen environment's when the pages name environments, unless --all or --env). */
function pagesOf(opts, provider) {
  if (opts.targets.length) return { pages: opts.targets.map((t) => ({ url: normalUrl(t), name: normalUrl(t) })), domains: opts.targets.map((t) => new URL(normalUrl(t)).hostname) };
  const dir = resolve(opts.dir);
  const r = provider.pages(dir);
  const envs = new Set(r.pages.map((p) => p.env).filter(Boolean));
  const want = opts.all ? null : opts.env ?? (envs.size ? currentEnvironment(dir)?.name : null);
  const pages = want && envs.has(want) ? r.pages.filter((p) => !p.env || p.env === want) : r.pages;
  return { pages, domains: r.domains, errors: r.errors };
}

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

/** Runs one of HEADLESS; resolves the exit code. */
export async function runHeadless(args, { provider, config = {}, write = (s) => process.stdout.write(s), version = '0.0.0' }) {
  const opts = parseArgs(args);
  if (opts.error) {
    write(`lantern ${opts.command}: ${opts.error}\n`);
    return 2;
  }
  const io = { provider, config, write, version };
  try {
    if (opts.command === 'domains') return await runDomains(opts, io);
    const { pages, errors = [] } = pagesOf(opts, provider);
    for (const e of errors) write(`${e}\n`);
    if (!pages.length) {
      write(`No pages: give URLs (lantern ${opts.command} https://shop.example/), or name them in lantern.json or .fleet/project.json's environments ("lantern": { "url": … }).\n`);
      return 2;
    }
    if (opts.command === 'security') return await runSecurity(opts, pages, io);
    return await runAudit(opts, pages, io);
  } catch (e) {
    write(`lantern ${opts.command}: ${String(e.message).split('\n')[0]}\n`);
    return 2;
  }
}

async function runAudit(opts, pages, { provider, config, write, version }) {
  const results = [];
  for (const p of pages) {
    const r = await provider.audit(p.url, { runs: opts.runs ?? config.runs ?? 3, override: config.chrome, name: p.name, env: p.env, links: opts.links && config.checkLinks !== false });
    const findings = withoutIgnored(r.findings, config.ignore ?? []);
    results.push({ ...r, findings, counts: countFindings(findings), failing: failures({ ...r, findings }, opts.terms) });
  }
  const failing = results.flatMap((r) => r.failing.map((f) => `${r.url}: ${f}`));
  const text = () => {
    const lines = [];
    for (const r of results) {
      lines.push(`${r.env ? `${r.env}  ` : ''}${r.url}`);
      lines.push(`  ${r.lab ? `${vitalsLine(r.vitals)}  (lab, median of ${r.runs} run${r.runs === 1 ? '' : 's'})` : r.note ?? r.error ?? 'no lab numbers'}`);
      if (r.error && r.lab) lines.push(`  ${r.error}`);
      for (const f of r.findings) lines.push(`  ${LABEL[f.severity].padEnd(5)}${CATEGORY_SHORT[f.category]} ${f.title}${f.selector ? `  ${f.selector}` : ''}${f.host ? `  ${f.host}` : ''}`);
      lines.push(`  ${findingsLine(r.counts) || 'nothing found'}`, '');
    }
    if (failing.length) lines.push(`Failing --fail-on ${opts.failOn}:`, ...failing.map((f) => `  ${f}`));
    return `${lines.join('\n')}\n`;
  };
  const json = () => ({
    pages: results.map((r) => ({ url: r.url, ...(r.env ? { env: r.env } : {}), lab: r.lab, runs: r.runs, chrome: r.chrome, vitals: r.vitals, samples: r.samples, weight: r.weight, counts: r.counts, ...(r.note ? { note: r.note } : {}), ...(r.error ? { error: r.error } : {}), findings: r.findings.map(({ excerpt, ...f }) => f), failing: r.failing })),
    failOn: opts.failOn,
    failing,
  });
  output(opts, { text, json, findings: results.flatMap((r) => r.findings) }, { provider, write, version });
  return failing.length ? 1 : 0;
}

async function runSecurity(opts, pages, { provider, config, write, version }) {
  const checked = await pool(pages.map((p) => () => provider.security(p.url)), CHECKS_AT_ONCE);
  const all = checked.flatMap((s, i) => s.findings.map((f) => ({ ...f, category: 'security', page: pages[i].url })));
  const findings = withoutIgnored(all, config.ignore ?? []);
  const target = opts.targets.length ? pages.map((p) => p.url).join(' ') : resolve(opts.dir);
  output(opts, {
    text: () => findingsText(findings, { failOn: opts.failOn, header: `${pages.length} page${pages.length === 1 ? '' : 's'}: ${pages.map((p) => p.url).join(', ')}` }),
    json: () => securityJson({ app: 'lantern', check: 'security', target, findings, extra: { pages: pages.map((p) => p.url) } }),
    findings,
  }, { provider, write, version });
  return failingFindings(findings, opts.failOn).length ? 1 : 0;
}

async function runDomains(opts, { provider, config, write, version }) {
  let hosts = opts.targets.map((t) => t.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, ''));
  if (!hosts.length) hosts = provider.pages(resolve(opts.dir)).domains;
  if (!hosts.length) {
    write('No hosts: lantern domains shop.example, or name pages in lantern.json or .fleet/project.json.\n');
    return 2;
  }
  const checked = await pool(hosts.map((h) => () => provider.domain(h)), CHECKS_AT_ONCE);
  const findings = withoutIgnored(checked.flatMap((d) => d.findings), config.ignore ?? []);
  const text = () => {
    const lines = [];
    for (const d of checked) {
      lines.push(d.host, ...domainLines(d).map((l) => (l ? `  ${l}` : '')));
      const own = findings.filter((f) => f.where === d.host);
      for (const f of own) lines.push(`  ${LABEL[f.severity].padEnd(5)}${f.title}`, `       ${f.fix}`);
      lines.push(`  ${findingsLine(countFindings(own)) || 'nothing found'}`, '');
    }
    const failing = failingFindings(findings, opts.failOn);
    if (failing.length) lines.push(`${failing.length} at ${opts.failOn} or worse: ${failing.map(findingPlace).join(', ')}`);
    return `${lines.join('\n')}\n`;
  };
  const summary = (d) => ({ host: d.host, a: d.dns.a, aaaa: d.dns.aaaa, cname: d.dns.cname, caa: d.dns.caa, mx: d.dns.mx, https: d.enforced, days: d.days, certificate: d.cert && !d.cert.error ? { issuer: d.cert.issuer, validTo: d.cert.validTo } : null, http: d.http, bare: d.bare ? { host: d.bare, chain: d.bareChain } : null });
  output(opts, {
    text,
    json: () => securityJson({ app: 'lantern', check: 'domains', target: hosts.join(' '), findings, extra: { domains: checked.map(summary) } }),
    findings,
  }, { provider, write, version });
  return failingFindings(findings, opts.failOn).length ? 1 : 0;
}

