// The security overview: which checks run for a project, running them (a stand-in spawn, and the real
// apps on their demo), adding them up, the text, SARIF and kept file, fleet security's arguments, the
// host's panel (the prefix and S) and fleet mcp's security_overview.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { prefixAction } from '../src/keys.js';
import { securityLines } from '../src/overlay.js';
import { loadOverview, overview, overviewSarif, overviewText, parseCheckOutput, runChecks, saveOverview, securityConfig, securityPlan } from '../src/security.js';
import { parseSecurityArgs, runSecurityCli } from '../src/securitycli.js';
import { createFleetServer } from '../src/mcp/server.js';
import { PREFIX, startHost, stopAll, until } from './helpers.js';

after(stopAll);

const SPACES = [
  { id: 'one', title: 'One', letter: 'o', accent: '#ff0000' },
  { id: 'two', title: 'Two', letter: 'w', accent: '#00ff00' },
];

function project(json) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-sec-'));
  if (json) {
    mkdirSync(join(dir, '.fleet'));
    writeFileSync(join(dir, '.fleet', 'project.json'), JSON.stringify(json));
  }
  return dir;
}

const finding = (over) => ({ rule: 'r', severity: 'high', title: 'T', where: 'a.js', line: 1, why: 'W', fix: 'F', ...over });
const result = (app, check, findings) => ({ app, label: app, ok: true, ms: 5, result: { app, check, target: '/p', findings } });

test('the plan: Bilge, Splice and Chart always; the rest only as .fleet/project.json says, the environment over the file', () => {
  const bare = project();
  const { run, left } = securityPlan(bare, {});
  assert.deepEqual(run.map((r) => r.app), ['bilge', 'splice', 'chart']);
  assert.deepEqual(run[0].args, ['security', bare, '--json', '--fail-on', 'none']);
  assert.ok(left.some((l) => l.app === 'hail' && /not set up/.test(l.why)));

  const dir = project({
    environments: { dev: {}, prod: { prod: true, security: { hail: 'https://shop.example.com' } } },
    default: 'prod',
    security: { hail: 'requests.http', sonar: { subscription: 'sub-1', resourceGroup: 'rg' }, mooring: ['web1', 'web2'], locker: { vault: 'kv' }, wharf: { compose: 'compose.yaml' }, keel: 'Commerce', skip: ['chart'] },
  });
  const { root, config, env } = securityConfig(dir, { home: join(dir, 'family') });
  assert.equal(root, dir);
  assert.deepEqual(env, { name: 'prod', prod: true });
  // The chosen environment's address wins over the file's .http file.
  assert.equal(config.hail, 'https://shop.example.com');
  const plan = securityPlan(root, config);
  const args = Object.fromEntries(plan.run.map((r) => [r.label, r.args.slice(0, -3)]));
  assert.deepEqual(Object.keys(args), ['bilge', 'splice', 'hail', 'sonar', 'locker', 'mooring web1', 'mooring web2', 'wharf', 'keel']);
  assert.deepEqual(args.hail, ['security', 'https://shop.example.com']);
  assert.deepEqual(args.sonar, ['security', '--subscription', 'sub-1', '-g', 'rg']);
  assert.deepEqual(args.locker, ['security', dir, '--vault', 'kv']);
  assert.deepEqual(args.wharf, ['security', '--compose', join(dir, 'compose.yaml')]);
  assert.deepEqual(args.keel, ['security', 'Commerce']);
  assert.ok(plan.left.some((l) => l.app === 'chart' && /skipped/.test(l.why)));

  // Every app is in the build now, Wharf and Keel too; --only narrows; --demo runs the demos (Splice reads the real history).
  assert.ok(securityPlan(root, config, { compiled: true }).run.some((r) => r.app === 'keel'));
  assert.deepEqual(securityPlan(root, config, { only: ['bilge', 'keel'] }).run.map((r) => r.app), ['bilge', 'keel']);
  const demo = securityPlan(bare, {}, { demo: true });
  assert.ok(demo.run.find((r) => r.app === 'bilge').args.includes('--demo'));
  assert.ok(!demo.run.find((r) => r.app === 'splice').args.includes('--demo'));
  assert.deepEqual(demo.run.find((r) => r.app === 'mooring').args.slice(0, 2), ['security', 'demo']);
});

test("a check's JSON is read from its first line starting with {", () => {
  assert.equal(parseCheckOutput('Scanning…\n{\n  "findings": []\n}\n').findings.length, 0);
  assert.equal(parseCheckOutput('nothing'), null);
  assert.equal(parseCheckOutput('{ "no": "findings" }'), null);
});

test('runChecks: a few at a time, the JSON kept, exit 2 or no JSON is a reason, and the progress', async () => {
  const started = [];
  let live = 0;
  let most = 0;
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('close', null);
    const app = args.find((a) => ['bilge', 'splice', 'chart', 'sonar'].some((x) => a.endsWith(`${x}.js`)))?.match(/(\w+)\.js$/)[1];
    started.push(app);
    most = Math.max(most, ++live);
    setTimeout(() => {
      if (app === 'sonar') {
        child.stderr.write('Not signed in: az login\n');
        live--;
        return child.emit('close', 2);
      }
      child.stdout.write(JSON.stringify({ app, check: app, target: '/p', findings: [finding({ rule: app })] }));
      live--;
      child.emit('close', 0);
    }, 20);
    return child;
  };
  const seen = [];
  const plan = ['bilge', 'splice', 'chart', 'sonar'].map((app) => ({ app, label: app, args: ['security'] }));
  const out = await runChecks(plan, { spawn, concurrency: 2, onProgress: (done, total) => seen.push(`${done}/${total}`) });
  assert.equal(most, 2);
  assert.deepEqual(seen, ['1/4', '2/4', '3/4', '4/4']);
  assert.deepEqual(out.map((r) => r.ok), [true, true, true, false]);
  assert.equal(out[3].error, 'Not signed in: az login');
});

test('the overview: counts, findings worst first with their app, the text, one SARIF run per app, kept and read back', () => {
  const o = overview(
    [result('bilge', 'security', [finding({ severity: 'low', title: 'MD5' }), finding({ severity: 'critical', title: 'AWS key', where: 'src/config.js' })]), result('sonar', 'posture', [finding({ rule: 'nsg', title: 'SSH open', where: '/subscriptions/x/nsg', line: undefined })]), { app: 'hail', label: 'hail', ok: false, error: 'no answer', ms: 1 }],
    { project: '/p', left: [{ app: 'keel', why: 'not set up' }], now: new Date(0) },
  );
  assert.deepEqual(o.counts, { critical: 1, high: 1, medium: 0, low: 1, unknown: 0 });
  assert.deepEqual(o.findings.map((f) => `${f.app}:${f.title}`), ['bilge:AWS key', 'sonar:SSH open', 'bilge:MD5']);
  const text = overviewText(o, { failOn: 'high' });
  assert.match(text, /bilge +1 critical · 1 low/);
  assert.match(text, /hail +couldn't run: no answer/);
  assert.match(text, /keel +— not set up/);
  assert.match(text, /^CRIT bilge {3}AWS key {2}src\/config\.js:1$/m);
  assert.match(text, /failing on high and above\n$/);
  const sarif = overviewSarif(o);
  assert.deepEqual(sarif.runs.map((r) => r.tool.driver.name), ['Bilge', 'Sonar']);
  const home = mkdtempSync(join(tmpdir(), 'fleet-sec-home-'));
  saveOverview(o, { FLEET_HOME: home });
  assert.equal(loadOverview('/p', { FLEET_HOME: home }).findings.length, 3);
  assert.equal(loadOverview('/q', { FLEET_HOME: home }), null);
});

test('fleet security: its arguments, and the real apps on their demos', { timeout: 120_000 }, async () => {
  assert.deepEqual(parseSecurityArgs(['x', '--only', 'bilge,chart', '--fail-on', 'critical', '--json']), { dir: 'x', only: ['bilge', 'chart'], json: true, sarif: null, failOn: 'critical', demo: false });
  assert.match(parseSecurityArgs(['--only', 'nope']).error, /--only takes apps/);
  assert.match(parseSecurityArgs(['--json', '--sarif']).error, /give --sarif a file/);
  assert.equal(parseSecurityArgs(['--sarif', 'out.sarif']).sarif, 'out.sarif');

  const dir = project();
  const home = mkdtempSync(join(tmpdir(), 'fleet-sec-home-'));
  let out = '';
  const code = await runSecurityCli([dir, '--demo', '--only', 'bilge,chart', '--json'], { write: (s) => (out += s), env: { ...process.env, FLEET_HOME: home }, compiled: false });
  const j = JSON.parse(out);
  assert.equal(code, 1);
  assert.deepEqual(j.checks.map((c) => [c.app, c.ok]), [['bilge', true], ['chart', true]]);
  assert.ok(j.counts.critical > 0);
  assert.ok(j.findings.every((f) => f.app && f.severity && f.title && !('excerpt' in f)));
  // Kept for the panel and fleet mcp.
  assert.equal(loadOverview(dir, { FLEET_HOME: home }).findings.length, j.findings.length);
});

test('the prefix and S opens the security panel: the last overview, r runs the checks, ↵ shows why and fix', async () => {
  assert.deepEqual(prefixAction('S', SPACES), { type: 'security' });
  const tmp = mkdtempSync(join(tmpdir(), 'fleet-sec-host-'));
  mkdirSync(join(tmp, 'project'));
  const asked = [];
  const tools = {
    cwd: join(tmp, 'project'),
    env: { FLEET_HOME: join(tmp, 'home') },
    familyDir: join(tmp, 'family'),
    security: async (dir, { onProgress }) => {
      asked.push(dir);
      onProgress(1, 2);
      await new Promise((r) => setTimeout(r, 50));
      onProgress(2, 2);
      return overview([result('bilge', 'security', [finding({ severity: 'critical', title: 'AWS access key', where: 'src/config.js', why: 'Anyone who reads the repository has it.', fix: 'Deactivate the key.' })]), result('splice', 'history', [])], { project: dir });
    },
  };
  const { term, keys } = startHost({ spaces: SPACES, tools, columns: 100, rows: 30 });
  await until(() => term.screen.row(0) === 'one 100x29', 'the app', { term });
  keys(`${PREFIX}S`);
  await until(() => term.text().includes('No overview yet.'), 'the empty panel', { term });
  keys('r');
  await until(() => /CRIT +bilge +AWS access key +src\/config\.js:1/.test(term.text()) && /splice +nothing found/.test(term.text()), 'the overview', { term });
  assert.deepEqual(asked, [join(tmp, 'project')]);
  keys('\r');
  await until(() => term.text().includes('Fix: Deactivate the key.'), 'the fix', { term });
  keys('\x1b');
  await until(() => !term.text().includes('Security'), 'closed', { term });
});

test('securityLines: a line per check, the ones left out, and the findings', () => {
  const o = overview([result('bilge', 'security', [finding({ title: 'eval' })]), { app: 'sonar', label: 'sonar', ok: false, error: 'az login', ms: 1 }], { project: '/p', left: [{ app: 'hail', why: 'needs an address' }] });
  const text = securityLines({ overview: o, width: 80, spaces: [{ id: 'bilge', title: 'Bilge', accent: '#9ccc65' }] }).lines.map((l) => l.map((s) => s.text).join('')).join('\n');
  assert.match(text, /Bilge +1 high/);
  assert.match(text, /sonar +couldn't run: az login/);
  assert.match(text, /hail +needs an address/);
  assert.match(text, /HIGH Bilge +eval {2}a\.js:1/);
});

test('fleet mcp security_overview reads the last overview, by app and severity, and says when there is none', async () => {
  const dir = project();
  const home = mkdtempSync(join(tmpdir(), 'fleet-sec-home-'));
  const was = process.env.FLEET_HOME;
  process.env.FLEET_HOME = home;
  try {
    const s = createFleetServer({ project: dir, trawl: false });
    assert.match(await s.call('security_overview', {}), /No security overview/);
    saveOverview(overview([result('bilge', 'security', [finding({ severity: 'critical', title: 'AWS key' }), finding({ severity: 'low', title: 'MD5' })]), result('splice', 'history', [finding({ title: 'Token in history' })])], { project: dir }));
    const all = await s.call('security_overview', {});
    assert.match(all, /1 critical · 1 high · 1 low/);
    assert.match(all, /CRITICAL {2}bilge {2}AWS key {2}a\.js:1\n {4}fix: F/);
    const high = await s.call('security_overview', { severity: 'high', app: 'bilge' });
    assert.ok(high.includes('AWS key') && !high.includes('MD5') && !high.includes('Token in history'));
    s.close();
  } finally {
    if (was === undefined) delete process.env.FLEET_HOME;
    else process.env.FLEET_HOME = was;
  }
});
