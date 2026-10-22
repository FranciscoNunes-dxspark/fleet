// What Bosun runs and how: reading the crew (crew.js) and running it (supervisor.js), with real
// processes that are small node scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isTrouble, loadCrew, portInUse, readSpec, specFor, splitConcurrently, stripAnsi, withProfile, words, writeSpec } from '../src/crew.js';
import { Supervisor, pidsOnPort, portOpen } from '../src/supervisor.js';
import { mergedLines, portSegments, uptime } from '../src/ui/CrewView.jsx';
import { whyPrompt } from '../src/actions.js';
import { project } from './helpers.js';

const until = async (check, what, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/** A port nothing listens on, from the OS. */
const freePort = () =>
  new Promise((done) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

const SERVER = `require('http').createServer((q, s) => { s.statusCode = q.url === '/health' ? 200 : 404; s.end('ok'); }).listen(+process.env.PORT, '127.0.0.1', () => console.log('listening on ' + process.env.PORT));`;

test('words and concurrently lines', () => {
  assert.deepEqual(words(`a "b c" 'd e' f\\"g`), ['a', 'b c', 'd e', 'f\\"g']);
  assert.deepEqual(splitConcurrently('concurrently -k -n api,web -c blue,green "node server.js" "vite --port 5173"'), [
    { name: 'api', run: 'node server.js' },
    { name: 'web', run: 'vite --port 5173' },
  ]);
  assert.deepEqual(splitConcurrently('npx concurrently "a" "b"').map((p) => p.name), ['1', '2']);
  assert.equal(splitConcurrently('vite'), null);
});

test('bosun.json: entries checked, profiles applied, and written back from package.json', () => {
  const { procs, problems } = readSpec({ procs: { api: { run: 'node api', port: 3000, health: '/health' }, web: { run: 'vite', after: 'api' }, 'bad name': 'x', noRun: {}, port: { run: 'x', port: 70000 }, late: { run: 'y', after: 'ghost' } } });
  assert.deepEqual(procs.map((p) => p.name), ['api', 'web', 'late']);
  assert.equal(procs[1].after, 'api');
  assert.equal(procs[2].after, null, 'waiting for one that isn\'t there is dropped');
  assert.equal(problems.length, 4);

  const changed = withProfile(procs, { mock: { api: { args: '--mock', env: { MOCK: '1' } }, web: { run: 'vite --mode mock' } } }, 'mock');
  assert.equal(changed[0].run, 'node api --mock');
  assert.deepEqual(changed[0].env, { MOCK: '1' });
  assert.equal(changed[1].run, 'vite --mode mock');
  assert.equal(withProfile(procs, {}, 'nope'), procs);

  const dir = mkdtempSync(join(tmpdir(), 'bosun-pkg-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'concurrently -n api,web "node server" "vite"', 'dev:mock': 'concurrently -n api,web "node server --mock" "vite"', test: 'node --test' } }));
  const crew = loadCrew(dir);
  assert.equal(crew.from, "package.json's dev script");
  assert.deepEqual(crew.procs.map((p) => [p.name, p.run]), [['api', 'node server'], ['web', 'vite']]);
  assert.deepEqual(crew.profiles, { mock: { api: { run: 'node server --mock' }, web: { run: 'vite' } } });
  assert.equal(writeSpec(dir, specFor(crew)), true);
  assert.equal(writeSpec(dir, specFor(crew)), false, 'never over one that\'s there');
  const again = loadCrew(dir);
  assert.equal(again.from, 'bosun.json');
  assert.deepEqual(again.procs.map((p) => p.run), ['node server', 'vite']);
  assert.match(readFileSync(join(dir, 'bosun.json'), 'utf8'), /"profiles"/);

  const plain = mkdtempSync(join(tmpdir(), 'bosun-pkg-'));
  writeFileSync(join(plain, 'package.json'), JSON.stringify({ scripts: { start: 'node index.js' } }));
  assert.deepEqual(loadCrew(plain).procs.map((p) => [p.name, p.run]), [['start', 'npm run start']]);
  assert.deepEqual(loadCrew(mkdtempSync(join(tmpdir(), 'bosun-empty-'))).procs, []);
  const broken = project({});
  writeFileSync(join(broken, 'bosun.json'), '{ nope');
  assert.throws(() => loadCrew(broken), /isn't valid JSON/);
});

test('log lines: colours taken off, trouble and taken ports spotted', () => {
  assert.equal(stripAnsi('\x1b[32mready\x1b[0m in 300ms'), 'ready in 300ms');
  assert.ok(isTrouble('Error: listen EADDRINUSE: address already in use :::3000'));
  assert.ok(isTrouble('TypeError: x is not a function'));
  assert.ok(!isTrouble('Found 0 errors. Watching for file changes.'));
  assert.ok(!isTrouble('GET /errors 200'));
  assert.equal(portInUse('Error: listen EADDRINUSE: address already in use :::3000'), 3000);
  assert.equal(portInUse('Error: listen EADDRINUSE: address already in use 127.0.0.1:5173'), 5173);
  assert.equal(portInUse('OSError: [Errno 98] Address already in use: 8000'), 8000);
  assert.equal(portInUse('all good'), null);
});

test('the rows: uptime, ports, the merged log, and the question for Claude', () => {
  assert.equal(uptime(0, 42_000), '42s');
  assert.equal(uptime(0, 5 * 60_000), '5m');
  assert.equal(uptime(0, 3 * 3600_000), '3h');
  const p = { port: 3000, child: {}, portOpen: true, health: null };
  assert.match(portSegments(p)[0].text, /:3000 ✓/);
  assert.match(portSegments({ ...p, health: 500 })[0].text, /✗ 500/);
  assert.match(portSegments({ ...p, portOpen: false })[0].text, /…/);
  assert.deepEqual(portSegments({ port: null }), []);
  const merged = mergedLines([{ name: 'a', lines: [{ at: 1, text: 'one' }, { at: 3, text: 'three' }] }, { name: 'b', lines: [{ at: 2, text: 'two' }] }], 2);
  assert.deepEqual(merged.map((l) => `${l.name}:${l.text}`), ['b:two', 'a:three']);
  assert.match(whyPrompt({ name: 'api', spec: { run: 'node api' }, status: 'crashed', code: 1 }), /exit code 1/);
});

test('the supervisor starts, watches the port, restarts, keeps a crash and stops the whole tree', async () => {
  const port = await freePort();
  const dir = project({}, { 'server.js': SERVER, 'crash.js': `console.log('starting'); console.error('Error: the database is not there'); process.exit(3);` });
  const changes = { n: 0 };
  const sup = new Supervisor(
    readSpec({ procs: { api: { run: 'node server.js', port, health: '/health', env: { PORT: String(port) } }, broken: { run: 'node crash.js' }, waits: { run: 'node -e "console.log(\'after api\'); setInterval(() => {}, 1000)"', after: 'api' } } }).procs,
    { dir, onChange: () => changes.n++ },
  );
  try {
    await sup.startAll();
    const api = sup.get('api');
    await until(() => api.lines.some((l) => l.text.includes(`listening on ${port}`)), 'the server up');
    await until(() => sup.get('waits').lines.some((l) => l.text === 'after api'), 'the one that waits, started after');
    await until(() => sup.get('broken').status === 'crashed', 'the crash');
    assert.equal(sup.get('broken').code, 3);
    assert.match(sup.get('broken').trouble, /database is not there/);
    assert.ok(changes.n > 0);

    await sup.checkPorts();
    assert.equal(api.portOpen, true);
    assert.equal(api.health, 200);
    assert.ok(await portOpen(port));
    if (process.platform !== 'win32' && pidsOnPort(port).length) assert.ok(pidsOnPort(port).length >= 1);

    const firstPid = api.pid;
    await sup.restart('api');
    await until(() => api.pid && api.pid !== firstPid && api.lines.filter((l) => l.text.includes('listening')).length === 2, 'started again');
    assert.ok(api.lines.some((l) => l.text === '── stopped'));

    await sup.stopAll();
    assert.deepEqual(sup.list().map((p) => p.status), ['stopped', 'crashed', 'stopped']);
    await until(async () => !(await portOpen(port)), 'the port let go');
  } finally {
    sup.dispose();
  }
});

test('a port already taken is spotted in the log', async () => {
  const port = await freePort();
  const holder = createServer().listen(port, '127.0.0.1');
  await new Promise((r) => holder.once('listening', r));
  const dir = project({}, { 'server.js': SERVER });
  const sup = new Supervisor(readSpec({ procs: { api: { run: 'node server.js', port, env: { PORT: String(port) } } } }).procs, { dir });
  try {
    sup.start('api');
    await until(() => sup.get('api').status === 'crashed', 'the crash');
    assert.equal(sup.takenPort('api'), port);
  } finally {
    sup.dispose();
    holder.close();
  }
});
