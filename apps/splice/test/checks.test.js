// The checks before a push: working them out, the file, on and off per repository, running them and
// putting the results together (with fake commands), and the push that runs them.
import { removeTemp } from './temp.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { readActivity } from '@fleet/kit/family.js';
import { CHECKS_FILE, checkLine, checksFileText, checksOn, checksSummary, detectChecks, duration, failedText, hailCommand, httpFiles, lookAround, packageManager, readChecksFile, runChecks, runCheckCommand, setChecksOn } from '../src/checks.js';
import { App } from '../src/ui/App.jsx';

let base;
let lastApp = null;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-checks-'));
  process.env.SPLICE_HOME = join(base, 'home');
});

after(() => removeTemp(base));

test('working the checks out: test and lint scripts (not npm init\'s), the package manager, a .sln, .http files with Hail', () => {
  assert.deepEqual(detectChecks({ files: ['package.json'], pkg: { scripts: { test: 'node --test', lint: 'eslint .', dev: 'vite' } } }), [
    { name: 'test', run: 'npm test' },
    { name: 'lint', run: 'npm run lint' },
  ]);
  assert.deepEqual(detectChecks({ files: ['package.json'], pkg: { scripts: { test: 'echo "Error: no test specified" && exit 1' } } }), []);
  assert.deepEqual(detectChecks({ files: ['package.json'], pkg: {} }), []);
  assert.equal(packageManager(['pnpm-lock.yaml']), 'pnpm');
  assert.equal(packageManager(['yarn.lock']), 'yarn');
  assert.deepEqual(detectChecks({ files: ['yarn.lock'], pkg: { scripts: { test: 'jest', lint: 'eslint' } } }).map((c) => c.run), ['yarn test', 'yarn run lint']);
  assert.deepEqual(detectChecks({ files: ['Shop.sln', 'README.md'] }), [{ name: 'dotnet test', run: 'dotnet test' }]);
  assert.deepEqual(detectChecks({ files: ['B.sln', 'A.slnx'] }).map((c) => c.run), ['dotnet test A.slnx', 'dotnet test B.sln']);
  assert.deepEqual(detectChecks({ http: ['api/orders.http'], hail: null }), [], 'no Hail, no .http checks');
  assert.deepEqual(detectChecks({ http: ['api/orders.http', 'my tests.http'], hail: 'hail' }), [
    { name: 'hail api/orders.http', run: 'hail test api/orders.http' },
    { name: 'hail my tests.http', run: 'hail test "my tests.http"' },
  ]);
});

test('how Hail runs: on the PATH, else Fleet\'s own build carries it, else not at all', () => {
  assert.equal(hailCommand({ findHail: () => '/usr/bin/hail' }), 'hail');
  assert.equal(hailCommand({ findHail: () => null, hosted: true, compiled: true, execPath: '/opt/fleet/fleet' }), '/opt/fleet/fleet --run hail');
  assert.equal(hailCommand({ findHail: () => null, hosted: true, compiled: true, execPath: 'C:\\Program Files\\Fleet\\fleet.exe' }), '"C:\\Program Files\\Fleet\\fleet.exe" --run hail');
  assert.equal(hailCommand({ findHail: () => null, hosted: true, compiled: false }), null, 'from a checkout, Node is not Fleet');
  assert.equal(hailCommand({ findHail: () => null, hosted: false, compiled: true }), null);
});

test('.splice/checks.json: commands or name and run, what is wrong with it, and what /checks edit writes', () => {
  assert.deepEqual(readChecksFile('{ "checks": ["npm test", { "name": "types", "run": "tsc --noEmit" }] }'), { checks: [{ name: 'npm test', run: 'npm test' }, { name: 'types', run: 'tsc --noEmit' }], problems: [] });
  assert.deepEqual(readChecksFile('["make check"]').checks, [{ name: 'make check', run: 'make check' }]);
  assert.match(readChecksFile('{ nope').problems[0], /isn't JSON/);
  assert.match(readChecksFile('{}').problems[0], /no "checks" list/);
  assert.deepEqual(readChecksFile('{ "checks": [{ "name": "x" }, "ok"] }'), { checks: [{ name: 'ok', run: 'ok' }], problems: ['Check 1 has no command ("run").'] });
  const text = checksFileText([{ name: 'test', run: 'npm test', state: 'done' }]);
  assert.deepEqual(readChecksFile(text).checks, [{ name: 'test', run: 'npm test' }]);
});

test('on and off: per repository, else the setting, which is off', () => {
  assert.equal(checksOn({}, '/r'), false);
  assert.equal(checksOn({ checksBeforePush: true }, '/r'), true);
  let c = setChecksOn({}, '/r', true);
  assert.equal(checksOn(c, '/r'), true);
  assert.equal(checksOn(c, '/other'), false);
  c = setChecksOn({ ...c, checksBeforePush: true }, '/r', false);
  assert.equal(checksOn(c, '/r'), false, 'off here wins over the setting');
  assert.equal(checksOn(c, '/other'), true);
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  assert.equal(checksOn(setChecksOn({}, 'C:\\Repo', true, same), 'c:\\repo', same), true);
  assert.equal(Object.keys(setChecksOn(setChecksOn({}, 'C:\\Repo', true, same), 'c:\\repo', false, same).checks).length, 1);
});

test('running: one after another, timed, a failure (or a throw) a result, the summary and the failing output', async () => {
  let clock = 0;
  const seen = [];
  const outcome = await runChecks(
    [
      { name: 'test', run: 'npm test' },
      { name: 'lint', run: 'npm run lint' },
      { name: 'types', run: 'tsc' },
    ],
    {
      now: () => clock,
      onUpdate: (results) => seen.push(results.map(checkLine)),
      runOne: async (c) => {
        clock += c.name === 'test' ? 3200 : 450;
        if (c.name === 'types') throw Object.assign(new Error('tsc: not found'), { code: 127 });
        return c.name === 'lint' ? { ok: false, code: 1, output: 'src/a.js\n  1:1  error  no-undef' } : { ok: true, code: 0, output: 'ok' };
      },
    },
  );
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.failed.map((r) => r.name), ['lint', 'types']);
  assert.deepEqual(seen[0], ['… test', '· lint', '· types']);
  assert.deepEqual(seen.at(-1), ['✓ test  3.2s', '✗ lint  450ms  (exit 1)', '✗ types  450ms  (exit 127)']);
  assert.equal(checksSummary(outcome), '2 of 3 checks failed: lint, types');
  const text = failedText(outcome.failed);
  assert.match(text, /^✗ lint {2}\(npm run lint, 450ms, exit 1\)\n\nsrc\/a\.js\n {2}1:1 {2}error {2}no-undef/);
  assert.match(text, /✗ types {2}\(tsc, 450ms, exit 127\)\n\ntsc: not found/);
  const passed = await runChecks([{ name: 'test', run: 'x' }], { runOne: async () => ({ ok: true }) });
  assert.equal(passed.ok, true);
  assert.equal(checksSummary(passed), 'The check passed');
  assert.equal(duration(65_000), '1m 05s');
});

test('running: esc stops at the check running, and the rest are not run', async () => {
  const controller = new AbortController();
  const ran = [];
  const outcome = await runChecks(
    [
      { name: 'a', run: 'a' },
      { name: 'b', run: 'b' },
      { name: 'c', run: 'c' },
    ],
    {
      signal: controller.signal,
      runOne: async (c) => {
        ran.push(c.name);
        if (c.name === 'b') {
          controller.abort();
          return { ok: false, cancelled: true };
        }
        return { ok: true };
      },
    },
  );
  assert.deepEqual(ran, ['a', 'b']);
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.results.map(checkLine).slice(1), ['· b (not run: stopped)', '· c (not run: stopped)']);
  assert.equal(checksSummary(outcome), 'Checks stopped (1 of 3 run)');
});

test('a real command: its exit code and output', async () => {
  const ok = await runCheckCommand({ run: 'node -e "console.log(42)"' }, { cwd: base });
  assert.deepEqual([ok.ok, ok.output.trim()], [true, '42']);
  const bad = await runCheckCommand({ run: 'node -e "console.error(\'boom\'); process.exit(3)"' }, { cwd: base });
  assert.deepEqual([bad.ok, bad.code, bad.output.trim()], [false, 3, 'boom']);
});

test('looking around a folder: the file wins, else package.json, a .sln and .http files (not in node_modules)', () => {
  const dir = join(base, 'look');
  mkdirSync(join(dir, 'api', 'requests'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  writeFileSync(join(dir, 'Shop.sln'), '');
  writeFileSync(join(dir, 'api', 'requests', 'orders.http'), 'GET /\n');
  writeFileSync(join(dir, 'node_modules', 'x', 'no.http'), 'GET /\n');
  assert.deepEqual(httpFiles(dir), ['api/requests/orders.http']);
  const found = lookAround(dir, { hail: 'hail' });
  assert.equal(found.from, 'detected');
  assert.deepEqual(found.checks.map((c) => c.run), ['npm test', 'dotnet test', 'hail test api/requests/orders.http']);
  mkdirSync(join(dir, '.splice'));
  writeFileSync(join(dir, CHECKS_FILE), '{ "checks": ["make check"] }');
  assert.deepEqual(lookAround(dir, { hail: 'hail' }), { checks: [{ name: 'make check', run: 'make check' }], problems: [], from: 'file' });
});

function makeRepo(name) {
  const dir = join(base, name);
  const origin = join(base, `${name}.git`);
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '--bare', origin]);
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@example.com');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }));
  g('add', '.');
  g('commit', '-q', '-m', 'First');
  g('remote', 'add', 'origin', origin);
  g('push', '-q', '-u', 'origin', 'main');
  const remote = (...args) => execFileSync('git', ['--git-dir', origin, ...args], { encoding: 'utf8' }).trim();
  return { dir, g, remote };
}

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

test('with checks on, a push runs them: a failure shows its output and asks, no keeps the commits, yes pushes and says so in the activity log', async () => {
  const { dir, g, remote } = makeRepo('checked');
  writeFileSync(join(dir, 'a.js'), 'x\n');
  g('add', '.');
  g('commit', '-q', '-m', 'Add a');
  const ran = [];
  const familyHome = join(base, 'family');
  lastApp = render(
    React.createElement(App, {
      initialPath: dir,
      familyHome,
      moodEvery: 0,
      config: { recent: [], roots: [], history: [], riskBeforePush: false, checksBeforePush: true },
      findHail: () => null,
      runCheck: async (c) => {
        ran.push(c.run);
        return c.name === 'lint' ? { ok: false, code: 1, output: 'a.js: no-undef' } : { ok: true, code: 0, output: '' };
      },
    }),
  );
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Add a'), 'the graph');
    app.stdin.write('\x1bp');
    await until(() => frame().includes('Push anyway? 1 of 2 checks failed: lint.'), 'the question');
    assert.deepEqual(ran, ['npm test', 'npm run lint']);
    assert.match(frame(), /a\.js: no-undef/);
    app.stdin.write('\r');
    await until(() => !frame().includes('Push anyway'), 'no');
    assert.equal(remote('log', '-1', '--format=%s', 'main'), 'First');
    app.stdin.write('\x1bp');
    await until(() => frame().includes('Push anyway?'), 'the question again');
    app.stdin.write('2');
    await until(() => remote('log', '-1', '--format=%s', 'main') === 'Add a', 'the push', 20000);
    await until(() => readActivity({ dir: familyHome }).some((e) => /though its checks failed \(lint\)/.test(e.text)), 'the activity line');
  } finally {
    app.unmount();
  }
});

test('/checks lists them, /checks run runs them without pushing, /checks off and on for this repository, /checks edit writes the file', async () => {
  const { dir, g, remote } = makeRepo('listed');
  writeFileSync(join(dir, 'b.js'), 'x\n');
  g('add', '.');
  g('commit', '-q', '-m', 'Add b');
  const ran = [];
  let saved = null;
  lastApp = render(
    React.createElement(App, {
      initialPath: dir,
      config: { recent: [], roots: [], history: [], riskBeforePush: false },
      findHail: () => null,
      runCheck: async (c) => (ran.push(c.run), { ok: true, code: 0, output: '' }),
    }),
  );
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  const command = async (text) => {
    app.stdin.write('/');
    await new Promise((r) => setTimeout(r, 50));
    for (const ch of text) app.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write('\r');
  };
  try {
    await until(() => frame().includes('Add b'), 'the graph');
    await command('checks ');
    await until(() => frame().includes('Checks before push: off here · worked out') && frame().includes('npm run lint'), 'the list');
    app.stdin.write('r');
    await until(() => /2 checks passed/.test(frame()), 'both run');
    assert.deepEqual(ran, ['npm test', 'npm run lint']);
    // Off by default: a push runs nothing.
    app.stdin.write('\x1bp');
    await until(() => remote('log', '-1', '--format=%s', 'main') === 'Add b', 'the push', 20000);
    assert.equal(ran.length, 2);
    await command('checks on');
    await until(() => frame().includes('Checks run before each push here (2)'), 'on');
    saved = JSON.parse(readFileSync(join(process.env.SPLICE_HOME, 'config.json'), 'utf8'));
    assert.equal(Object.values(saved.checks ?? {})[0], true);
    await command('checks edit');
    await until(() => frame().includes('Wrote .splice/checks.json'), 'the file');
    assert.deepEqual(readChecksFile(readFileSync(join(dir, CHECKS_FILE), 'utf8')).checks.map((c) => c.run), ['npm test', 'npm run lint']);
  } finally {
    app.unmount();
  }
});
