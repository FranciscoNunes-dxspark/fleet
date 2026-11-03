// `fleet security [folder] [--only a,b] [--json] [--sarif [file]] [--fail-on level] [--demo]`: every
// app's security check for the project, as one overview (security.js), without the screen. Exits 0
// when nothing is as bad as --fail-on (high by default), 1 when something is, 2 when it couldn't run or
// a check couldn't (each one's reason is said).
import './app.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { failingFindings, parseFailOn } from '@fleet/kit/findings.js';
import { COMPILED, VERSION } from './app.js';
import { CHECKS, overviewSarif, overviewText, securityOverview } from './security.js';

/** { dir, only, json, sarif, failOn, demo } from the arguments after `fleet security`; `error` when they don't add up. */
export function parseSecurityArgs(args) {
  const o = { dir: '.', only: null, json: false, sarif: null, failOn: 'high', demo: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') o.json = true;
    else if (a === '--demo') o.demo = true;
    else if (a === '--fail-on') {
      o.failOn = parseFailOn(args[++i]);
      if (!o.failOn) return { ...o, error: '--fail-on is one of critical, high, medium, low, none' };
    } else if (a === '--only') {
      o.only = String(args[++i] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const bad = o.only.filter((x) => !CHECKS.some((c) => c.app === x));
      if (!o.only.length || bad.length) return { ...o, error: `--only takes apps among ${CHECKS.map((c) => c.app).join(', ')}` };
    } else if (a === '--sarif') o.sarif = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : '-';
    else if (a.startsWith('-')) return { ...o, error: `Unknown option ${a}` };
    else o.dir = a;
  }
  if (o.json && o.sarif === '-') return { ...o, error: '--json and --sarif both want the output: give --sarif a file' };
  return o;
}

export async function runSecurityCli(args, { write = (s) => process.stdout.write(s), say = (s) => process.stderr.write(s), compiled = COMPILED, ...opts } = {}) {
  const o = parseSecurityArgs(args);
  if (o.error) {
    write(`fleet security: ${o.error}\n`);
    return 2;
  }
  const dir = resolve(o.dir);
  const quiet = o.json || o.sarif === '-';
  const result = await securityOverview(dir, {
    only: o.only,
    demo: o.demo,
    compiled,
    onProgress: (done, total, r) => quiet || say(`  ${done}/${total} ${r.label}${r.ok ? '' : ': couldn\'t run'}\n`),
    ...opts,
  });
  if (o.sarif) {
    const sarif = `${JSON.stringify(overviewSarif(result, { version: VERSION }), null, 2)}\n`;
    if (o.sarif === '-') write(sarif);
    else {
      writeFileSync(resolve(o.sarif), sarif);
      if (!o.json) say(`SARIF in ${resolve(o.sarif)}\n`);
    }
  }
  if (o.json) write(`${JSON.stringify(result, null, 2)}\n`);
  else if (o.sarif !== '-') write(overviewText(result, { failOn: o.failOn }));
  if (result.checks.some((c) => !c.ok)) return 2;
  return failingFindings(result.findings, o.failOn).length ? 1 : 0;
}

if (process.argv[2] === 'security') process.exit(await runSecurityCli(process.argv.slice(3)));
