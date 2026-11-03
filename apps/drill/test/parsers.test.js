// Each runner's report as its versions write it (test/fixtures, one per pinned version), read into the
// tests every view shows: names, suites, files, statuses, durations, and a failure's message, expected
// and actual, diff and the project's own frames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVitest, parseJest } from '../src/parsers/jestlike.js';
import { parseSpec, parseTap } from '../src/parsers/nodetest.js';
import { parsePlaywright } from '../src/parsers/playwright.js';
import { parseTrx, parseXml, trxDuration } from '../src/parsers/trx.js';
import { parserFor } from '../src/parsers/index.js';
import { countTests, diffLines, expectedActual, makeFailure, parseFrames } from '../src/model.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const root = '/work/shop';
const byName = (r, name) => r.tests.find((t) => t.name === name);

test('Vitest 1: suites, statuses, the failure cut to its message and the project frames', () => {
  const r = parseVitest(fixture('vitest-1.json'), { root });
  assert.deepEqual(countTests(r.tests), { total: 5, passed: 2, failed: 2, skipped: 1, flaky: 0 });
  const t = byName(r, 'handles negatives');
  assert.equal(t.file, 'src/sum.test.ts');
  assert.deepEqual(t.suite, ['sum']);
  assert.equal(t.id, 'vitest:src/sum.test.ts:sum › handles negatives');
  assert.equal(t.failure.message, 'AssertionError: expected -4 to be -5 // Object.is equality');
  assert.deepEqual([t.failure.expected, t.failure.actual], ['-5', '-4']);
  assert.deepEqual(t.failure.diff, [{ kind: '-', text: '-5' }, { kind: '+', text: '-4' }]);
  // node_modules' frames are left out.
  assert.deepEqual(t.failure.frames.map((f) => `${f.file}:${f.line}`), ['src/sum.test.ts:9']);
  const u = byName(r, 'returns the user');
  assert.deepEqual(u.suite, ['users', 'find']);
  assert.deepEqual(u.failure.frames.map((f) => `${f.file}:${f.line}`), ['src/users.test.ts:14', 'src/testing/helpers.ts:3']);
  assert.equal(u.failure.expected, "{ id: 1, name: 'Ada Lovelace' }");
});

test('Vitest 2: the diff it wrote, todo as skipped, a file that failed to load as a failed test', () => {
  const r = parseVitest(fixture('vitest-2.json'), { root });
  const t = byName(r, 'totals the lines');
  assert.equal(t.line, 10);
  assert.deepEqual(t.failure.diff, [{ kind: '-', text: '42' }, { kind: '+', text: '41.99' }]);
  assert.equal(byName(r, 'applies discounts').status, 'skipped');
  const broken = r.tests.find((x) => x.file === 'src/broken.test.ts');
  assert.equal(broken.status, 'failed');
  assert.match(broken.failure.message, /Failed to load url \.\/missing\.js/);
});

test('Vitest 3: strings compared, tests outside a describe, locations', () => {
  const r = parseVitest(fixture('vitest-3.json'), { root });
  const t = byName(r, 'formats euros');
  assert.deepEqual([t.failure.expected, t.failure.actual], ["'12.00 €'", "'12,00 €'"]);
  assert.deepEqual(t.failure.frames.map((f) => f.file), ['src/price.test.ts', 'src/price.ts']);
  assert.deepEqual(byName(r, 'parses a price').suite, []);
  assert.equal(byName(r, 'rounds').line, 11);
});

test("Jest 29: the matcher's own expected and actual, colours stripped, pending as skipped", () => {
  const r = parseJest(fixture('jest-29.json'), { root });
  assert.deepEqual(countTests(r.tests), { total: 4, passed: 2, failed: 1, skipped: 1, flaky: 0 });
  const t = byName(r, 'counts the items');
  assert.deepEqual(t.suite, ['orders', 'total']);
  assert.deepEqual([t.failure.expected, t.failure.actual], ['5', '4']);
  assert.match(t.failure.message, /^Error: expect\(received\)\.toBe\(expected\) \/\/ Object\.is equality/);
  assert.doesNotMatch(t.failure.message, /\x1b/);
  assert.deepEqual(t.failure.frames.map((f) => `${f.file}:${f.line}`), ['src/orders.test.js:9']);
  assert.equal(byName(r, 'ships abroad').status, 'skipped');
});

test("Jest 30: an object's diff as Jest wrote it, locations, a retried pass as flaky", () => {
  const r = parseJest(fixture('jest-30.json'), { root });
  const t = byName(r, 'keeps every role');
  assert.equal(t.line, 12);
  assert.ok(t.failure.diff.some((d) => d.kind === '-' && d.text.includes('"billing"')));
  assert.ok(t.failure.diff.some((d) => d.kind === ' ' && d.text.includes('"admin"')));
  assert.deepEqual(t.failure.frames.map((f) => `${f.file}:${f.line}`), ['src/profile.test.js:15', 'src/profile.js:40']);
  assert.equal(byName(r, 'has a name').flaky, true);
  assert.equal(byName(r, 'uploads an avatar').status, 'skipped');
});

test("node:test 22's TAP: nested suites, skips, expected and actual, file URLs in the stack", () => {
  const r = parseTap(fixture('node-22.tap'), { root });
  assert.deepEqual(countTests(r.tests), { total: 5, passed: 2, failed: 2, skipped: 1, flaky: 0 });
  const t = byName(r, 'drops accents');
  assert.equal(t.file, 'test/slug.test.js');
  assert.deepEqual(t.suite, ['slug']);
  assert.equal(t.line, 10);
  assert.equal(t.duration, 1.204);
  assert.match(t.failure.message, /^AssertionError: Expected values to be strictly equal/);
  assert.deepEqual([t.failure.expected, t.failure.actual], ['café-crème', 'cafe-creme']);
  assert.deepEqual(t.failure.frames.map((f) => `${f.file}:${f.line}`), ['test/slug.test.js:11']);
  assert.equal(byName(r, 'handles emoji # signs').status, 'skipped');
  const s = byName(r, 'parses settings');
  assert.equal(s.file, 'test/settings.test.js');
  assert.deepEqual(s.failure.diff, [{ kind: '-', text: 'port: 8080' }, { kind: '+', text: 'port: 80' }]);
  assert.equal(byName(r, 'reads the defaults').file, 'test/settings.test.js');
});

test("node:test 22's spec output: the tree from the marks, the failure from the part at the end", () => {
  const r = parseSpec(fixture('node-22.spec.txt'), { root });
  assert.deepEqual(r.tests.map((t) => [t.suite.join('/'), t.name, t.status]), [
    ['slug', 'lower-cases', 'passed'],
    ['slug', 'drops accents', 'failed'],
    ['slug', 'handles emoji # signs', 'skipped'],
    ['', 'reads the defaults', 'passed'],
  ]);
  const t = byName(r, 'drops accents');
  assert.equal(t.file, 'test/slug.test.js');
  assert.equal(t.line, 10);
  assert.deepEqual([t.failure.expected, t.failure.actual], ['café-crème', 'cafe-creme']);
  assert.match(t.failure.message, /'cafe-creme' !== 'café-crème'/);
  assert.deepEqual(t.failure.frames.map((f) => `${f.file}:${f.line}`), ['test/slug.test.js:11']);
});

test("Playwright 1.4x: retries, flaky, the last try's attachments, the error's location", () => {
  const r = parsePlaywright(fixture('playwright-1.4x.json'), { root });
  assert.deepEqual(countTests(r.tests), { total: 4, passed: 2, failed: 1, skipped: 1, flaky: 1 });
  const t = byName(r, 'pays with a card');
  assert.equal(t.file, 'e2e/checkout.spec.ts');
  assert.deepEqual(t.suite, ['checkout']);
  assert.equal(t.line, 10);
  assert.equal(t.duration, 10315);
  assert.deepEqual([t.failure.expected, t.failure.actual], ['"Thank you"', '"Payment failed"']);
  assert.deepEqual(t.failure.location, { file: 'e2e/checkout.spec.ts', line: 14 });
  assert.deepEqual(t.attachments.map((a) => a.name), ['screenshot', 'video', 'trace']);
  assert.match(t.attachments[2].path, /retry1\/trace\.zip$/);
  const f = byName(r, 'shows the basket');
  assert.deepEqual([f.status, f.flaky, f.retries], ['passed', true, 1]);
  assert.equal(byName(r, 'signs in with SSO').status, 'skipped');
});

test("TRX from xUnit: classes as files, a theory's cases apart, the filter's name, Values differ", () => {
  const r = parseTrx(fixture('xunit.trx'), { root });
  assert.deepEqual(countTests(r.tests), { total: 5, passed: 2, failed: 2, skipped: 1, flaky: 0 });
  const t = byName(r, 'Total_AppliesDiscount');
  assert.equal(t.file, 'Shop.Tests.CartTests');
  assert.equal(t.fqn, 'Shop.Tests.CartTests.Total_AppliesDiscount');
  assert.equal(t.duration, 46);
  assert.deepEqual([t.failure.expected, t.failure.actual], ['90', '100']);
  assert.deepEqual(t.failure.frames.map((f) => `${f.file}:${f.line}`), ['tests/Shop.Tests/CartTests.cs:27']);
  assert.deepEqual([t.source, t.line], ['tests/Shop.Tests/CartTests.cs', 27]);
  const cases = r.tests.filter((x) => x.name.startsWith('Format('));
  assert.equal(cases.length, 2);
  assert.equal(cases[1].fqn, 'Shop.Tests.PriceTests.Format');
  assert.equal(cases[1].name, 'Format(amount: 0, expected: "0,00 €")');
  assert.deepEqual(cases[1].failure.frames.map((f) => f.file), ['src/Shop/Price.cs', 'tests/Shop.Tests/PriceTests.cs']);
  assert.equal(byName(r, 'Rounds').status, 'skipped');
});

test("TRX from NUnit and MSTest: But was, Expected:<…> Actual:<…>, a timeout as a failure", () => {
  const n = parseTrx(fixture('nunit.trx'), {});
  const t = byName(n, 'ParsesAnOrder');
  assert.equal(t.file, 'Orders.Tests.OrderParserTests');
  assert.deepEqual([t.failure.expected, t.failure.actual], ['3', '2']);
  assert.match(t.failure.frames[0].file, /OrderParserTests\.cs$/);
  assert.equal(t.failure.frames[0].line, 22);
  const m = parseTrx(fixture('mstest.trx'), { root: '/work/mail' });
  assert.deepEqual([byName(m, 'SendsTheReceipt').failure.expected, byName(m, 'SendsTheReceipt').failure.actual], ['sent', 'queued']);
  assert.equal(byName(m, 'SendsTheReceipt').source, 'Mail.Tests/ReceiptTests.cs');
  assert.equal(byName(m, 'TimesOut').status, 'failed');
  assert.equal(byName(m, 'TimesOut').duration, 5000);
  assert.equal(byName(m, 'FormatsTheSubject').file, 'Mail.Tests.SubjectTests');
});

test('the XML reader: entities, CDATA, namespaces, self-closing elements', () => {
  const doc = parseXml('<?xml version="1.0"?><a:r xmlns:a="x"><b k="1 &amp; 2"/><c><![CDATA[<raw>]]> &lt;t&gt;</c></a:r>');
  const r = doc.children[0];
  assert.equal(r.name, 'r');
  assert.equal(r.children[0].attrs.k, '1 & 2');
  assert.equal(r.children[1].text, '<raw> <t>');
  assert.equal(trxDuration('00:01:02.5'), 62500);
});

test('parsers are pinned by version: a version outside them is read as the nearest and said', () => {
  assert.equal(parserFor('vitest', '2.1.8').pin, 'Vitest 2');
  assert.equal(parserFor('vitest', '2.1.8').note, null);
  assert.match(parserFor('vitest', '4.0.1').note, /Vitest 4\.0\.1 is newer than the Vitest 3 Drill knows/);
  assert.match(parserFor('jest', '27.5.1').note, /older than the Jest 29/);
  assert.equal(parserFor('jest', '30.0.0').pin, 'Jest 30');
  assert.equal(parserFor('node', '22.11.0').pin, 'node --test 22');
  assert.equal(parserFor('playwright', '1.48.2').pin, 'Playwright 1.48');
  assert.equal(parserFor('playwright', '1.55.0').note, null);
  assert.match(parserFor('playwright', '1.30.0').note, /older/);
  assert.equal(parserFor('dotnet', null).pin, 'dotnet test (TRX)');
  assert.match(parserFor('vitest', null).note, /Couldn't tell which Vitest/);
});

test('frames, expected and actual, and a diff, from what the runners write', () => {
  assert.deepEqual(parseFrames('    at Object.<anonymous> (C:\\w\\a.test.js:3:9)\n    at async run (file:///home/x/b.js:1:2)\n   at N.C.M() in /s/C.cs:line 4'), [
    { method: 'Object.<anonymous>', file: 'C:\\w\\a.test.js', line: 3, column: 9 },
    { method: 'run', file: '/home/x/b.js', line: 1, column: 2 },
    { method: 'N.C.M()', file: '/s/C.cs', line: 4 },
  ]);
  assert.deepEqual(expectedActual('Expected: 5\nReceived: 4'), { expected: '5', actual: '4' });
  assert.deepEqual(expectedActual('  Expected: "a"\n  But was:  "b"'), { expected: '"a"', actual: '"b"' });
  assert.equal(expectedActual('Something broke'), null);
  assert.deepEqual(diffLines('a\nb\nc', 'a\nx\nc'), [
    { kind: ' ', text: 'a' },
    { kind: '-', text: 'b' },
    { kind: '+', text: 'x' },
    { kind: ' ', text: 'c' },
  ]);
  const f = makeFailure({ message: 'boom', expected: { a: 1 }, actual: { a: 2 } });
  assert.deepEqual(f.diff.filter((d) => d.kind !== ' '), [{ kind: '-', text: '  "a": 1' }, { kind: '+', text: '  "a": 2' }]);
});
