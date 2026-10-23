// What Bosun runs and how: reading the crew (crew.js) and running it (supervisor.js), with real
// processes that are small node scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeProcs, hostPort, isTrouble, loadCrew, parseProcfile, procfileProcs, readEnvFiles, portInUse, readSpec, specFor, splitConcurrently, stripAnsi, withProfile, words, writeSpec } from '../src/crew.js';
import { RESTART_TIMES, Supervisor, afterExit, pidsOnPort, portOpen, seconds } from '../src/supervisor.js';
import { afterStatus, mergedLines, statusSegment, portSegments, uptime } from '../src/ui/CrewView.jsx';
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

test('restart: the policy read and changed by a profile, and the waits it works out', () => {
  const { procs, problems } = readSpec({ procs: { api: { run: 'node api', restart: 'on-failure' }, web: 'vite', bad: { run: 'x', restart: 'sometimes' } } });
  assert.deepEqual(procs.map((p) => [p.name, p.restart]), [['api', 'on-failure'], ['web', 'no']]);
  assert.match(problems[0], /"bad": "restart" is "no", "on-failure", "always"/);
  assert.deepEqual(withProfile(procs, { up: { web: { restart: 'always' }, api: { restart: 'nonsense' } } }, 'up').map((p) => p.restart), ['on-failure', 'always']);
  assert.equal(specFor({ procs, profiles: {} }).procs.api.restart, 'on-failure');
  assert.equal(specFor({ procs, profiles: {} }).procs.web.restart, undefined, 'the default isn\'t written');

  // Not wanted: never with "no", and not after a clean exit with "on-failure".
  assert.equal(afterExit({ policy: 'no', code: 1, ran: 10 }).restart, false);
  assert.equal(afterExit({ policy: 'on-failure', code: 0, ran: 10 }).restart, false);
  assert.equal(afterExit({ policy: 'on-failure', code: null, ran: 10 }).restart, true, 'killed by a signal is a failure');
  assert.equal(afterExit({ policy: 'always', code: 0, ran: 60_000 }).restart, true);

  // 1s, 2s, 4s… up to 30s, while it doesn't stay up; giving up after 5 quick ends in a row.
  let state = {};
  const waits = [];
  for (let i = 0; i < 4; i++) {
    state = afterExit({ policy: 'always', code: 1, ran: 100, state });
    waits.push(state.delay);
  }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000]);
  const last = afterExit({ policy: 'always', code: 1, ran: 100, state });
  assert.deepEqual([last.restart, last.gaveUp, last.quick], [false, true, 5]);
  // Slow failures never give up, and wait at most 30s; one that stayed up 30s starts again from 1s.
  state = {};
  for (let i = 0; i < 9; i++) state = afterExit({ policy: 'always', code: 1, ran: 15_000, state });
  assert.deepEqual([state.restart, state.delay, state.quick], [true, RESTART_TIMES.max, 0]);
  assert.equal(afterExit({ policy: 'always', code: 1, ran: 31_000, state }).delay, 1000);

  assert.equal(seconds(3200), '4s');
  const now = 1_000_000;
  assert.equal(statusSegment({ restartAt: now + 3900, status: 'crashed' }, now).text, ' restarting in 4s');
  assert.equal(statusSegment({ status: 'crashed' }, now).text, ' crashed ');
  assert.equal(afterStatus({ gaveUp: true, child: null }, now).text, ' gave up');
});

test('restart: a crashing process comes back, gives up, and a stop is never restarted', async () => {
  const dir = project({}, { 'crash.js': `console.log('up'); process.exit(4);`, 'idle.js': 'setInterval(() => {}, 1000);' });
  const events = [];
  const sup = new Supervisor(
    readSpec({ procs: { flaky: { run: 'node crash.js', restart: 'on-failure' }, steady: { run: 'node idle.js', restart: 'always' }, plain: { run: 'node crash.js' } } }).procs,
    { dir, onEvent: (e) => events.push(`${e.p.name}:${e.plan.restart ? 'restart' : e.plan.gaveUp ? 'gave up' : 'end'}`), restartTimes: { first: 100, max: 200, stable: 5000, quick: 5000, giveUpAfter: 3 } },
  );
  try {
    sup.start('flaky');
    sup.start('steady');
    sup.start('plain');
    const flaky = sup.get('flaky');
    await until(() => flaky.gaveUp, 'giving up');
    assert.equal(flaky.lines.filter((l) => l.text === 'up').length, 3, 'started three times');
    assert.ok(flaky.lines.some((l) => l.text === '── restarting in 1s'));
    assert.equal(flaky.restartAt, null);
    assert.deepEqual(events.filter((e) => e.startsWith('flaky')), ['flaky:restart', 'flaky:restart', 'flaky:gave up']);
    await until(() => sup.get('plain').status === 'crashed', 'the one that doesn\'t restart, crashed');
    assert.ok(events.includes('plain:end'));

    // A stop is a stop, even with "always"; a start counts from nothing again.
    await until(() => sup.get('steady').status === 'running', 'steady up');
    await sup.stop('steady');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sup.get('steady').status, 'stopped');
    assert.ok(!events.some((e) => e.startsWith('steady')));
    sup.start('flaky');
    assert.equal(flaky.gaveUp, false);
    assert.equal(flaky.quick, 0);
    await until(() => flaky.restartAt, 'waiting to restart');
    assert.equal(sup.cancelRestart('flaky'), true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(flaky.status, 'crashed');
    assert.equal(flaky.restartAt, null);
    assert.ok(flaky.lines.some((l) => l.text === '── not restarting it'));
  } finally {
    sup.dispose();
  }
});

test('env files: the top level\'s then the process\'s, under its own env, over the terminal\'s', async () => {
  const dir = project(
    { envFile: '.env', procs: { api: { run: 'node show.js', cwd: 'api', envFile: ['.env', '.env.local'], env: { C: 'from bosun.json' } }, web: { run: 'node show.js', envFile: 'missing.env' } } },
    { '.env': 'A=top\nB=top\nC=top\nD=${TERMINAL}-${A}', 'show.js': 'console.log(JSON.stringify({ A: process.env.A, B: process.env.B, C: process.env.C, D: process.env.D, T: process.env.TERMINAL }))' },
  );
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'api'));
  writeFileSync(join(dir, 'api', '.env'), 'B=api ${A}');
  writeFileSync(join(dir, 'api', '.env.local'), 'B=${B} local');
  writeFileSync(join(dir, 'api', 'show.js'), readFileSync(join(dir, 'show.js'), 'utf8'));
  const crew = loadCrew(dir, { env: { TERMINAL: 'term' } });
  const api = crew.procs.find((p) => p.name === 'api');
  assert.deepEqual(api.fileEnv, { A: 'top', B: 'api top local', C: 'top', D: 'term-top' });
  assert.deepEqual(crew.problems, ["env file web's missing.env: it isn't there"]);
  assert.match(readSpec({ envFile: 3, procs: { x: { run: 'x', envFile: [1] } } }).problems.join('|'), /"x": "envFile" is a file's path.*\|"envFile" is/);
  assert.equal(specFor(crew).envFile, '.env');
  assert.deepEqual(specFor(crew).procs.api.envFile, ['.env', '.env.local']);
  assert.deepEqual(readEnvFiles({ procs: [{ name: 'p', envFile: ['x'] }], envFile: [], problems: [] }, dir, { read: () => 'X=1' }).procs[0].fileEnv, { X: '1' });

  const sup = new Supervisor(crew.procs, { dir, env: { ...process.env, TERMINAL: 'term', A: 'terminal', C: 'terminal' } });
  try {
    sup.start('api');
    await until(() => sup.get('api').lines.some((l) => l.text.startsWith('{')), 'its settings printed');
    assert.deepEqual(JSON.parse(sup.get('api').lines.find((l) => l.text.startsWith('{')).text), { A: 'top', B: 'api top local', C: 'from bosun.json', D: 'term-top', T: 'term' });
  } finally {
    sup.dispose();
  }
});

test('watch: a change to a watched file restarts the process, an ignored one doesn\'t, and a stop stops watching', async () => {
  const dir = project({}, { 'idle.js': 'console.log("up"); setInterval(() => {}, 1000);' });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  const sup = new Supervisor(readSpec({ procs: { api: { run: 'node idle.js', watch: ['src', 'missing'], ignore: ['*.tmp'] } } }).procs, { dir, debounce: 100 });
  const api = sup.get('api');
  const ups = () => api.lines.filter((l) => l.text === 'up').length;
  try {
    sup.start('api');
    await until(() => ups() === 1, 'started');
    assert.ok(api.lines.some((l) => l.text === "── can't watch missing: it isn't there"));
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(join(dir, 'src', 'deep', 'a.js'), '1');
    writeFileSync(join(dir, 'src', 'deep', 'b.js'), '1');
    await until(() => ups() === 2, 'restarted after the change');
    assert.ok(api.lines.some((l) => /^── changed: src\/deep\/[ab]\.js( and 1 more)?$/.test(l.text)), api.lines.map((l) => l.text).join('\n'));
    assert.equal(api.lines.filter((l) => l.text.startsWith('── changed')).length, 1, 'once for both');

    writeFileSync(join(dir, 'src', 'x.tmp'), '1');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(ups(), 2, 'an ignored file changes nothing');

    await sup.stop('api');
    writeFileSync(join(dir, 'src', 'c.js'), '1');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(api.status, 'stopped', 'a stopped process isn\'t started by a change');
    assert.equal(api.watchers, null);
  } finally {
    sup.dispose();
  }
});

test('Procfile and compose: read when there\'s no bosun.json, in that order, and /init writes them out', async () => {
  const { rmSync } = await import('node:fs');
  assert.deepEqual(parseProcfile('# web\nweb: node server.js -p $PORT\n\nworker:node worker.js\nnot a line\n'), [
    { name: 'web', run: 'node server.js -p $PORT' },
    { name: 'worker', run: 'node worker.js' },
  ]);
  assert.deepEqual(procfileProcs([{ name: 'web', run: 'web --port %PORT%' }, { name: 'w', run: 'w' }], 6000).map((p) => [p.port, p.env.PORT]), [[6000, '6000'], [null, '6100']]);
  assert.deepEqual(['8080:80', '127.0.0.1:5432:5432/tcp', '3000', 3000, { published: '9000', target: 90 }, null].map(hostPort), [8080, 5432, null, null, 9000, null]);
  assert.deepEqual(composeProcs({ services: { web: { ports: ['8080:80'], depends_on: ['api', 'cache'] }, api: { depends_on: { db: {} } }, db: {} } }).map((p) => [p.name, p.run, p.port, p.after]), [
    ['web', 'docker compose up --no-deps web', 8080, 'api'],
    ['api', 'docker compose up --no-deps api', null, 'db'],
    ['db', 'docker compose up --no-deps db', null, null],
  ]);

  const dir = project({ procs: { from: 'bosun.json' } }, {
    Procfile: 'web: node server.js $PORT\nworker: node worker.js\n',
    '.env': 'PORT=7000\nSECRET=shh',
    'compose.yaml': 'services:\n  db:\n    ports: ["5433:5432"]\n',
    'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
  });
  assert.equal(loadCrew(dir).from, 'bosun.json');
  rmSync(join(dir, 'bosun.json'));
  const crew = loadCrew(dir, { env: {} });
  assert.equal(crew.from, 'Procfile');
  assert.deepEqual(crew.procs.map((p) => [p.name, p.port, p.env.PORT, p.fileEnv.SECRET]), [['web', 7000, '7000', 'shh'], ['worker', null, '7100', 'shh']]);
  const spec = specFor(crew);
  assert.equal(spec.envFile, '.env');
  assert.deepEqual(spec.procs.web, { run: 'node server.js $PORT', port: 7000, env: { PORT: '7000' } });
  rmSync(join(dir, 'Procfile'));
  const compose = loadCrew(dir);
  assert.equal(compose.from, 'compose.yaml');
  assert.deepEqual(compose.procs.map((p) => [p.name, p.port, p.fileEnv]), [['db', 5433, undefined]]);
  rmSync(join(dir, 'compose.yaml'));
  assert.equal(loadCrew(dir).from, "package.json's dev script");
});
