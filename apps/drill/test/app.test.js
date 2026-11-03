// End to end: App over the demo project, typing keys and reading the frame.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';
import { stripAnsi } from '../src/model.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const failuresShown = (app) => until(shows(app, 'totals the lines'), 'the failures');

test('it finds the suites and runs them on opening: the failures first, the counts in the header', async () => {
  const app = start();
  await failuresShown(app);
  await until(shows(app, '5 failed'), 'the counts');
  // esc puts the welcome box and the activity lines away, for room.
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Welcome to Drill'), 'the room');
  const frame = app.lastFrame();
  assert.match(frame, /14 tests {2}5 failed {2}8 passed {2}1 skipped/);
  assert.match(frame, /1 Failures 5/);
  // Unit tests first, the .NET project next, the end-to-end tests last, once the app answered.
  assert.deepEqual(app.provider.state.calls.filter((c) => c[0] === 'runSuite' || c[0] === 'appUp').map((c) => c[1]), ['vitest:.', 'dotnet:api/Shop.Tests:Shop.Tests.csproj', 'http://localhost:5173', 'playwright:.']);
  // The first failure, shown under the list: its message, the diff, the project's frames.
  assert.match(frame, /AssertionError: expected 41\.99 to be 42/);
  assert.match(frame, /- 42/);
  assert.match(frame, /\+ 41\.99/);
  assert.match(frame, /src\/cart\.test\.ts:12/);
  assert.match(frame, /src\/cart\.ts:30 {2}total/);
  assert.doesNotMatch(frame, /node_modules/);
  app.unmount();
});

test('↵ goes into a failure; ↵ on a frame opens its file at its line in the editor', async () => {
  const app = start();
  await failuresShown(app);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'j k frames'), 'the failure focused');
  app.stdin.write('j');
  await new Promise((r) => setTimeout(r, 100));
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.launched.length === 1, 'the editor');
  assert.match(app.provider.state.launched[0], /^'code' -g '.*[\\/]shop[\\/]src[\\/]cart\.ts:30:10'$/);
  assert.match(app.lastFrame(), /Opening src\/cart\.ts:30 in code/);
  app.stdin.write('h');
  await until(shows(app, '↵ into it'), 'back on the list');
  app.unmount();
});

test('a terminal editor gets its command copied, as it needs the terminal Drill draws on', async () => {
  const app = start({ config: { history: [], editor: 'nvim' } });
  await failuresShown(app);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'j k frames'), 'the failure focused');
  app.stdin.write(KEYS.enter);
  await until(() => app.copied.length === 1, 'the copy');
  assert.match(app.copied[0], /^'nvim' \+12 '.*cart\.test\.ts'$/);
  assert.equal(app.provider.state.launched.length, 0);
  app.unmount();
});

test('r runs the test under the cursor again; alt+r runs every failed one, and the flaky one passes', async () => {
  const app = start();
  await failuresShown(app);
  await until(shows(app, '5 failed'), 'the counts');
  app.stdin.write('r');
  await until(() => app.provider.state.calls.filter((c) => c[0] === 'runSuite').length === 4, 'the re-run');
  assert.deepEqual(app.provider.state.calls.at(-1), ['runSuite', 'vitest:.', ['totals the lines']]);
  await until(shows(app, 'Run cart › totals the lines'), 'its line');
  app.stdin.write('\x1br');
  await until(shows(app, 'Run the 5 failed tests again'), 'the failed run');
  await until(shows(app, '4 failed'), 'the flaky one passing');
  // Only the failed ones ran, each by its own runner: names for Vitest, the full name for .NET, file:line for Playwright.
  const runs = app.provider.state.calls.filter((c) => c[0] === 'runSuite').slice(4);
  assert.deepEqual(runs.map((c) => c[1]), ['vitest:.', 'dotnet:api/Shop.Tests:Shop.Tests.csproj', 'playwright:.']);
  assert.deepEqual(runs[0][2], ['totals the lines', 'formats euros', 'lists them']);
  // The flaky one both failed and passed: the Flaky view has it.
  assert.match(app.lastFrame(), /3 Flaky 2/);
  app.stdin.write('3');
  await until(shows(app, 'users › lists them'), 'the Flaky view');
  assert.match(app.lastFrame(), /✗✓ +1\/2/);
  app.unmount();
});

test('the Tree: files, suites, tests with their marks; f keeps the failures; ↵ on a failed test opens it', async () => {
  const app = start();
  await failuresShown(app);
  app.stdin.write(KEYS.esc);
  app.stdin.write('2');
  await until(shows(app, '▾ src/cart.test.ts'), 'the tree');
  let frame = app.lastFrame();
  assert.match(frame, /src\/cart\.test\.ts +Vitest +1✗ 1✓ 1○/);
  assert.match(frame, /▾ cart/);
  assert.match(frame, /✓ is empty at first/);
  // At the bottom, Playwright's: a test that passed on a retry.
  app.stdin.write('\x1bg');
  await until(shows(app, '↻ shows the basket'), 'the bottom');
  app.stdin.write('g');
  await until(shows(app, '▾ src/cart.test.ts'), 'the top');
  app.stdin.write('f');
  await until(() => !app.lastFrame().includes('is empty at first'), 'failures only');
  frame = app.lastFrame();
  assert.match(frame, /failures only/);
  assert.match(frame, /✗ totals the lines/);
  assert.doesNotMatch(frame, /src\/slug\.test\.ts/);
  // Down to "formats euros", and ↵ opens it in the Failures view.
  for (let i = 0; i < 5 && !/❯ .*formats euros/.test(app.lastFrame()); i++) {
    app.stdin.write('j');
    await new Promise((r) => setTimeout(r, 60));
  }
  app.stdin.write(KEYS.enter);
  await until(shows(app, "expected '12,00 €' to be '12.00 €'"), 'the failure');
  assert.match(app.lastFrame(), /❯ ✗ price › formats euros/);
  app.unmount();
});

test('o opens a Playwright failure\'s trace; its screenshot, video and trace are listed', async () => {
  const app = start();
  await failuresShown(app);
  for (let i = 0; i < 6 && !/❯ ✗ checkout › pays with a card/.test(app.lastFrame()); i++) {
    app.stdin.write('j');
    await new Promise((r) => setTimeout(r, 60));
  }
  app.stdin.write(KEYS.esc);
  await until(shows(app, 'Expected string: "Thank you"'), 'the failure');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'j k frames'), 'the failure focused');
  app.stdin.write('\x1bg');
  await until(shows(app, 'Screenshot'), 'the attachments');
  assert.match(app.lastFrame(), /❯ Trace +.*trace\.zip {2}o opens it/);
  app.stdin.write('o');
  await until(() => app.provider.state.launched.length === 1, 'the trace viewer');
  assert.match(app.provider.state.launched[0], /^npx --no playwright show-trace '.*trace\.zip'$/);
  app.unmount();
});

test("end-to-end tests wait when the app isn't up, saying what Bosun says", async () => {
  const { demoDrill } = await import('../src/demo.js');
  const { writeMood } = await import('@fleet/kit/family.js');
  writeMood('bosun', { mood: 'neutral', reason: 'nothing running' });
  const provider = demoDrill();
  provider.state.appUp = false;
  const app = start({ provider });
  await until(shows(app, "couldn't run"), 'the note');
  const frame = app.lastFrame();
  assert.match(frame, /Playwright couldn't run/);
  assert.match(frame, /The app at http:\/\/localhost:5173 isn't answering \(connection refused\)/);
  assert.ok(!provider.state.calls.some((c) => c[0] === 'runSuite' && c[1] === 'playwright:.'));
  app.stdin.write('5');
  await until(shows(app, 'Log'), 'the log');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Bosun is neutral: nothing running'), "Bosun's word");
  app.unmount();
});

test('c runs only the tests touching what git says changed', async () => {
  const app = start();
  await failuresShown(app);
  await until(shows(app, '5 failed'), 'the first run');
  app.stdin.write('c');
  await until(shows(app, 'Run the tests touching src/price.ts (2 test files)'), 'the changed run');
  const last = app.provider.state.calls.filter((c) => c[0] === 'runSuite').at(-1);
  assert.deepEqual(last, ['runSuite', 'vitest:.', ['src/cart.test.ts', 'src/price.test.ts']]);
  app.unmount();
});

test('w watches: a saved file runs the tests touching it; w again stops', async () => {
  const app = start();
  await failuresShown(app);
  await until(shows(app, '5 failed'), 'the first run');
  app.stdin.write('w');
  await until(shows(app, '● watching'), 'watching');
  assert.ok(app.provider.state.watch);
  const before = app.provider.state.calls.filter((c) => c[0] === 'runSuite').length;
  app.provider.state.watch(['src/slug.test.ts']);
  await until(() => app.provider.state.calls.filter((c) => c[0] === 'runSuite').length === before + 1, 'the run');
  assert.deepEqual(app.provider.state.calls.filter((c) => c[0] === 'runSuite').at(-1), ['runSuite', 'vitest:.', ['src/slug.test.ts']]);
  app.stdin.write('w');
  await until(() => !app.lastFrame().includes('● watching'), 'stopped');
  assert.equal(app.provider.state.watch, null);
  app.unmount();
});

test("the Output view draws the runners' own output through the virtual terminal", async () => {
  const app = start();
  await failuresShown(app);
  app.stdin.write('4');
  // The rows are the virtual terminal's, colours and all: compared without them.
  const plain = () => stripAnsi(app.lastFrame());
  // The end of it: Playwright's, which ran last.
  await until(() => plain().includes('× checkout > pays with a card'), 'the output');
  assert.match(plain(), /\$ npx --no playwright test --reporter=list,json/);
  assert.match(app.lastFrame(), /\x1b\[[\d;]*31m ❯/);
  // Its start, looking back.
  app.stdin.write('g');
  await until(() => plain().includes('$ npx --no vitest run --reporter=default --reporter=json'), 'the start');
  assert.match(plain(), /× cart > totals the lines/);
  app.unmount();
});

test('/run with part of a name runs the tests matching it; /runners says how each suite runs', async () => {
  const app = start();
  await failuresShown(app);
  await until(shows(app, '5 failed'), 'the first run');
  await type(app.stdin, '/run euros');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.at(-1)?.[2]?.[0] === 'formats euros', 'the run');
  await type(app.stdin, '/runners');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'read as Vitest 3'), 'the runners');
  assert.match(app.lastFrame(), /e2e against http:\/\/localhost:5173/);
  app.unmount();
});
