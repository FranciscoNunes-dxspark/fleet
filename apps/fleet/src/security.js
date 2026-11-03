// The family's security checks as one overview: `fleet security`, the host's panel (the prefix and S)
// and `fleet mcp`'s security_overview. Each app keeps its own check and runs it headless as
// `<app> security … --json` (the kit's findings.js shape: { app, check, target, counts, findings });
// this file only works out which to run for the project, runs them as child processes (as the host
// starts apps: spaces.js launchCommand), and adds their answers up. Nothing here judges anything.
//
// Which checks run: Bilge (dependencies, the code, the supply chain), Splice (secrets in the history)
// and Chart (infrastructure as code) always, on the project's folder; the rest when the project's
// .fleet/project.json names what they look at, in a "security" section (the chosen environment's own
// "security" section over it):
//   "security": { "hail": "https://shop.example.com", "sonar": { "subscription": "…" }, "mooring": ["web1"],
//                 "locker": true, "wharf": { "compose": "compose.yaml" }, "keel": "Commerce", "skip": ["chart"] }
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { currentEnvironment, findProjectFile } from '@fleet/kit/environments.js';
import { countFindings, failingFindings, findingPlace, findingsLine, sortFindings, toSarif } from '@fleet/kit/findings.js';
import { launchCommand } from './spaces.js';
import { fleetHome } from './state.js';

// The apps with a security check, in the order the overview lists them, and what each one looks at.
export const CHECKS = [
  { app: 'bilge', what: 'dependencies, the code and the supply chain' },
  { app: 'splice', what: 'secrets in the git history' },
  { app: 'chart', what: 'infrastructure as code' },
  { app: 'hail', what: 'the running web app' },
  { app: 'sonar', what: "the Azure subscription's setup" },
  { app: 'locker', what: 'secrets in Key Vault, app settings and files' },
  { app: 'mooring', what: 'a server, over SSH' },
  { app: 'wharf', what: 'containers as they run' },
  { app: 'keel', what: 'Azure DevOps pipelines, repos and connections' },
];
const ALWAYS = ['bilge', 'splice', 'chart'];
// Wharf and Keel aren't in the compiled build (package.json's "includes"): only a checkout runs them.
const NOT_IN_BUILD = new Set(['wharf', 'keel']);
const NO_DEMO = new Set(['splice', 'hail']);

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** The "security" section for the project `dir` is in, the chosen environment's own over the file's: {} when there's none. */
export function securityConfig(dir, { home } = {}) {
  const file = findProjectFile(dir);
  if (!file) return { root: resolve(dir), config: {} };
  const root = dirname(dirname(file));
  let top = {};
  try {
    top = asObject(JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')).security);
  } catch {}
  const env = currentEnvironment(dir, home ? { home } : undefined);
  return { root, config: { ...top, ...asObject(env?.settings?.security) }, env: env ? { name: env.name, prod: env.prod } : null };
}

/**
 * The checks to run for `root` with `config` (securityConfig's): [{ app, label, args }] where args
 * follow `<app>`, ending in --json --fail-on none (the overview decides what fails), and [{ app, why }]
 * for the ones left out. `only` keeps those apps; `demo` runs every app on its demo data.
 */
export function securityPlan(root, config = {}, { only = null, demo = false, compiled = false } = {}) {
  const run = [];
  const left = [];
  const skip = new Set([...(Array.isArray(config.skip) ? config.skip : [])].map(String));
  const tail = ['--json', '--fail-on', 'none'];
  // Splice and Hail have no demo: Splice reads the real history (read-only), Hail a named address.
  const add = (app, args, label = app) => run.push({ app, label, args: [...args, ...(demo && !NO_DEMO.has(app) ? ['--demo'] : []), ...tail] });
  const at = (p) => resolve(root, String(p));
  for (const { app } of CHECKS) {
    if (only && !only.includes(app)) continue;
    if (skip.has(app)) {
      left.push({ app, why: 'skipped in .fleet/project.json' });
      continue;
    }
    if (compiled && NOT_IN_BUILD.has(app)) {
      if (config[app] || demo) left.push({ app, why: "not in Fleet's build: run it from its own executable" });
      continue;
    }
    const c = config[app];
    if (ALWAYS.includes(app)) {
      add(app, ['security', root]);
      continue;
    }
    if (demo) {
      // Hail has no demo: it scans a real address, so it runs only when one is named.
      if (app === 'hail' && !c) left.push({ app, why: 'needs an address: "security": { "hail": "https://…" }' });
      else if (app === 'hail') add(app, hailArgs(c, at));
      else if (app === 'mooring') add(app, ['security', 'demo']);
      else if (app === 'locker') add(app, ['security', root]);
      else add(app, ['security']);
      continue;
    }
    if (!c) {
      left.push({ app, why: `not set up: "security": { "${app}": … } in .fleet/project.json` });
      continue;
    }
    if (app === 'hail') add(app, hailArgs(c, at));
    else if (app === 'sonar') {
      const o = asObject(c);
      add(app, ['security', ...(o.subscription ? ['--subscription', String(o.subscription)] : []), ...(o.resourceGroup ? ['-g', String(o.resourceGroup)] : [])]);
    } else if (app === 'mooring') {
      for (const host of [c].flat().filter((h) => typeof h === 'string' && h)) add(app, ['security', host], `mooring ${host}`);
    } else if (app === 'locker') {
      const o = asObject(c);
      add(app, ['security', root, ...(o.app ? ['--app', String(o.app)] : []), ...(o.vault ? ['--vault', String(o.vault)] : []), ...(o.all ? ['--all'] : [])]);
    } else if (app === 'wharf') {
      const o = asObject(c);
      add(app, ['security', ...[o.compose ?? []].flat().flatMap((f) => ['--compose', at(f)])]);
    } else if (app === 'keel') add(app, ['security', ...(typeof c === 'string' ? [c] : asObject(c).project ? [String(asObject(c).project)] : [])]);
  }
  return { run, left };
}

function hailArgs(c, at) {
  const o = typeof c === 'string' ? { target: c } : asObject(c);
  const target = String(o.target ?? o.url ?? o.file ?? '');
  // An address as it is; anything else is a .http file in the project.
  const t = /^https?:\/\//i.test(target) ? target : at(target);
  return ['security', t, ...(o.env ? ['--env', String(o.env)] : []), ...(o.production ? ['--production'] : [])];
}

/** The JSON a check printed: from its first line that starts with {, so a line said before it doesn't matter. */
export function parseCheckOutput(stdout) {
  const text = String(stdout ?? '');
  const at = text.search(/^\{/m);
  if (at < 0) return null;
  try {
    const j = JSON.parse(text.slice(at));
    return j && Array.isArray(j.findings) ? j : null;
  } catch {
    return null;
  }
}

/**
 * Runs the plan's checks, `concurrency` at a time, each as `<app> security …` (launchCommand: the
 * app's own entry point from a checkout, the build itself with --run when compiled). Resolves
 * [{ app, label, ok, result | error, ms }]. `onProgress(done, total, item)` after each; `signal` stops
 * them all. A check that runs longer than `timeout` is stopped and said so.
 */
export async function runChecks(plan, { cwd, compiled = false, spawn = nodeSpawn, concurrency = 3, timeout = 5 * 60_000, signal, onProgress, env = process.env, now = () => Date.now() } = {}) {
  const out = new Array(plan.length);
  let next = 0;
  let done = 0;
  // Not hosted: the apps run headless, as in a pipeline.
  const childEnv = { ...env };
  delete childEnv.FLEET_HOSTED;
  const one = (item) =>
    new Promise((settle) => {
      const started = now();
      const [file, args] = launchCommand(item.app, item.args, { compiled });
      let stdout = '';
      let stderr = '';
      let child;
      try {
        child = spawn(file, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) {
        return settle({ ...item, ok: false, error: `couldn't start: ${e.message}`, ms: 0 });
      }
      const stop = () => child.kill();
      const timer = setTimeout(() => {
        stderr += `\nstopped after ${Math.round(timeout / 1000)} s`;
        stop();
      }, timeout);
      signal?.addEventListener('abort', stop, { once: true });
      child.stdout?.on('data', (d) => (stdout += d));
      child.stderr?.on('data', (d) => (stderr += d));
      const finish = (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        const result = parseCheckOutput(stdout);
        const ms = now() - started;
        // Exit 2 is "couldn't run"; whatever it said is the reason (its JSON, when it printed one anyway, is kept).
        if (result && code !== 2) return settle({ ...item, ok: true, result, ms });
        const said = `${stdout}\n${stderr}`.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('{'));
        settle({ ...item, ok: false, error: signal?.aborted ? 'cancelled' : said.slice(-3).join(' · ') || `exited with ${code}`, ms });
      };
      child.on('error', (e) => {
        stderr += `\n${e.message}`;
      });
      child.on('close', finish);
    });
  const worker = async () => {
    while (next < plan.length && !signal?.aborted) {
      const i = next++;
      out[i] = await one(plan[i]);
      onProgress?.(++done, plan.length, out[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, plan.length) }, worker));
  return out.filter(Boolean);
}

/**
 * The checks' answers as one: { project, environment, at, checks: [{ app, label, check, target, ok,
 * error, counts }], left, counts, findings } with each finding marked with its `app` and `check`.
 */
export function overview(results, { project, environment = null, left = [], now = new Date() } = {}) {
  const findings = [];
  const checks = results.map((r) => {
    if (r.ok) for (const f of r.result.findings) findings.push({ ...f, app: r.app, check: r.result.check });
    return { app: r.app, label: r.label, check: r.result?.check ?? null, target: r.result?.target ?? null, ok: r.ok, error: r.error ?? null, counts: r.ok ? countFindings(r.result.findings) : null, ms: r.ms };
  });
  const sorted = sortFindings(findings);
  return { project, environment, at: now.toISOString(), checks, left, counts: countFindings(sorted), findings: sorted };
}

/** The overview as text: a line per check, then the findings worst first with their app. */
export function overviewText(o, { failOn = 'none', limit = Infinity } = {}) {
  const lines = [`Security of ${o.project}${o.environment ? ` (${o.environment.name}${o.environment.prod ? ', production' : ''})` : ''}`, ''];
  const w = Math.max(6, ...o.checks.map((c) => c.label.length));
  for (const c of o.checks) lines.push(`  ${c.label.padEnd(w)}  ${c.ok ? findingsLine(c.counts) || 'nothing found' : `couldn't run: ${c.error}`}`);
  for (const l of o.left) lines.push(`  ${l.app.padEnd(w)}  — ${l.why}`);
  lines.push('');
  const label = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW', unknown: '?' };
  for (const f of o.findings.slice(0, limit)) lines.push(`${(label[f.severity] ?? '?').padEnd(5)}${f.app.padEnd(8)}${f.title}  ${findingPlace(f)}`);
  if (o.findings.length > limit) lines.push(`… and ${o.findings.length - limit} more (--json has them all)`);
  const failing = failingFindings(o.findings, failOn);
  lines.push('', `${findingsLine(o.counts) || 'Nothing found'}${failing.length ? ` · failing on ${failOn} and above` : ''}`);
  return `${lines.join('\n')}\n`;
}

/** One SARIF file for code scanning: a run per app, as each app's own --sarif would write it. */
export function overviewSarif(o, { version = '0.0.0' } = {}) {
  const runs = [];
  for (const c of o.checks.filter((x) => x.ok)) {
    const mine = o.findings.filter((f) => f.app === c.app && f.check === c.check);
    if (!mine.length) continue;
    runs.push(...toSarif({ tool: `${c.app[0].toUpperCase()}${c.app.slice(1)}`, version, findings: mine }).runs);
  }
  return { $schema: 'https://json.schemastore.org/sarif-2.1.0.json', version: '2.1.0', runs };
}

/** Where the last overview of `root` is kept, for the host's panel and fleet mcp: <fleet home>/security/<hash>.json. */
export const overviewFile = (root, env = process.env) => join(fleetHome(env), 'security', `${createHash('sha1').update(resolve(root)).digest('hex').slice(0, 16)}.json`);

export function saveOverview(o, env = process.env) {
  const file = overviewFile(o.project, env);
  mkdirSync(dirname(file), { recursive: true });
  // Through a .tmp and a rename, so a panel reading it never sees half of one.
  writeFileSync(`${file}.tmp`, JSON.stringify(o));
  renameSync(`${file}.tmp`, file);
  return file;
}

export function loadOverview(root, env = process.env) {
  try {
    return JSON.parse(readFileSync(overviewFile(root, env), 'utf8'));
  } catch {
    return null;
  }
}

/** Plans, runs, adds up and keeps the overview of the project `dir` is in. */
export async function securityOverview(dir, { only, demo = false, compiled = false, home, env = process.env, ...opts } = {}) {
  const { root, config, env: chosen } = securityConfig(dir, { home });
  const { run, left } = securityPlan(root, config, { only, demo, compiled });
  const results = await runChecks(run, { cwd: root, compiled, env, ...opts });
  const o = overview(results, { project: root, environment: chosen, left });
  try {
    saveOverview(o, env);
  } catch {}
  return o;
}
