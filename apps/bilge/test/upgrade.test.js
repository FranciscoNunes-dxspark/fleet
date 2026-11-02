// /upgrade: what fits and how it's run (pure), and the whole of it over the demo, whose git and tests are make-believe.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { KEYS, start, tempHome, type, until } from './helpers.js';
import { branchName, testPlan } from '../src/upgrade.js';
import { demoBilge } from '../src/demo.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);
const runs = (app) => app.provider.state.calls.filter((c) => c[0] === 'run').map((c) => c[1]);

test("the branch is the day's, and the tests are each manifest's: a package.json's script, a .sln at or above a project", () => {
  assert.equal(branchName(new Date(2026, 10, 2, 23, 59)), 'bilge/updates-2026-11-02');
  const root = join('/', 'repo');
  const files = {
    [join(root, 'web', 'package.json')]: { scripts: { test: 'vitest run' } },
    [join(root, 'old', 'package.json')]: { scripts: { test: 'echo "Error: no test specified" && exit 1' } },
    [join(root, 'site', 'package.json')]: { scripts: { test: 'jest' } },
  };
  const folders = { [root]: ['Shop.sln', 'README.md'] };
  const plan = testPlan(
    [
      { ecosystem: 'npm', dir: join(root, 'web') },
      { ecosystem: 'npm', dir: join(root, 'old') },
      { ecosystem: 'npm', tool: 'pnpm', dir: join(root, 'site') },
      { ecosystem: 'NuGet', dir: join(root, 'src', 'Api'), project: join(root, 'src', 'Api', 'Api.csproj') },
      { ecosystem: 'NuGet', dir: join(root, 'src', 'Worker'), project: join(root, 'src', 'Worker', 'Worker.csproj') },
    ],
    root,
    { readJson: (f) => files[f] ?? null, list: (d) => folders[d] ?? [] },
  );
  assert.deepEqual(plan, [
    { command: 'npm test', cwd: join(root, 'web') },
    { command: 'pnpm test', cwd: join(root, 'site') },
    { command: 'dotnet test "Shop.sln"', cwd: root },
  ]);
  const alone = testPlan([{ ecosystem: 'NuGet', dir: join(root, 'Api'), project: join(root, 'Api', 'Api.csproj') }], root, { readJson: () => null, list: () => [] });
  assert.deepEqual(alone, [{ command: 'dotnet test "Api.csproj"', cwd: join(root, 'Api') }]);
});

test('/upgrade asks the registries first, lists what fits in one question, then branches, updates, tests, commits and hands Splice the branch', async () => {
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  await type(app.stdin, '/upgrade');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Update 8 packages on a branch of their own'), 'the question');
  assert.ok(app.provider.state.calls.some((c) => c[0] === 'latest'), '/outdated was asked first');
  // The newest that fits where the newest doesn't: express 4.21.2 (5 wants Node 18), SqlClient 5.2.3 (6 isn't built for net6.0).
  assert.match(app.lastFrame(), /express 4\.17\.1 → 4\.21\.2 \(the newest that fits\)/);
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.commits?.length === 1, 'the commit');
  const branch = branchName();
  assert.deepEqual(runs(app), [
    'git status --porcelain',
    `git checkout -b ${branch}`,
    'npm install express@4.21.2',
    'npm install jsonwebtoken@9.0.2',
    'npm install lodash@4.17.21',
    'dotnet add "Api.csproj" package Microsoft.Data.SqlClient --version 5.2.3',
    'dotnet add "Api.csproj" package Newtonsoft.Json --version 13.0.4',
    'npm install react@19.1.0',
    'dotnet add "Api.csproj" package Serilog --version 4.3.0',
    'npm install typescript@5.9.3 --save-dev',
    'npm test',
    'dotnet test "Api.csproj"',
    'git add -A',
    'git commit -m "Update 8 packages"',
  ]);
  assert.equal(app.provider.state.calls.find((c) => c[1] === 'dotnet test "Api.csproj"')[2], join(app.provider.state.manifests[1].dir));
  await until(shows(app, 'Copied for Splice'), 'the hand-off');
  assert.equal(app.copied.at(-1), `/checkout ${branch}`);
  assert.match(app.lastFrame(), new RegExp(`Update 8 packages on ${branch}`));
  assert.match(app.lastFrame(), /✓ npm test/);
  app.unmount();
});

test('/upgrade stops on a working tree with changes, and on a failing test, saying which step; the commands can be copied instead', async () => {
  const provider = demoBilge();
  provider.state.dirty = ' M package.json\n';
  const app = start({ provider });
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  await type(app.stdin, '/upgrade');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Update 8 packages'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'The working tree has changes'), 'the refusal');
  assert.deepEqual(runs(app), ['git status --porcelain']);

  provider.state.dirty = '';
  provider.state.failing = 'npm test';
  await type(app.stdin, '/upgrade');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Update 8 packages'), 'the question again');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Upgrade stopped: npm test failed'), 'the stop');
  assert.match(app.lastFrame(), /✗ npm test/);
  assert.ok(!provider.state.commits, 'nothing committed');
  assert.ok(!runs(app).some((c) => c.startsWith('dotnet test')), 'nothing after the failed step');
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Upgrade stopped'), 'the view again');

  await type(app.stdin, '/upgrade');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Update 8 packages on a branch'), 'the question once more');
  app.stdin.write('2');
  await until(() => app.copied.length === 1, 'the copy');
  assert.match(app.copied[0], /^# in \.\nnpm install express@/);
  assert.match(app.copied[0], /# in src\/Api\ndotnet add "Api\.csproj" package/);
  app.unmount();
});
