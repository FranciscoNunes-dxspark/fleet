// Pre-flight: Node ranges, each check over facts, gathering them from a project, and the report in the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDatabases, checkDocker, checkEnv, checkLine, checkModules, checkNode, checkPorts, envFilesOf, gatherFacts, needsDocker, parseVersion, runChecks, satisfies, summary } from '../src/preflight.js';
import { KEYS, project, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('Node versions against .nvmrc and engines ranges', () => {
  assert.deepEqual(parseVersion('v20.11'), [20, 11, null]);
  const cases = [
    ['22.3.0', '>=22', true], ['21.9.9', '>=22', false], ['20.11.1', '20', true], ['21.0.0', '20', false],
    ['20.11.1', 'v20.11.1', true], ['20.11.2', 'v20.11.1', false], ['18.19.0', '^18.17.0', true], ['19.0.0', '^18.17.0', false],
    ['18.19.0', '~18.17', false], ['18.17.9', '~18.17', true], ['16.0.0', '>=14 <16 || >=18', false], ['18.0.0', '>=14 <16 || >=18', true],
    ['20.5.0', '18 - 20', true], ['21.0.0', '18 - 20', false], ['20.0.0', '>= 18', true], ['20.0.0', '<=20', true], ['20.0.0', '>19', true], ['0.3.1', '^0.2.0', false],
  ];
  for (const [v, r, want] of cases) assert.equal(satisfies(v, r), want, `${v} in ${r}`);
  assert.equal(satisfies('22.0.0', 'lts/iron'), null);
  assert.equal(satisfies('22.0.0', 'node'), null);
});

test('each check: ✓ or ✗ with what to do', () => {
  assert.deepEqual(checkNode({ version: 'v18.0.0', wanted: '>=20', source: '.nvmrc' }).map((c) => c.ok), [false]);
  assert.deepEqual(checkNode({ version: 'v22.0.0', wanted: 'lts/*', source: '.nvmrc' }), []);
  assert.deepEqual(checkNode(null), []);
  assert.deepEqual(checkDocker({ needed: false }), []);
  assert.match(checkLine(checkDocker({ needed: true, ok: false })[0]), /^✗ Docker doesn't answer — start Docker/);
  const ports = checkPorts([{ proc: 'api', port: 3000, taken: true, pids: [42] }, { proc: 'web', port: 5173, taken: false }]);
  assert.equal(checkLine(ports[0]), "✗ api's port 3000 is taken by process 42 — /free 3000 (or f on api) stops what holds it");
  assert.equal(checkLine(ports[1]), "✓ web's port 5173 is free");
  const env = checkEnv([
    { file: '.env', example: '.env.example', exists: true, keys: ['A'], exampleKeys: ['A', 'B', 'C'] },
    { file: 'api/.env', example: 'api/.env.example', exists: false, keys: [], exampleKeys: ['X'] },
    { file: 'web/.env', example: 'web/.env.example', exists: true, keys: ['X'], exampleKeys: ['X'] },
  ]);
  assert.deepEqual(env.map(checkLine), ['✗ .env lacks B, C, which .env.example has — add them to .env', "✗ api/.env isn't there, and api/.env.example is — copy api/.env.example to api/.env and fill it in", '✓ web/.env has every key of web/.env.example']);
  const dbs = checkDatabases([{ name: 'Shop', kind: 'sqlserver', source: 'appsettings.json', server: 'localhost', port: 1433, reachable: false }, { name: 'X', reachable: null }]);
  assert.equal(dbs.length, 1);
  assert.match(checkLine(dbs[0]), /^✗ Shop \(sqlserver, from appsettings.json\) doesn't answer at localhost:1433/);
  assert.match(checkLine(checkModules({ packageJson: true, needed: true, tool: 'npm', modules: null })[0]), /node_modules isn't there — npm install/);
  assert.match(checkLine(checkModules({ packageJson: true, needed: true, tool: 'pnpm', modules: 1000, lock: 90_000, lockName: 'pnpm-lock.yaml' })[0]), /older than pnpm-lock.yaml — pnpm install/);
  assert.equal(checkModules({ packageJson: true, needed: true, tool: 'npm', modules: 90_000, lock: 1000 })[0].ok, true);
  assert.equal(summary([]), 'Pre-flight: nothing to check here');
  assert.match(summary([...ports, ...env]), /3 of 5 checks found a problem/);
  assert.equal(needsDocker({ from: 'compose.yaml', procs: [] }), true);
  assert.equal(needsDocker({ procs: [{ run: 'docker compose up db' }] }), true);
  assert.equal(needsDocker({ procs: [{ run: 'node x' }] }), false);
});

test('the facts, gathered from a project folder', async () => {
  const dir = project({ procs: {} }, {
    '.nvmrc': '18\n',
    '.env.example': 'A=1\nB=2\n',
    '.env': 'A=1\n',
    'package.json': JSON.stringify({ dependencies: { x: '1' } }),
    'package-lock.json': '{}',
    'appsettings.json': JSON.stringify({ ConnectionStrings: { Shop: 'Server=127.0.0.1,1;Database=Shop' } }),
  });
  try {
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', '.package-lock.json'), '{}');
    utimesSync(join(dir, 'node_modules', '.package-lock.json'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    assert.deepEqual(envFilesOf({ envFile: ['.env'], procs: [{ cwd: 'api', envFile: ['.env', '.env'] }] }, dir), [join(dir, '.env'), join(dir, 'api', '.env')]);
    const crew = { procs: [{ name: 'api', port: 4000, run: 'docker compose up api' }, { name: 'up', port: 4001 }] };
    const ran = [];
    const facts = await gatherFacts(dir, crew, {
      version: 'v22.1.0',
      running: ['up'],
      portOpen: async (port) => port === 4000,
      pidsOnPort: () => [77],
      run: async (cmd) => (ran.push(cmd), Promise.reject(new Error('Cannot connect to the Docker daemon'))),
      tcp: async () => false,
    });
    assert.deepEqual(ran, ['docker info']);
    const lines = runChecks(facts).map(checkLine);
    assert.deepEqual(lines, [
      '✗ Node 22.1.0 (.nvmrc asks for 18) — switch to it (nvm use, fnm use) or install it: the crew runs on the Node in your PATH',
      "✗ Docker doesn't answer — start Docker Desktop (or the docker service): the compose services need it (Cannot connect to the Docker daemon)",
      "✗ api's port 4000 is taken by process 77 — /free 4000 (or f on api) stops what holds it",
      '✗ .env lacks B, which .env.example has — add it to .env',
      "✗ Shop (sqlserver, from appsettings.json) doesn't answer at 127.0.0.1:1 — start it, or check appsettings.json",
      '✗ node_modules is older than package-lock.json — npm install: the dependencies changed since they were installed',
    ]);
    assert.deepEqual(Object.keys(await gatherFacts(dir, crew, { part: 'ports', portOpen: async () => false })), ['ports']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const holdPort = () =>
  new Promise((done) => {
    const s = createServer().listen(0, '127.0.0.1', () => done(s));
  });

test('before the crew starts, the checks go to the log; /preflight shows them in the viewer', async () => {
  const server = await holdPort();
  const { port } = server.address();
  const dir = project({ procs: { api: { run: 'node -e "setInterval(() => {}, 1000)"', port } } }, { '.env.example': 'TOKEN=\n' });
  const app = start({ dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Pre-flight: 2 of 2 checks found a problem'), 'the summary in the activity lines');
    await until(() => /api\s+running/.test(frame()), 'started all the same');
    app.stdin.write('/');
    await type(app.stdin, 'preflight');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('╭─ Pre-flight') && frame().includes("✗ .env isn't there, and .env.example is"), 'the checklist');
    assert.match(frame(), /│\s+copy \.env\.example to \.env and fill it in/, 'the hint under it');
    assert.doesNotMatch(frame(), /│ ✗ api's port/, 'a running process\'s port is its own');
  } finally {
    app.unmount();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
