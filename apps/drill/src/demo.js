// A made-up project with the provider's interface, for `drill --demo` and the tests: a Vitest suite,
// Playwright end-to-end tests and a .NET test project, some failing (a number off by a cent, a
// formatted price, a discount), one flaky (it fails the first time and passes after), a Playwright
// failure with its screenshot, trace and video. Nothing is read, run or asked. `state` is the tests'
// handle: what it holds and `calls`, what was asked of it.
import { join } from 'node:path';
import { makeFailure, makeTest } from './model.js';
import { buildCommand } from './runners.js';
import { parserFor } from './parsers/index.js';

const SUITES = (root) => [
  { id: 'vitest:.', runner: 'vitest', cwd: root, dir: '', exec: 'npx --no', version: '3.2.4', from: 'package.json' },
  { id: 'playwright:.', runner: 'playwright', cwd: root, dir: '', exec: 'npx --no', version: '1.48.2', url: 'http://localhost:5173', from: 'package.json' },
  { id: 'dotnet:api/Shop.Tests:Shop.Tests.csproj', runner: 'dotnet', cwd: join(root, 'api', 'Shop.Tests'), dir: 'api/Shop.Tests', target: 'Shop.Tests.csproj', exec: null, version: null, from: 'api/Shop.Tests/Shop.Tests.csproj' },
];

// Each test: where, its status, and for a failure what the runner said. `flaky` fails on its first run only.
const TESTS = [
  { suite: 'vitest:.', runner: 'vitest', file: 'src/cart.test.ts', path: ['cart'], name: 'totals the lines', line: 10, ms: 2.4, fail: { message: 'AssertionError: expected 41.99 to be 42 // Object.is equality', stack: '    at {root}/src/cart.test.ts:12:27\n    at total ({root}/src/cart.ts:30:10)\n    at file:///{root}/node_modules/@vitest/runner/dist/index.js:146:14' } },
  { suite: 'vitest:.', runner: 'vitest', file: 'src/cart.test.ts', path: ['cart'], name: 'is empty at first', line: 4, ms: 0.3 },
  { suite: 'vitest:.', runner: 'vitest', file: 'src/cart.test.ts', path: ['cart'], name: 'applies discounts', line: 16, skip: true },
  { suite: 'vitest:.', runner: 'vitest', file: 'src/price.test.ts', path: ['price'], name: 'formats euros', line: 6, ms: 1.9, fail: { message: "AssertionError: expected '12,00 €' to be '12.00 €' // Object.is equality", stack: '    at {root}/src/price.test.ts:7:33\n    at format ({root}/src/price.ts:21:11)' } },
  { suite: 'vitest:.', runner: 'vitest', file: 'src/price.test.ts', path: ['price'], name: 'rounds', line: 11, ms: 0.4 },
  { suite: 'vitest:.', runner: 'vitest', file: 'src/users.test.ts', path: ['users', 'find'], name: 'returns the user', line: 8, ms: 4.5 },
  { suite: 'vitest:.', runner: 'vitest', file: 'src/users.test.ts', path: ['users'], name: 'lists them', line: 20, ms: 0.9, flaky: { message: 'AssertionError: expected [ …(2) ] to have a length of 3 but got 2', stack: '    at {root}/src/users.test.ts:22:18' } },
  { suite: 'vitest:.', runner: 'vitest', file: 'src/slug.test.ts', path: ['slug'], name: 'lower-cases', line: 3, ms: 0.2 },
  { suite: 'vitest:.', runner: 'vitest', file: 'src/slug.test.ts', path: ['slug'], name: 'drops accents', line: 7, ms: 0.3 },
  { suite: 'playwright:.', runner: 'playwright', file: 'e2e/checkout.spec.ts', path: ['checkout'], name: 'pays with a card', line: 10, ms: 10315, fail: { message: 'Error: expect(locator).toHaveText(expected)\n\nLocator: getByRole(\'heading\')\nExpected string: "Thank you"\nReceived string: "Payment failed"', stack: '    at {root}/e2e/checkout.spec.ts:14:47' }, attachments: true },
  { suite: 'playwright:.', runner: 'playwright', file: 'e2e/checkout.spec.ts', path: ['checkout'], name: 'shows the basket', line: 5, ms: 3000, retried: true },
  { suite: 'playwright:.', runner: 'playwright', file: 'e2e/home.spec.ts', path: [], name: 'has a title', line: 3, ms: 640 },
  { suite: 'dotnet:api/Shop.Tests:Shop.Tests.csproj', runner: 'dotnet', file: 'Shop.Tests.CartTests', path: [], name: 'Total_AddsTheLines', fqn: 'Shop.Tests.CartTests.Total_AddsTheLines', ms: 12 },
  { suite: 'dotnet:api/Shop.Tests:Shop.Tests.csproj', runner: 'dotnet', file: 'Shop.Tests.CartTests', path: [], name: 'Total_AppliesDiscount', fqn: 'Shop.Tests.CartTests.Total_AppliesDiscount', ms: 46, fail: { message: 'Assert.Equal() Failure: Values differ\nExpected: 90\nActual:   100', stack: '   at Shop.Tests.CartTests.Total_AppliesDiscount() in {root}/api/Shop.Tests/CartTests.cs:line 27' } },
];

// The test files, for `c` (what touches what changed): their text says what they import.
const FILES = [
  { path: 'src/cart.test.ts', text: "import { total } from './cart';\nimport { format } from './price';\n" },
  { path: 'src/price.test.ts', text: "import { format } from './price';\n" },
  { path: 'src/users.test.ts', text: "import { find } from './users';\n" },
  { path: 'src/slug.test.ts', text: "import { slug } from './slug';\n" },
  { path: 'e2e/checkout.spec.ts', text: "import { test, expect } from '@playwright/test';\n" },
  { path: 'e2e/home.spec.ts', text: "import { test, expect } from '@playwright/test';\n" },
  { path: 'api/Shop.Tests/CartTests.cs', text: 'namespace Shop.Tests;\npublic class CartTests {\n  [Fact] public void Total_AppliesDiscount() { var cart = new Cart(); }\n}\n' },
];

const colour = (code, s) => `\x1b[${code}m${s}\x1b[0m`;

export function demoDrill() {
  const state = { calls: [], runs: new Map(), appUp: true, fixed: new Set(), changed: ['src/price.ts'], launched: [], history: { runs: [], tests: {} }, watch: null, written: new Map(), delay: 30 };
  const toTest = (d, root) => {
    const n = (state.runs.get(`${d.suite}|${d.name}`) ?? 0) + 1;
    state.runs.set(`${d.suite}|${d.name}`, n);
    const fix = (s) => s.replaceAll('{root}', root.replace(/\\/g, '/'));
    const id = { runner: d.runner, file: d.file, suite: d.path, name: d.name };
    const failing = (d.fail && !state.fixed.has(d.name)) || (d.flaky && n === 1 && !state.fixed.has(d.name));
    const what = d.fail ?? d.flaky;
    return makeTest({
      ...id,
      status: d.skip ? 'skipped' : failing ? 'failed' : 'passed',
      duration: d.skip ? 0 : d.ms,
      ...(d.line ? { line: d.line } : {}),
      ...(d.fqn ? { fqn: d.fqn } : {}),
      ...(d.retried ? { flaky: true, retries: 1 } : {}),
      ...(failing ? { failure: makeFailure({ message: what.message, stack: fix(what.stack), root }) } : {}),
      ...(failing && d.runner === 'dotnet' ? { line: 27, source: 'api/Shop.Tests/CartTests.cs' } : {}),
      ...(failing && d.attachments
        ? {
            attachments: ['screenshot:test-failed-1.png:image/png', 'video:video.webm:video/webm', 'trace:trace.zip:application/zip'].map((a) => {
              const [name, file, contentType] = a.split(':');
              return { name, path: join(root, 'test-results', 'checkout-pays-with-a-card-chromium', file), contentType };
            }),
          }
        : {}),
    });
  };

  return {
    state,
    async detect(root) {
      state.calls.push(['detect', root]);
      return { root, suites: SUITES(root), notes: [], config: null };
    },
    async runSuite(suite, { root, tests = null, files = null, signal, onData = () => {} } = {}) {
      state.calls.push(['runSuite', suite.id, tests ? tests.map((t) => t.name) : files ?? null]);
      const { command } = buildCommand(suite, { tests, files, out: join(root, '.drill-demo') });
      const parser = parserFor(suite.runner, suite.version);
      onData(`\x1b[2m$ ${command}\x1b[0m\r\n`);
      const mine = TESTS.filter((d) => d.suite === suite.id)
        .filter((d) => !tests || tests.some((t) => t.name === d.name && t.file === d.file))
        .filter((d) => !files || files.includes(d.file) || (d.fqn && files.some((f) => d.fqn.startsWith(`${f}.`))));
      await new Promise((r) => setTimeout(r, state.delay));
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      const out = mine.map((d) => toTest(d, root));
      for (const file of [...new Set(out.map((t) => t.file))]) {
        const these = out.filter((t) => t.file === file);
        const failed = these.filter((t) => t.status === 'failed').length;
        onData(`${failed ? colour(31, ' ❯') : colour(32, ' ✓')} ${file} ${colour(2, `(${these.length} tests${failed ? ` | ${colour(31, `${failed} failed`)}` : ''})`)}\r\n`);
        for (const t of these.filter((x) => x.status === 'failed')) onData(`   ${colour(31, '×')} ${[...t.suite, t.name].join(' > ')}\r\n`);
      }
      return { suite: suite.id, runner: suite.runner, dir: suite.dir, version: suite.version, pin: parser.pin, note: parser.note, command, exit: out.some((t) => t.status === 'failed') ? 1 : 0, duration: 120, ran: true, tests: out, errors: [] };
    },
    async appUp(url) {
      state.calls.push(['appUp', url]);
      return state.appUp ? { up: true, status: 200 } : { up: false, error: 'connection refused' };
    },
    async changed(root) {
      state.calls.push(['changed', root]);
      return { files: [...state.changed] };
    },
    async testFiles() {
      return FILES.map((f) => ({ ...f }));
    },
    watch(root, onChange) {
      state.calls.push(['watch', root]);
      state.watch = onChange;
      return () => {
        state.watch = null;
      };
    },
    async launch(command) {
      state.calls.push(['launch', command]);
      state.launched.push(command);
      return { stdout: '', stderr: '' };
    },
    async shell(command) {
      state.calls.push(['shell', command]);
      return { stdout: `(demo) ${command}`, stderr: '' };
    },
    exists: () => true,
    loadHistory: () => state.history,
    saveHistory: (root, h) => {
      state.history = h;
    },
    writeFile: (path, text) => state.written.set(path, text),
  };
}
