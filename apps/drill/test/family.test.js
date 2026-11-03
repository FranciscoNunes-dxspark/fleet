// Drill in the family (family.js): its names, the test context it hands Splice and takes back, its mood,
// the activity it adds, and the project's environment.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { APP_NAMES, FAMILY, PET_NAMES, ROLES, TAKEN_BY, contextIn, encodeContext, readActivity } from '@fleet/kit/family.js';
import { currentEnvironment } from '@fleet/kit/environments.js';
import { recordedLines, startRecording } from '@fleet/kit/recording.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';
import { familyMood, reactionTo } from '../src/moods.js';
import { findTest, testContext } from '../src/share.js';
import { makeFailure, makeTest } from '../src/model.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

test('Drill is in the family, with its names; Splice and Drill take a test', () => {
  assert.ok(FAMILY.includes('drill'));
  assert.deepEqual([APP_NAMES.drill, PET_NAMES.drill, ROLES.drill], ['Drill', 'Peck', 'TESTS']);
  assert.deepEqual(TAKEN_BY.test, ['splice', 'drill']);
});

test("Peck's mood: failing tests worry it, a run all passed makes it happy", () => {
  const run = (c) => ({ counts: { total: 10, passed: 10, failed: 0, skipped: 0, flaky: 0, ...c } });
  assert.deepEqual(familyMood({ mood: 'worried', run: run({ failed: 2, passed: 8 }) }), { mood: 'worried', reason: '2 tests failing' });
  assert.deepEqual(familyMood({ mood: 'wave', run: run({}) }), { mood: 'happy', reason: 'all 10 passing' });
  assert.equal(familyMood({ mood: 'sleep', run: null }).reason, 'not run yet');
  assert.equal(familyMood({ mood: 'look', run: null, busy: { label: 'Running tests' } }).mood, 'busy');
  const said = reactionTo([{ app: 'bosun', mood: 'worried', reason: 'api crashed', at: 5 }]);
  assert.match(said.text, /Peck stops tapping: Bosun is worried \(api crashed\)/);
});

test("a failure's context: the file and the line it broke at, its name, the message's first line", () => {
  const t = makeTest({ runner: 'vitest', file: 'src/cart.test.ts', suite: ['cart'], name: 'totals', status: 'failed', line: 10, failure: makeFailure({ message: 'AssertionError: expected 1 to be 2\nmore', stack: '    at /p/src/cart.ts:30:1\n    at /p/src/cart.test.ts:12:3', root: '/p' }) });
  assert.deepEqual(testContext(t), { file: 'src/cart.test.ts', line: 12, name: 'cart › totals', message: 'AssertionError: expected 1 to be 2', runner: 'vitest' });
  // A .NET test's file is its first own frame's, as TRX names only the class.
  const d = makeTest({ runner: 'dotnet', file: 'Shop.Tests.CartTests', name: 'Total', status: 'failed', failure: makeFailure({ message: 'x', stack: '   at A.B() in /p/tests/CartTests.cs:line 27', root: '/p' }) });
  assert.deepEqual(testContext(d), { file: 'tests/CartTests.cs', line: 27, name: 'Total', message: 'x', runner: 'dotnet' });
  assert.equal(findTest([t, d], { file: 'src/cart.test.ts', name: 'cart › totals' }), t);
  assert.equal(findTest([t, d], { name: 'Total' }), d);
});

test("t on a failure copies a test context for Splice; the run goes in the family's activity log", async () => {
  const app = start();
  await until(shows(app, 'totals the lines'), 'the failures');
  app.stdin.write('t');
  await until(() => app.copied.length === 1, 'the copy');
  assert.deepEqual(contextIn(app.copied[0]), { kind: 'test', data: { file: 'src/cart.test.ts', line: 12, name: 'cart › totals the lines', message: 'AssertionError: expected 41.99 to be 42 // Object.is equality', runner: 'vitest' } });
  assert.match(app.lastFrame(), /Copied for Splice/);
  await until(() => readActivity().some((e) => e.app === 'drill'), 'the activity');
  assert.match(readActivity().find((e) => e.app === 'drill').text, /Ran 14 tests in shop: 5 failed · 8 passed · 1 skipped · 1 flaky/);
  app.unmount();
});

test('/take of a test context runs that test again; any other context says whose it is', async () => {
  const app = start();
  await until(shows(app, '5 failed'), 'the first run');
  const line = encodeContext('test', { file: 'src/price.test.ts', line: 7, name: 'price › formats euros' });
  // While Fleet records a runbook, the line is kept.
  startRecording(join(process.env.DRILL_HOME, 'shop'));
  await type(app.stdin, `/take ${line}`);
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.at(-1)?.[2]?.[0] === 'formats euros', 'the run');
  assert.deepEqual(app.provider.state.calls.at(-1), ['runSuite', 'vitest:.', ['formats euros']]);
  await until(() => recordedLines().length === 1, 'the recorded line');
  assert.deepEqual(recordedLines().map((l) => [l.app, l.line]), [['drill', `/take ${line}`]]);
  await type(app.stdin, '/take family:v1:commit:eyJoYXNoIjoiYWJjIn0');
  app.stdin.write(KEYS.enter);
  await until(shows(app, "That's commit abc, for Splice or Sonar or Keel"), 'the answer');
  app.unmount();
});

/** A project folder naming dev and prod in .fleet/project.json, under the temporary home. */
function projectWithEnvs() {
  const dir = join(process.env.DRILL_HOME, 'proj');
  mkdirSync(join(dir, '.fleet'), { recursive: true });
  writeFileSync(join(dir, '.fleet', 'project.json'), JSON.stringify({ environments: { dev: {}, prod: { prod: true } } }));
  return dir;
}

test('/env switches the project for every app; the header names it', async () => {
  const dir = projectWithEnvs();
  const app = start({ cwd: dir });
  await until(shows(app, '5 failed'), 'the first run');
  await type(app.stdin, '/env prod');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'prod (production)'), 'the header');
  assert.equal(currentEnvironment(dir).name, 'prod');
  app.unmount();
});
