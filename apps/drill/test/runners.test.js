// Finding the suites (detect.js), the command lines they run with (runners.js), changed files to tests
// (changed.js), the flaky history (flaky.js), the editor's command (editor.js), the app's check (e2e.js),
// and the provider running a suite through a stand-in for run.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { detect, nodeTestArgs, playwrightUrl, readDrillJson } from '../src/detect.js';
import { buildCommand, namePattern, safeFile } from '../src/runners.js';
import { classesIn, importsOf, isTestFile, parsePorcelain, testsTouching } from '../src/changed.js';
import { flakyTests, historyFile, loadHistory, recordRun, saveHistory } from '../src/flaky.js';
import { editorCommand, editorSetting } from '../src/editor.js';
import { appDown, checkApp } from '../src/e2e.js';
import { createDrill } from '../src/provider.js';
import { filesBySuiteOf, mergeTests } from '../src/session.js';
import { makeTest } from '../src/model.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** A file system of `files` ({ 'path/under/root': text }) under `root`, as detect.js reads one. */
function memoryFs(root, files) {
  const abs = Object.fromEntries(Object.entries(files).map(([p, t]) => [join(root, ...p.split('/')), t]));
  return {
    read: (p) => abs[p] ?? null,
    list: (d) => {
      const prefix = d.endsWith(sep) ? d : d + sep;
      const out = new Map();
      for (const p of Object.keys(abs)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length).split(sep);
        out.set(rest[0], { name: rest[0], dir: rest.length > 1 });
      }
      return [...out.values()];
    },
  };
}

const root = join(tmpdir(), 'proj');

test('detect: Vitest, Jest, node --test and Playwright from package.json, versions from node_modules, the e2e address from the config', () => {
  const fs = memoryFs(root, {
    'package.json': JSON.stringify({ scripts: { test: 'vitest run', 'test:node': 'node --test test/ --test-concurrency=1', e2e: 'playwright test' }, devDependencies: { vitest: '^3.2.0', '@playwright/test': '^1.48.0' } }),
    'package-lock.json': '{}',
    'node_modules/vitest/package.json': '{"version":"3.2.4"}',
    'node_modules/@playwright/test/package.json': '{"version":"1.48.2"}',
    'playwright.config.ts': "export default defineConfig({ use: { baseURL: process.env.BASE_URL ?? 'http://localhost:5173' }, webServer: { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: true } });",
    'legacy/package.json': JSON.stringify({ devDependencies: { jest: '^29.7.0' } }),
    'legacy/yarn.lock': '',
    'legacy/node_modules/jest/package.json': '{"version":"29.7.0"}',
    'node_modules/x/package.json': JSON.stringify({ devDependencies: { jest: '1' } }),
  });
  const r = detect(root, fs);
  assert.deepEqual(r.suites.map((s) => [s.id, s.version, s.exec]), [
    ['vitest:.', '3.2.4', 'npx --no'],
    ['node:.', null, 'npx --no'],
    ['playwright:.', '1.48.2', 'npx --no'],
    ['jest:legacy', '29.7.0', 'yarn'],
  ]);
  assert.deepEqual(r.suites.find((s) => s.runner === 'node').args, ['test/']);
  assert.equal(r.suites.find((s) => s.runner === 'playwright').url, 'http://localhost:5173');
});

test('detect: .NET test projects (the test SDK, xUnit, NUnit, MSTest), not the app beside them', () => {
  const fs = memoryFs(root, {
    'Shop.sln': '',
    'src/Shop/Shop.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Serilog" Version="3.1.1" /></ItemGroup></Project>',
    'tests/Shop.Tests/Shop.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" /><PackageReference Include="xunit" Version="2.9.2" /></ItemGroup></Project>',
    'tests/Shop.Tests/bin/Debug/Shop.Tests.csproj': 'copied, never read',
  });
  const r = detect(root, fs);
  assert.deepEqual(r.suites.map((s) => [s.id, s.dir, s.target]), [['dotnet:tests/Shop.Tests:Shop.Tests.csproj', 'tests/Shop.Tests', 'Shop.Tests.csproj']]);
});

test('drill.json says which runners instead, and what is wrong in it', () => {
  const fs = memoryFs(root, {
    'drill.json': JSON.stringify({ runners: [{ runner: 'vitest', cwd: 'web', args: ['--project=unit'] }, { runner: 'mocha' }], e2e: { url: 'http://localhost:8080' } }),
    'package.json': JSON.stringify({ devDependencies: { jest: '29' } }),
  });
  const r = detect(root, fs);
  assert.deepEqual(r.suites.map((s) => [s.id, s.args]), [['vitest:web', ['--project=unit']]]);
  assert.match(r.notes[0], /runners\[1\]: "runner" is one of/);
  assert.equal(readDrillJson('{"e2e":{"url":"localhost"}}').problems[0], 'drill.json: "e2e.url" is an http:// or https:// address');
  assert.equal(readDrillJson('nope').problems.length, 1);
  assert.match(detect(root, memoryFs(root, {})).notes[0], /No tests found/);
});

test("playwright's address, node --test's files", () => {
  assert.equal(playwrightUrl("webServer: { command: 'npm start', port: 3000 }"), 'http://localhost:3000');
  assert.equal(playwrightUrl("use: { baseURL: 'https://app.test' }"), 'https://app.test');
  assert.equal(playwrightUrl('export default {}'), null);
  assert.deepEqual(nodeTestArgs('node --test'), []);
  assert.deepEqual(nodeTestArgs('NODE_ENV=test node --import ./x.js --test "src/**/*.test.js" && echo ok'), ['src/**/*.test.js']);
  assert.equal(nodeTestArgs('vitest'), null);
});

test("each runner's command: its reporter to a file, what to run, quoted for the shell", () => {
  const out = join(tmpdir(), 'out');
  const t = (o) => makeTest({ runner: 'vitest', file: 'src/a.test.ts', suite: ['a'], name: 'adds', status: 'failed', ...o });
  const v = buildCommand({ runner: 'vitest', exec: 'npx --no', dir: '' }, { tests: [t(), t({ name: "it's (odd) $HOME" })], out, platform: 'linux' });
  assert.equal(v.command, `npx --no vitest run --reporter=default --reporter=json '--outputFile.json=${join(out, 'report.json')}' 'src/a.test.ts' -t '(adds|it.s .odd. .HOME)'`);
  assert.equal(v.env.FORCE_COLOR, '1');
  const j = buildCommand({ runner: 'jest', exec: 'yarn', dir: 'legacy' }, { files: ['legacy/src/x.test.js'], out, platform: 'win32' });
  assert.equal(j.command, `yarn jest --json "--outputFile=${join(out, 'report.json')}" --testLocationInResults "src/x.test.js"`);
  const n = buildCommand({ runner: 'node', dir: '', args: ['test/'] }, { out, platform: 'linux' });
  assert.equal(n.command, `node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=tap '--test-reporter-destination=${join(out, 'report.tap')}' 'test/'`);
  const p = buildCommand({ runner: 'playwright', exec: 'pnpm exec', dir: '' }, { tests: [makeTest({ runner: 'playwright', file: 'e2e/a.spec.ts', name: 'x', status: 'failed', line: 10 })], out, platform: 'linux' });
  assert.equal(p.command, "pnpm exec playwright test --reporter=list,json 'e2e/a.spec.ts:10'");
  assert.equal(p.env.PLAYWRIGHT_JSON_OUTPUT_NAME, join(out, 'report.json'));
  const d = buildCommand({ runner: 'dotnet', dir: 'tests/T', target: 'T.csproj' }, { tests: [makeTest({ runner: 'dotnet', file: 'N.C', name: 'M(x: 1)', fqn: 'N.C.M', status: 'failed' }), makeTest({ runner: 'dotnet', file: 'N.C', name: 'Q', fqn: 'N.C.Q;rm', status: 'failed' })], out, platform: 'linux' });
  assert.equal(d.command, `dotnet test 'T.csproj' --logger 'trx;LogFileName=drill.trx' --logger 'console;verbosity=normal' --results-directory '${join(out, 'trx')}' --filter 'FullyQualifiedName=N.C.M'`);
  const dc = buildCommand({ runner: 'dotnet', dir: '' }, { files: ['Shop.Tests.CartTests'], out, platform: 'linux' });
  assert.match(dc.command, /--filter 'FullyQualifiedName~Shop\.Tests\.CartTests\.'$/);
});

test('nothing from a name or path reaches the shell as itself', () => {
  assert.equal(namePattern("a'b\"c`d$e%f!g;h|i&j"), 'a.b.c.d.e.f.g.h.i.j');
  assert.equal(namePattern('$$$'), null);
  assert.equal(safeFile("src/it's.test.js"), null);
  assert.equal(safeFile('src/%PATH%.js'), null);
  assert.equal(safeFile('-rf'), null);
  assert.equal(safeFile('app/(group)/page.test.tsx'), 'app/(group)/page.test.tsx');
});

test('changed files to tests: the file itself, its name, its imports; C# by class', () => {
  assert.deepEqual(parsePorcelain(' M src/cart.ts\n?? src/new.test.ts\nR  old.ts -> src/price.ts\n D gone.js\n'), ['src/cart.ts', 'src/new.test.ts', 'src/price.ts', 'gone.js']);
  assert.ok(isTestFile('src/a.test.ts') && isTestFile('test/x.js') && isTestFile('Tests/CartTests.cs') && !isTestFile('src/a.ts'));
  assert.deepEqual([...importsOf('src/a.test.ts', "import x from './lib/price.js';\nconst y = require('../util/index');")], ['src/lib/price', 'util']);
  const files = [
    { path: 'src/cart.test.ts', text: "import { total } from './cart';" },
    { path: 'src/checkout.test.ts', text: "import { pay } from './checkout';\nimport { format } from './lib/price';" },
    { path: 'src/new.test.ts', text: '' },
    { path: 'src/other.test.ts', text: "import x from './other';" },
    { path: 'tests/Shop.Tests/PriceTests.cs', text: 'class PriceTests {}' },
    { path: 'tests/Shop.Tests/CartTests.cs', text: 'var p = new Price(1);' },
  ];
  assert.deepEqual(testsTouching(['src/cart.ts', 'src/lib/price.ts', 'src/new.test.ts', 'src/Shop/Price.cs'], files), [
    { path: 'src/cart.test.ts', why: 'tests cart.ts' },
    { path: 'src/checkout.test.ts', why: 'imports price.ts' },
    { path: 'src/new.test.ts', why: 'changed' },
    { path: 'tests/Shop.Tests/PriceTests.cs', why: 'tests Price.cs' },
    { path: 'tests/Shop.Tests/CartTests.cs', why: 'uses Price' },
  ]);
  assert.deepEqual(classesIn('namespace Shop.Tests;\npublic class CartTests { }\nclass Helper {}'), ['Shop.Tests.CartTests', 'Shop.Tests.Helper']);
});

test('changed files against thousands of test files: each test file read once, in a moment', () => {
  const files = Array.from({ length: 2000 }, (_, i) => ({ path: `src/m${i}/a${i}.test.js`, text: `${Array.from({ length: 30 }, (_, k) => `import x${k} from '../lib/l${(i * 7 + k) % 5000}.js';`).join('\n')}\n${'x'.repeat(5000)}` }));
  const changed = Array.from({ length: 200 }, (_, i) => `src/lib/l${i * 13}.js`);
  const started = performance.now();
  const touching = testsTouching(changed, files);
  assert.ok(performance.now() - started < 2000, 'it took too long');
  assert.equal(touching.length, 1117);
  assert.deepEqual(touching[1], { path: 'src/m1/a1.test.js', why: 'imports l13.js' });
});

test('which suite runs a test file: the one that ran it, else by name and place', () => {
  const suites = [
    { id: 'vitest:.', runner: 'vitest', dir: '' },
    { id: 'playwright:.', runner: 'playwright', dir: '' },
    { id: 'jest:legacy', runner: 'jest', dir: 'legacy' },
    { id: 'dotnet:tests/T:T.csproj', runner: 'dotnet', dir: 'tests/T' },
  ];
  const known = [{ file: 'src/odd.spec.ts', from: 'vitest:.' }];
  const m = filesBySuiteOf(suites, ['src/a.test.ts', 'e2e/home.spec.ts', 'legacy/x.test.js', 'src/odd.spec.ts', 'tests/T/CartTests.cs'], { known, classesOf: () => ['T.CartTests'] });
  assert.deepEqual(Object.fromEntries(m), { 'vitest:.': ['src/a.test.ts', 'src/odd.spec.ts'], 'playwright:.': ['e2e/home.spec.ts'], 'jest:legacy': ['legacy/x.test.js'], 'dotnet:tests/T:T.csproj': ['T.CartTests'] });
});

test('a re-run merges: the same tests replaced, new ones placed after their file, gone ones dropped from a re-run file', () => {
  const t = (file, name, status = 'passed') => makeTest({ runner: 'vitest', file, name, status, from: 'vitest:.' });
  const prev = [t('a', 'one', 'failed'), t('a', 'two'), t('b', 'three', 'failed')];
  const next = mergeTests(prev, [t('a', 'one'), t('a', 'four')], { rerunFiles: new Set(['a']) });
  assert.deepEqual(next.map((x) => `${x.file}:${x.name}:${x.status}`), ['a:one:passed', 'a:four:passed', 'b:three:failed']);
});

test('flaky: passed and failed in the last runs, a retried pass counting as both; the history on disk', () => {
  const t = (name, status, flaky = false) => makeTest({ runner: 'vitest', file: 'a.test.ts', name, status, ...(flaky ? { flaky } : {}) });
  let h = { runs: [], tests: {} };
  h = recordRun(h, [t('steady', 'passed'), t('wobbly', 'failed'), t('broken', 'failed'), t('skip', 'skipped')], 1);
  h = recordRun(h, [t('steady', 'passed'), t('wobbly', 'passed'), t('broken', 'failed')], 2);
  h = recordRun(h, [t('retried', 'passed', true)], 3);
  const f = flakyTests(h);
  assert.deepEqual(f.map((x) => [x.name, x.marks, x.fails, x.runs]), [['retried', '↻', 1, 1], ['wobbly', '✗✓', 1, 2]]);
  assert.equal(f[1].lastFailed, 1);
  assert.ok(!('skip' in Object.fromEntries(Object.values(h.tests).map((x) => [x.name, 1]))));
  const home = mkdtempSync(join(tmpdir(), 'drill-history-'));
  try {
    saveHistory(root, h, home);
    assert.deepEqual(loadHistory(root, home), h);
    assert.match(historyFile(root, home), /history[\\/][0-9a-f]{16}\.json$/);
    assert.equal(historyFile('C:\\Work\\Shop', home, 'win32'), historyFile('c:\\work\\shop', home, 'win32'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the editor's command: each editor's way of taking a line, terminal editors told apart", () => {
  const f = '/w/src/a.ts';
  assert.deepEqual(editorCommand('code --wait', f, 12, { column: 3, platform: 'linux' }), { command: "'code' -g '/w/src/a.ts:12:3'", terminal: false });
  assert.equal(editorCommand('subl', f, 12, { platform: 'linux' }).command, "'subl' '/w/src/a.ts:12'");
  assert.equal(editorCommand('rider64.exe', 'C:\\w\\A.cs', 5, { platform: 'win32' }).command, '"rider64.exe" --line 5 "C:\\w\\A.cs"');
  assert.deepEqual(editorCommand('nvim', f, 12, { platform: 'linux' }), { command: "'nvim' +12 '/w/src/a.ts'", terminal: true });
  assert.equal(editorCommand('"C:\\Program Files\\Notepad++\\notepad++.exe"', 'C:\\a.cs', 4, { platform: 'win32' }).command, '"C:\\Program Files\\Notepad++\\notepad++.exe" -n4 "C:\\a.cs"');
  assert.equal(editorCommand('code', "/w/it's.ts", 1), null);
  assert.equal(editorCommand('', f, 1), null);
  assert.equal(editorSetting({}, { VISUAL: 'zed', EDITOR: 'vim' }), 'zed');
  assert.equal(editorSetting({ editor: 'code' }, { EDITOR: 'vim' }), 'code');
});

test("the app's check: any answer is up, a refused connection or a timeout isn't", async () => {
  assert.deepEqual(await checkApp('http://localhost:1', { fetchImpl: async () => ({ status: 404 }) }), { up: true, status: 404 });
  const refused = await checkApp('http://localhost:1', { fetchImpl: async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })) });
  assert.deepEqual(refused, { up: false, error: 'connection refused' });
  // The timeout's own timer doesn't keep Node running (a real request's socket does): this one stands in.
  const keep = setTimeout(() => {}, 1000);
  const slow = await checkApp('http://localhost:1', { timeout: 50, fetchImpl: (url, { signal }) => new Promise((_, no) => signal.addEventListener('abort', () => no(new Error('aborted')))) });
  clearTimeout(keep);
  assert.deepEqual(slow, { up: false, error: 'no answer in 0.05s' });
  assert.match(appDown('http://localhost:3000', refused, [{ app: 'bosun', mood: 'happy', reason: 'all 2 running', at: 1 }]), /isn't answering \(connection refused\).*Bosun says: all 2 running\. Start it in Bosun/);
});

test('the provider runs a suite: its output as it comes, the report parsed with the pinned parser, a missing report said', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'drill-provider-'));
  try {
    const seen = [];
    const run = async (command, { onLine }) => {
      seen.push(command);
      const report = /'--outputFile\.json=([^']+)'/.exec(command)?.[1];
      onLine?.('\x1b[31m FAIL\x1b[0m src/sum.test.ts');
      writeFileSync(report, fixture('vitest-1.json').replaceAll('/work/shop', dir.replace(/\\/g, '/')));
      throw Object.assign(new Error('tests failed'), { code: 1 });
    };
    const drill = createDrill({ run });
    const out = [];
    const suite = { id: 'vitest:.', runner: 'vitest', cwd: dir, dir: '', exec: 'npx --no', version: '1.6.0' };
    const r = await drill.runSuite(suite, { root: dir, onData: (d) => out.push(d) });
    assert.equal(r.ran, true);
    assert.equal(r.exit, 1);
    assert.equal(r.pin, 'Vitest 1');
    assert.equal(r.tests.filter((t) => t.status === 'failed').length, 2);
    assert.equal(r.tests[0].file, 'src/sum.test.ts');
    assert.match(out[0], /^\x1b\[2m\$ npx --no vitest run/);
    assert.equal(out[1], '\x1b[31m FAIL\x1b[0m src/sum.test.ts\r\n');
    // No report: what it said goes in the error.
    const broken = createDrill({ run: async () => Promise.reject(Object.assign(new Error('x'), { code: 127, stderr: 'sh: 1: vitest: not found\n' })) });
    const b = await broken.runSuite(suite, { root: dir });
    assert.deepEqual([b.ran, b.error], [false, 'sh: 1: vitest: not found']);
    // node's version is asked of node once.
    const asked = [];
    const nodeDrill = createDrill({ run: async (c) => (asked.push(c), c === 'node --version' ? { stdout: 'v22.11.0\n', stderr: '' } : { stdout: '', stderr: '' }) });
    const n = await nodeDrill.runSuite({ id: 'node:.', runner: 'node', cwd: dir, dir: '' }, { root: dir });
    assert.deepEqual([n.version, n.pin, n.ran], ['22.11.0', 'node --test 22', false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
