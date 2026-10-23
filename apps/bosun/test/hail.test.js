// A process's Hail checks: finding hail on the PATH, the command, reading its outcome, and the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { findOnPath } from '../src/which.js';
import { hailCommand, testOutcome, testSpec, testsLabel } from '../src/hailcheck.js';
import { readSpec, specFor } from '../src/crew.js';
import { KEYS, project, start, tempHome, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('hail on the PATH, with PATHEXT on Windows', () => {
  const files = new Set(['/usr/bin/hail', 'C:\\Tools\\hail.CMD'.toLowerCase(), 'c:\\bin\\hail.exe']);
  const exists = (f) => files.has(f.toLowerCase()) || files.has(f);
  assert.equal(findOnPath('hail', { env: { PATH: '/nope:/usr/bin' }, platform: 'linux', exists }), '/usr/bin/hail');
  assert.equal(findOnPath('hail', { env: { PATH: '/nope' }, platform: 'linux', exists }), null);
  assert.equal(findOnPath('hail', { env: { Path: 'C:\\nope;"C:\\Tools"', PATHEXT: '.EXE;.CMD' }, platform: 'win32', exists }), 'C:\\Tools\\hail.cmd');
  assert.equal(findOnPath('hail', { env: { PATH: 'c:\\bin;C:\\Tools' }, platform: 'win32', exists }), 'c:\\bin\\hail.com' === 'x' ? null : 'c:\\bin\\hail.exe');
  assert.equal(findOnPath('hail.exe', { env: { PATH: 'c:\\bin' }, platform: 'win32', exists }), 'c:\\bin\\hail.exe');
});

test('"test" in bosun.json, the command line, and what a run came to', () => {
  assert.deepEqual(testSpec('api.http'), { file: 'api.http', env: null });
  assert.deepEqual(testSpec({ file: 'api.http', env: 'dev' }), { file: 'api.http', env: 'dev' });
  assert.equal(testSpec({ env: 'dev' }), null);
  const spec = readSpec({ procs: { api: { run: 'x', port: 3000, test: { file: 'api.http', env: 'dev' } }, web: { run: 'y', test: 'a.http' }, bad: { run: 'z', port: 1, test: 3 } } });
  assert.deepEqual(spec.procs.map((p) => [p.name, p.test]), [['api', { file: 'api.http', env: 'dev' }]]);
  assert.equal(spec.problems.length, 2);
  assert.match(spec.problems.join('\n'), /"web": "test" runs once its port answers/);
  assert.deepEqual(specFor({ procs: spec.procs, profiles: {} }).procs.api.test, { file: 'api.http', env: 'dev' });
  assert.equal(hailCommand('/usr/bin/hail', { file: 'api.http', env: 'dev' }, 'linux'), '/usr/bin/hail test api.http --env dev');
  assert.equal(hailCommand('C:\\Program Files\\hail.exe', { file: 'my api.http', env: null }, 'win32'), '"C:\\Program Files\\hail.exe" test "my api.http"');
  assert.deepEqual(testOutcome({ code: 0, stdout: '3 requests sent · 4 tests: 4 passed\n' }), { state: 'ok', failed: 0, text: '3 requests sent · 4 tests: 4 passed' });
  assert.equal(testOutcome({ code: 1, stdout: '  1 of 2 tests failed\n3 requests sent · 6 tests: 4 passed, 2 failed' }).failed, 2);
  assert.equal(testOutcome({ code: 1, stdout: 'a request got no answer' }).failed, 1);
  assert.equal(testOutcome({ code: 2, stderr: 'no such file' }).state, 'error');
  assert.deepEqual([{ state: 'ok' }, { state: 'failed', failed: 2 }, { state: 'error' }, { state: 'running' }, null].map((t) => testsLabel(t)?.text), [' ✓ tests', ' ✗ 2 failed', ' ✗ tests', ' … tests', undefined]);
});

const freePort = () =>
  new Promise((done) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

test('once the port answers, hail test runs; the outcome shows beside it, again after a restart; no hail is said once', async () => {
  const port = await freePort();
  const SERVER = `require('http').createServer((q, s) => s.end('ok')).listen(+process.env.PORT, '127.0.0.1', () => console.log('up'));`;
  const dir = project({ procs: { api: { run: 'node server.js', port, env: { PORT: String(port) }, health: '/', test: { file: 'api.http', env: 'dev' } } } }, { 'server.js': SERVER });
  const calls = [];
  let answer = { code: 1, stdout: 'GET /orders 500\n  ✗ status is 200\n1 request sent · 3 tests: 1 passed, 2 failed' };
  const app = start({ dir, runHail: async (t, { cwd }) => (calls.push({ ...t, cwd }), answer) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /api\s+running\s+✗ 2 failed/.test(frame()), 'two failed, beside it');
    assert.deepEqual(calls, [{ file: 'api.http', env: 'dev', cwd: dir }]);
    assert.match(frame(), /── 2 tests failed/);
    answer = { code: 0, stdout: '1 request sent · 3 tests: 3 passed' };
    app.stdin.write('r');
    await until(() => /api\s+running\s+✓ tests/.test(frame()), 'passing after the restart');
    assert.equal(calls.length, 2);
  } finally {
    app.unmount();
    rmSync(dir, { recursive: true, force: true });
  }
  const port2 = await freePort();
  const dir2 = project({ procs: { api: { run: 'node server.js', port: port2, env: { PORT: String(port2) }, test: 'api.http' } } }, { 'server.js': SERVER });
  const app2 = start({ dir: dir2 });
  try {
    await until(() => (app2.lastFrame() ?? '').includes("hail isn't on the PATH"), 'said once');
    assert.match(app2.lastFrame(), /hail isn't installed, so its tests didn't run/);
  } finally {
    app2.unmount();
    rmSync(dir2, { recursive: true, force: true });
  }
});
