// Comparing builds (the summaries kept, the change and its reason, the Markdown for a pull request),
// the runs kept in ~/.ballast, budgets, and the sizes compressed.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareMarkdown, compareRuns, packageReason, summarize } from '../src/compare.js';
import { lastRun, loadRuns, runAt, runsFile, saveRun } from '../src/history.js';
import { savedBase } from '../src/base.js';
import { checkBudgets, globToRegExp, growthFails, parseBudget, parseFailOn, readBudgets } from '../src/budgets.js';
import { finishChunk } from '../src/build.js';
import { compressedSizes, compressedSizesAsync, formatBytes, formatDelta, formatPercent, mapLimit, parseSize } from '../src/sizes.js';
import { demoBallast, demoBuild, DEMO_LAST, DEMO_MAIN } from '../src/demo.js';

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ballast-home-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const chunk = (file, raw, modules = []) => finishChunk({ file, sizes: { raw, gzip: Math.round(raw / 3), brotli: Math.round(raw / 4) }, modules });

test('a summary keeps each file and package, keyed by the commit (and +dirty with changes)', () => {
  const build = { tool: 'esbuild', source: { label: 'esbuild metafile, meta.json' }, chunks: [chunk('dist/a-1234abcd.js', 3000, [{ id: 'node_modules/x/i.js', bytes: 2000 }, { id: 'src/a.js', bytes: 1000 }])] };
  const s = summarize(build, { commit: 'abc', branch: 'main', dirty: true, at: 5 });
  assert.equal(s.key, 'abc+dirty');
  assert.deepEqual(s.total, { raw: 3000, gzip: 1000, brotli: 750 });
  assert.deepEqual(s.chunks, [{ name: 'dist/a-[hash].js', file: 'dist/a-1234abcd.js', raw: 3000, gzip: 1000, brotli: 750 }]);
  assert.deepEqual(s.packages, [{ name: 'x', raw: 2000, gzip: 667, brotli: 500, modules: 1, versions: [] }]);
});

test('the demo branch against main: +51.5 kB gzip, from date-fns 4 now imported whole', () => {
  const p = demoBallast();
  const head = summarize(demoBuild('/demo/shop'), { commit: 'c0ffee1' });
  const main = p.state.runs.find((r) => r.commit === DEMO_MAIN);
  const r = compareRuns(main, head);
  assert.equal(r.headline, '+51.5 kB gzip, from date-fns 4 now imported whole');
  assert.equal(r.chunks[0].name, 'dist/assets/index-[hash].js');
  assert.equal(r.chunks[0].status, 'changed');
  assert.equal(r.packages[0].name, 'date-fns');
  // Against itself, nothing.
  assert.equal(compareRuns(head, head).headline, 'No change in gzip size');
  // A run without compression is compared raw.
  const raw = { ...main, total: { ...main.total, gzip: null } };
  assert.equal(compareRuns(raw, head).measure, 'raw');
});

test("why a package changed: added, gone, imported whole, another version, or just bigger", () => {
  const p = (before, after, delta = 1000) => packageReason({ name: 'x', before, after, delta });
  assert.equal(p(null, { versions: ['4.1.0'], modules: 3 }), 'x 4 newly bundled');
  assert.equal(p({ versions: ['1.0.0'], modules: 3 }, null, -1000), 'x no longer bundled');
  assert.equal(p({ versions: ['2.30.0'], modules: 3 }, { versions: ['4.1.0'], modules: 140 }), 'x 4 now imported whole');
  assert.equal(p({ versions: ['2.30.0'], modules: 3 }, { versions: ['2.30.0'], modules: 140 }), 'x now imported whole');
  assert.equal(p({ versions: ['1.0.0'], modules: 40 }, { versions: ['1.0.0'], modules: 4 }, -5000), 'x no longer imported whole');
  assert.equal(p({ versions: ['1.0.0'], modules: 4 }, { versions: ['1.1.0'], modules: 5 }), 'x 1.0.0 → 1.1.0');
  assert.equal(p({ versions: ['1.0.0'], modules: 4 }, { versions: ['1.0.0'], modules: 5 }, 2100), 'x grew by 2.1 kB');
});

test('the Markdown for a pull request: the headline with its percentage, the files that changed, the packages in a fold', () => {
  const p = demoBallast();
  const head = { ...summarize(demoBuild('/demo/shop'), { commit: 'c0ffee15e2a9' }) };
  const main = p.state.runs.find((r) => r.commit === DEMO_MAIN);
  const md = compareMarkdown(compareRuns(main, head), { base: main, head, baseName: 'main' });
  assert.match(md, /^### Bundle size: \+51\.5 kB gzip \(\+37\.2%\)\n/);
  assert.match(md, /Against `main` \(a1b2c3d, \d{4}-\d\d-\d\d\), this build at `c0ffee1`: from date-fns 4 now imported whole\./);
  assert.match(md, /\| `dist\/assets\/index-\[hash\]\.js` \| 61\.2 kB \| 112\.7 kB \| \*\*\+51\.5 kB \(\+84\.1%\)\*\* \|/);
  assert.match(md, /\| \*\*Total\*\* \| 138\.5 kB \| 190\.0 kB \| \*\*\+51\.5 kB \(\+37\.2%\)\*\* \|/);
  assert.match(md, /4 chunks unchanged\./);
  assert.match(md, /<details><summary>Packages that changed \(2\)<\/summary>/);
  assert.match(md, /\| `date-fns` 2\.30\.0 → 4\.1\.0\/2\.30\.0 \| 12\.6 kB \| 60\.9 kB \| \+48\.3 kB \| date-fns 4 now imported whole \|/);
});

test('runs are kept per project, newest first, one per key; "last" passes over this build, a commit finds its own', () => {
  const root = join(tmpdir(), 'shop');
  assert.deepEqual(loadRuns(home, root), []);
  assert.match(runsFile(home, root), /runs[\\/]shop-[0-9a-f]{10}\.json$/);
  saveRun(home, root, { key: 'aaa', commit: 'aaa', at: 1 });
  saveRun(home, root, { key: 'bbb+dirty', commit: 'bbb', dirty: true, at: 2 });
  saveRun(home, root, { key: 'bbb', commit: 'bbb', at: 3 });
  saveRun(home, root, { key: 'aaa', commit: 'aaa', at: 4 });
  const runs = loadRuns(home, root);
  assert.deepEqual(runs.map((r) => r.key), ['aaa', 'bbb', 'bbb+dirty']);
  assert.equal(lastRun(runs, 'aaa').key, 'bbb');
  assert.equal(runAt(runs, 'bbb').key, 'bbb');
  assert.equal(runAt(runs, 'bbbbbbbb').key, 'bbb');
  assert.equal(runAt(runs, 'ccc'), null);
  // Another folder of the same name keeps its own.
  assert.deepEqual(loadRuns(home, join(tmpdir(), 'elsewhere', 'shop')), []);
});

test('the base: the last build, main\'s kept build, or what is missing and whether it can be built', async () => {
  const p = demoBallast({ mainSaved: false });
  assert.equal((await savedBase(p, '/demo/shop', { base: 'last', key: 'c0ffee' })).run.commit, DEMO_LAST);
  const main = await savedBase(p, '/demo/shop', { base: 'main', key: 'c0ffee' });
  assert.equal(main.canBuild, true);
  assert.match(main.missing, /No build of main \(a1b2c3d\) has been read yet\./);
  assert.match((await savedBase(p, '/demo/shop', { base: 'nope' })).missing, /There's no nope/);
  assert.match((await savedBase(p, '/demo/shop', { base: '-rf' })).missing, /isn't a git ref/);
  assert.match((await savedBase(demoBallast(), '/x', { base: 'last', key: DEMO_LAST })).run.commit, new RegExp(DEMO_MAIN));
});

test('sizes as written and read', () => {
  assert.deepEqual(['180kB', '180 KB', '1.5MB', '200KiB', '4096', '2 mib', 'big', '10 GB'].map(parseSize), [180000, 180000, 1500000, 204800, 4096, 2097152, null, null]);
  assert.deepEqual([999, 1000, 51543, 1234567].map(formatBytes), ['999 B', '1.0 kB', '51.5 kB', '1.23 MB']);
  assert.deepEqual([formatDelta(1500), formatDelta(-1500), formatDelta(0)], ['+1.5 kB', '-1.5 kB', '±0 B']);
  assert.deepEqual([formatPercent(10, 100), formatPercent(-5, 100), formatPercent(5, 0)], ['+10.0%', '-5.0%', '']);
});

test('budgets: globs over the files, each file held to its own, total over all; growth by percent or bytes', () => {
  const re = globToRegExp('dist/assets/index-*.js');
  assert.ok(re.test('dist/assets/index-B7xk2Lq9.js'));
  assert.ok(!re.test('dist/assets/sub/index-B7xk2Lq9.js'));
  assert.ok(globToRegExp('dist/**/*.css').test('dist/a/b/c.css'));
  assert.ok(globToRegExp('dist/**/*.css').test('dist/c.css'));
  assert.ok(globToRegExp('dist/?.js').test('dist/a.js'));
  assert.deepEqual(parseBudget('dist/assets/index-*.js=180kB'), { pattern: 'dist/assets/index-*.js', limit: 180000 });
  assert.match(parseBudget('dist/a.js').error, /<file or glob>=<size>/);
  assert.match(parseBudget('dist/a.js=huge').error, /isn't a size/);
  assert.deepEqual(parseFailOn('growth>5%'), { kind: 'growth', percent: 5, text: 'growth>5%' });
  assert.deepEqual(parseFailOn('budget'), { kind: 'budget', text: 'budget' });
  assert.match(parseFailOn('growth').error, /--fail-on is/);
  const chunks = [chunk('dist/assets/index-aaaa1111.js', 3000), chunk('dist/assets/index-bbbb2222.js', 600), chunk('dist/x.css', 300)];
  const [glob, total, none] = checkBudgets(chunks, [{ pattern: 'dist/assets/index-*.js', limit: 500 }, { pattern: 'total', limit: 2000 }, { pattern: 'dist/nope/*.js', limit: 1 }]);
  assert.deepEqual(glob.files.map((f) => [f.file, f.size, f.over]), [['dist/assets/index-aaaa1111.js', 1000, true], ['dist/assets/index-bbbb2222.js', 200, false]]);
  assert.equal(glob.over, true);
  assert.deepEqual([total.size, total.over], [1300, false]);
  assert.equal(none.none, true);
  assert.equal(none.over, false);
  assert.ok(growthFails({ percent: 5 }, { before: 100, delta: 6 }));
  assert.ok(!growthFails({ percent: 5 }, { before: 100, delta: 5 }));
  assert.ok(growthFails({ bytes: 1000 }, { before: 10, delta: 1001 }));
  assert.ok(!growthFails({ percent: 5 }, { before: 100, delta: -50 }));
  assert.deepEqual(readBudgets({ budgets: { a: 100 }, measure: 'weight' }).errors, ['measure is gzip, brotli or raw, not weight']);
});

test('sizes compressed on the thread pool are those compressed in place, and content seen before is not compressed again', async () => {
  const text = Array.from({ length: 3000 }, (_, i) => `var v${i}=${i * 7};`).join('');
  const once = await compressedSizesAsync(Buffer.from(text));
  assert.deepEqual(once, compressedSizes(text));
  assert.ok(once.gzip < once.raw && once.brotli < once.raw);
  // The same bytes again come from what was kept, well under the time brotli's best level takes.
  const big = Buffer.from(Array.from({ length: 60000 }, (_, i) => `function f${i}(a){return a*${(i * 2654435761) % 9973}}`).join(''));
  const first = await compressedSizesAsync(big);
  const started = performance.now();
  assert.deepEqual(await compressedSizesAsync(Buffer.from(big)), first);
  assert.ok(performance.now() - started < 200);
});

test('mapLimit keeps the order and runs no more than it is told to at once', async () => {
  let running = 0;
  let most = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n, i) => {
    most = Math.max(most, ++running);
    await new Promise((r) => setTimeout(r, n));
    running--;
    return n * 10 + i;
  });
  assert.deepEqual(out, [50, 11, 42, 23, 34]);
  assert.equal(most, 2);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});
