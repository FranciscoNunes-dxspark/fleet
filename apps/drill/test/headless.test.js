// drill run and drill list over the demo: the text, the JSON an agent reads (fleet mcp), and the exit
// codes the family's checks use (0 passed, 1 failures, 2 couldn't run).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runHeadless } from '../src/headless.js';
import { demoDrill } from '../src/demo.js';
import { tempHome } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const dir = join(tmpdir(), 'shop');
async function headless(args, provider = demoDrill()) {
  let out = '';
  const code = await runHeadless(args, { provider, write: (s) => (out += s) });
  return { code, out, provider };
}

test('drill run: the failures first, each with its message, diff and frames, then the counts; exit 1', async () => {
  const { code, out } = await headless(['run', dir]);
  assert.equal(code, 1);
  assert.match(out, /^Vitest \(Vitest 3\): 3 failed · 5 passed · 1 skipped$/m);
  assert.match(out, /^FAIL src\/cart\.test\.ts:10 {2}cart › totals the lines$/m);
  assert.match(out, /^ {5}- 42\n {5}\+ 41\.99\n {5}at src\/cart\.test\.ts:12\n {5}at src\/cart\.ts:30 \(total\)$/m);
  assert.match(out, /^FAIL api\/Shop\.Tests\/CartTests\.cs:27 {2}Total_AppliesDiscount$/m);
  assert.match(out, /^5 failed · 8 passed · 1 skipped · 1 flaky in /m);
});

test('drill run --json: counts, runners, failures with expected and actual, the flaky ones', async () => {
  const { code, out } = await headless(['run', dir, '--json']);
  assert.equal(code, 1);
  const json = JSON.parse(out);
  assert.equal(json.app, 'drill');
  assert.equal(json.ok, false);
  assert.deepEqual(json.counts, { total: 14, passed: 8, failed: 5, skipped: 1, flaky: 1 });
  assert.deepEqual(json.runners.map((r) => [r.runner, r.ran, r.pin]), [['vitest', true, 'Vitest 3'], ['dotnet', true, 'dotnet test (TRX)'], ['playwright', true, 'Playwright 1.48']]);
  const f = json.failures.find((x) => x.name === 'pays with a card');
  assert.deepEqual([f.file, f.line, f.expected, f.actual], ['e2e/checkout.spec.ts', 10, '"Thank you"', '"Payment failed"']);
  assert.deepEqual(f.attachments.map((a) => a.name), ['screenshot', 'video', 'trace']);
  assert.deepEqual(json.failures[0].frames, [{ file: 'src/cart.test.ts', line: 12 }, { file: 'src/cart.ts', line: 30, method: 'total' }]);
  assert.equal(json.failures[0].diff, '-42\n+41.99');
  assert.deepEqual(json.flaky.map((x) => x.name), ['shows the basket']);
  assert.equal(json.tests, undefined);
  assert.equal(JSON.parse((await headless(['run', dir, '--json', '--all'])).out).tests.length, 14);
});

test('--fail-on: none never fails, not-flaky leaves out the tests known to be flaky', async () => {
  assert.equal((await headless(['run', dir, '--fail-on', 'none'])).code, 0);
  // The demo's flaky Vitest test fails on its first run only; the rest are fixed here.
  const provider = demoDrill();
  provider.state.fixed = new Set(['totals the lines', 'formats euros', 'pays with a card', 'Total_AppliesDiscount']);
  // Failed once and never passed: not known to be flaky, so it counts.
  assert.equal((await headless(['run', dir, '--fail-on', 'not-flaky'], provider)).code, 1);
  // Passes the second time.
  assert.equal((await headless(['run', dir], provider)).code, 0);
  // Failing again: known flaky now (failed, passed, failed), so not-flaky leaves it out; any doesn't.
  provider.state.runs.clear();
  assert.equal((await headless(['run', dir, '--fail-on', 'not-flaky'], provider)).code, 0);
  provider.state.runs.clear();
  assert.equal((await headless(['run', dir], provider)).code, 1);
});

test("exit 2 when it couldn't run: the app down, nothing found, a bad option", async () => {
  const provider = demoDrill();
  provider.state.appUp = false;
  provider.state.fixed = new Set(['totals the lines', 'formats euros', 'lists them', 'Total_AppliesDiscount']);
  const down = await headless(['run', dir, '--json'], provider);
  assert.equal(down.code, 2);
  const pw = JSON.parse(down.out).runners.find((r) => r.runner === 'playwright');
  assert.equal(pw.ran, false);
  assert.match(pw.error, /The app at http:\/\/localhost:5173 isn't answering/);
  const empty = demoDrill();
  empty.detect = async (root) => ({ root, suites: [], notes: ['No tests found: …'], config: null });
  assert.equal((await headless(['run', dir], empty)).code, 2);
  const bad = await headless(['run', '--fail-on', 'sometimes']);
  assert.deepEqual([bad.code, bad.out], [2, 'drill run: --fail-on is one of any, not-flaky, none\n']);
  assert.match(parseArgs(['run', '--runner', 'mocha']).error, /--runner is one of/);
});

test('--runner and --changed narrow the run; drill list says what was found', async () => {
  const only = await headless(['run', dir, '--runner', 'dotnet', '--json']);
  assert.deepEqual(JSON.parse(only.out).runners.map((r) => r.runner), ['dotnet']);
  const changed = await headless(['run', dir, '--changed', '--json']);
  const json = JSON.parse(changed.out);
  assert.equal(json.changed, '1 changed file, 2 test files touching them');
  assert.deepEqual(changed.provider.state.calls.filter((c) => c[0] === 'runSuite').map((c) => c[2]), [['src/cart.test.ts', 'src/price.test.ts']]);
  const list = await headless(['list', dir, '--json']);
  assert.equal(list.code, 0);
  assert.deepEqual(JSON.parse(list.out).suites.map((s) => s.id), ['vitest:.', 'playwright:.', 'dotnet:api/Shop.Tests:Shop.Tests.csproj']);
  assert.match((await headless(['list', dir])).out, /^Playwright +\. +1\.48\.2 +e2e against http:\/\/localhost:5173 +from package\.json$/m);
});
