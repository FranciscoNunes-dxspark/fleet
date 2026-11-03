// The stats parsers over real-shaped files (esbuild's metafile, rollup-plugin-visualizer's data from a
// Vite build with pnpm, webpack 5's stats), module paths to packages, file names without their hash,
// and source maps counted by source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanId, detectFormat, parseStats, statsJson } from '../src/stats.js';
import { compareVersions, majorOf, packageOf, parentOf, safePackageName } from '../src/packages.js';
import { finishChunk, kindOf, packageTotals, stableName } from '../src/build.js';
import { decodeSegment, mapUrlOf, sourceSizes, UNMAPPED } from '../src/sourcemap.js';
import { duplicates, moduleTree, treeRows } from '../src/modules.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const byName = (build) => Object.fromEntries(build.chunks.map((c) => [c.name, c]));

test("esbuild's metafile: every output but the map, with each input's bytes in it", () => {
  const meta = fixture('esbuild-meta.json');
  assert.equal(detectFormat(meta), 'esbuild');
  const build = parseStats(meta);
  assert.equal(build.tool, 'esbuild');
  const chunks = byName(build);
  assert.deepEqual(Object.keys(chunks).sort(), ['dist/Report-OJ2QXWBA.js', 'dist/chunk-4FQK7ZMW.js', 'dist/main.css', 'dist/main.js']);
  assert.equal(chunks['dist/main.js'].bytes, 11102);
  assert.equal(chunks['dist/main.js'].entry, true);
  assert.equal(chunks['dist/chunk-4FQK7ZMW.js'].entry, false);
  assert.deepEqual(chunks['dist/Report-OJ2QXWBA.js'].modules, [
    { id: 'node_modules/chart.js/dist/chart.js', bytes: 205110 },
    { id: 'src/components/Report.tsx', bytes: 1210 },
  ]);
  assert.equal(chunks['dist/main.js'].modules.length, 6);
});

test("rollup-plugin-visualizer's data from a Vite build: chunks from the module parts, a module in two chunks in both, pnpm's versions", () => {
  const data = fixture('vite-visualizer.json');
  assert.equal(detectFormat(data), 'rollup');
  const build = parseStats(data);
  const chunks = byName(build);
  assert.deepEqual(Object.keys(chunks).sort(), ['assets/Settings-C4mYq1bE.js', 'assets/index-DiwrgTda.js']);
  const index = chunks['assets/index-DiwrgTda.js'];
  assert.equal(index.entry, true);
  assert.equal(index.bytes, 1802 + 642 + 1288 + 3410 + 238120 + 41030 + 98422 + 2101);
  assert.ok(index.modules.some((m) => m.id === 'vite/modulepreload-polyfill.js'));
  assert.ok(index.modules.some((m) => m.id === 'src/views/Home.vue'));
  // debounce is in both chunks: Rollup put a copy in each.
  assert.ok(chunks['assets/Settings-C4mYq1bE.js'].modules.some((m) => m.id === 'node_modules/.pnpm/lodash-es@4.17.21/node_modules/lodash-es/debounce.js'));
  const done = finishChunk({ file: 'dist/assets/index-DiwrgTda.js', bytes: index.bytes, modules: index.modules });
  const pkgs = packageTotals([done]);
  assert.deepEqual(pkgs.map((p) => [p.name, p.versions]).slice(0, 3), [['@vue/runtime-core', ['3.4.27']], ['vue-router', ['4.3.2']], ['@vue/reactivity', ['3.4.27']]]);
});

test('the visualizer data inside its stats.html is read too', () => {
  const html = `<!DOCTYPE html><html><head><title>Rollup Visualizer</title></head><body><main></main><script>\n/*<!--*/\nconst data = ${JSON.stringify(fixture('vite-visualizer.json'))};\n\nconst run = () => {};\n/*-->*/\n</script></body></html>`;
  const json = statsJson(html);
  assert.equal(detectFormat(json), 'rollup');
  assert.equal(statsJson('not json, not html'), null);
});

test("webpack 5's stats: files from chunks and assets, concatenated modules opened up, stylesheets apart, maps and orphans left out", () => {
  const stats = fixture('webpack-stats.json');
  assert.equal(detectFormat(stats), 'webpack');
  const build = parseStats(stats);
  assert.equal(build.outputPath, '/home/runner/work/storefront/storefront/build');
  const chunks = byName(build);
  assert.deepEqual(Object.keys(chunks).sort(), ['static/css/main.6f1d3a2b.css', 'static/js/412.a1b2c3d4.chunk.js', 'static/js/main.3f9a1c2e.js', 'static/js/vendors.8c2d4e6f.js', 'static/media/logo.4b2e8f1a.svg']);
  const main = chunks['static/js/main.3f9a1c2e.js'];
  assert.equal(main.bytes, 41230);
  assert.equal(main.entry, true);
  assert.deepEqual(main.modules.map((m) => m.id).sort(), ['src/App.js', 'src/api/client.js', 'src/components/Header.js', 'src/index.js', 'src/reportWebVitals.js', 'webpack/runtime/jsonp chunk loading']);
  assert.deepEqual(chunks['static/css/main.6f1d3a2b.css'].modules, [{ id: 'src/index.css', bytes: 11810 }]);
  assert.deepEqual(chunks['static/js/412.a1b2c3d4.chunk.js'].modules.map((m) => m.id), ['node_modules/chart-kit/node_modules/lodash/lodash.min.js', 'node_modules/chart-kit/index.js']);
  assert.equal(chunks['static/js/vendors.8c2d4e6f.js'].modules.length, 3);
  assert.equal(chunks['static/media/logo.4b2e8f1a.svg'].modules.length, 0);
  // A multi-compiler build is its children's files together.
  assert.equal(parseStats({ children: [stats, stats] }).chunks.length, 10);
});

test('module ids: webpack://, loaders, queries, \\0 and the project root taken off', () => {
  assert.equal(cleanId('webpack://shop/./src/App.jsx'), 'src/App.jsx');
  assert.equal(cleanId('css ./node_modules/css-loader/dist/cjs.js!./src/a.css?inline'), 'src/a.css');
  assert.equal(cleanId('\0vite/preload-helper.js'), 'vite/preload-helper.js');
  assert.equal(cleanId('/home/me/shop/src/main.ts', '/home/me/shop'), 'src/main.ts');
  assert.equal(cleanId('C:\\work\\shop\\src\\main.ts', 'C:\\work\\shop'), 'src/main.ts');
  assert.equal(cleanId('./src/index.js + 4 modules'), 'src/index.js');
});

test('a module path says its package, where it is installed, and the version where the path holds it', () => {
  assert.equal(packageOf('src/App.jsx'), null);
  assert.deepEqual(packageOf('node_modules/date-fns/format.js'), { name: 'date-fns', installPath: 'node_modules/date-fns' });
  assert.deepEqual(packageOf('../../node_modules/@floating-ui/dom/dist/x.mjs'), { name: '@floating-ui/dom', installPath: 'node_modules/@floating-ui/dom' });
  assert.deepEqual(packageOf('node_modules/react-datepicker/node_modules/date-fns/esm/format/index.js'), { name: 'date-fns', installPath: 'node_modules/react-datepicker/node_modules/date-fns' });
  assert.deepEqual(packageOf('node_modules/.pnpm/@vue+reactivity@3.4.27/node_modules/@vue/reactivity/dist/r.js'), { name: '@vue/reactivity', installPath: 'node_modules/.pnpm/@vue+reactivity@3.4.27/node_modules/@vue/reactivity', version: '3.4.27' });
  assert.deepEqual(packageOf('node_modules/.pnpm/vue-router@4.3.2_vue@3.4.27/node_modules/vue-router/dist/v.mjs').version, '4.3.2');
  assert.deepEqual(packageOf('.yarn/cache/date-fns-npm-2.30.0-1a2b3c4d5e.zip/node_modules/date-fns/index.js'), { name: 'date-fns', installPath: '.yarn/cache/date-fns-npm-2.30.0-1a2b3c4d5e.zip/node_modules/date-fns', version: '2.30.0' });
  assert.equal(packageOf('node_modules\\lodash\\lodash.js').name, 'lodash');
  assert.equal(parentOf('node_modules/react-datepicker/node_modules/date-fns'), 'react-datepicker');
  assert.equal(parentOf('node_modules/@a/b/node_modules/tslib'), '@a/b');
  assert.equal(parentOf('node_modules/tslib'), null);
  assert.ok(compareVersions('1.10.0', '1.9.2') > 0);
  assert.ok(compareVersions('2.0.0-beta.1', '2.0.0') < 0);
  assert.equal(majorOf('4.1.0'), '4');
  assert.equal(majorOf('0.28.1'), '0.28');
  assert.ok(safePackageName('@scope/pkg'));
  assert.ok(!safePackageName('pkg; rm -rf /'));
});

test('file names without their content hash, and what kind of file each is', () => {
  assert.equal(stableName('dist/assets/index-B7xk2Lq9.js'), 'dist/assets/index-[hash].js');
  assert.equal(stableName('dist/assets/index-D-xk2Lq9.js'), 'dist/assets/index-[hash].js');
  assert.equal(stableName('dist/assets/vendor-react-Cq81Ma0d.js'), 'dist/assets/vendor-react-[hash].js');
  assert.equal(stableName('build/static/js/main.3f9a1c2e.js'), 'build/static/js/main.[hash].js');
  assert.equal(stableName('build/static/js/412.a1b2c3d4.chunk.js'), 'build/static/js/412.[hash].chunk.js');
  assert.equal(stableName('dist/vendor-components.js'), 'dist/vendor-components.js');
  assert.equal(stableName('dist/polyfills-es2015.js'), 'dist/polyfills-es2015.js');
  assert.equal(stableName('dist/index.html'), 'dist/index.html');
  assert.deepEqual(['a.mjs', 'b.css', 'c.html', 'd.wasm', 'e.woff2', 'f.svg', 'g.txt'].map(kindOf), ['js', 'css', 'html', 'wasm', 'font', 'image', 'other']);
});

test('a chunk finished: modules scaled to the file, biggest first, with their packages and versions', () => {
  const c = finishChunk({ file: 'dist/a-1234abcd.js', sizes: { raw: 1000, gzip: 300, brotli: 250 }, modules: [{ id: 'src/a.js', bytes: 100 }, { id: 'node_modules/x/i.js', bytes: 300 }] }, { versionAt: (p) => (p === 'node_modules/x' ? '1.2.3' : null) });
  assert.equal(c.name, 'dist/a-[hash].js');
  assert.deepEqual(c.modules.map((m) => [m.id, m.bytes, m.pkg?.version ?? null]), [['node_modules/x/i.js', 750, '1.2.3'], ['src/a.js', 250, null]]);
  assert.equal(finishChunk({ file: 'x.js', bytes: 10 }).gzip, null);
});

test("a source map's sources counted by the characters they map to", () => {
  assert.deepEqual(decodeSegment('AAAA'), [0, 0, 0, 0]);
  assert.deepEqual(decodeSegment('KACA'), [5, 0, 1, 0]);
  assert.deepEqual(decodeSegment('gBAAA'), [16, 0, 0, 0]);
  assert.deepEqual(decodeSegment('D'), [-1]);
  // "abcdefghij": five from a.js, five from b.js; then a line from b.js after three unmapped characters.
  const map = { version: 3, sources: ['a.js', 'b.js'], sourceRoot: 'src/', mappings: 'AAAA,KCAA;GAAA' };
  const sizes = sourceSizes(map, 'abcdefghij\nxyzwv');
  assert.deepEqual(Object.fromEntries(sizes), { 'src/a.js': 5, 'src/b.js': 6 + 2, [UNMAPPED]: 3 });
  assert.equal(sourceSizes({ sections: [] }, 'x'), null);
  // A character that isn't base64 ends its segment's reading (E! is a column alone), sources named
  // alike count as one, a source called [unmapped] is that, and the source index runs past the list.
  const odd = { sources: ['a.js', 'b.js', 'a.js', '[unmapped]'], mappings: 'AAAA,E!CAA,CEAA;;AAAA,CCAA,CAAA,CAAA,Cz;CAAA,EBAA,UGAA' };
  assert.deepEqual([...sourceSizes(odd, 'abcdefgh\n\nxyzwvuts\nqrstuvwxyz\nlast')], [['a.js', 9], [UNMAPPED, 25]]);
  // A minified file's one line of a million segments, in one pass.
  const segments = Array.from({ length: 1_000_000 }, (_, i) => (i % 2 ? 'CDAA' : 'CCAA')).join(',');
  const started = performance.now();
  const big = sourceSizes({ sources: ['x.js', 'y.js'], mappings: `AAAA,${segments}` }, 'z'.repeat(1_000_001));
  assert.deepEqual([...big], [['x.js', 500_001], ['y.js', 500_000]]);
  assert.ok(performance.now() - started < 2000);
  assert.equal(mapUrlOf('x();\n//# sourceMappingURL=main.js.map\n'), 'main.js.map');
  assert.equal(mapUrlOf('x();\n/*# sourceMappingURL=data:application/json;base64,eyJ9 */'), null);
});

test('the module tree: packages grouped with their copies, own files by folder, opened as asked', () => {
  const chunk = finishChunk({
    file: 'dist/a.js',
    sizes: { raw: 1000, gzip: 400, brotli: 350 },
    modules: [
      { id: 'src/pages/Home.jsx', bytes: 100 },
      { id: 'src/pages/About.jsx', bytes: 50 },
      { id: 'node_modules/tslib/tslib.es6.mjs', bytes: 200 },
      { id: 'node_modules/@floating-ui/dom/node_modules/tslib/tslib.es6.mjs', bytes: 200 },
      { id: 'node_modules/lodash/lodash.js', bytes: 450 },
    ],
  });
  const tree = moduleTree([chunk]);
  assert.deepEqual(tree.map((n) => [n.kind, n.label, n.bytes]), [['package', 'lodash', 450], ['package', 'tslib', 400], ['dir', 'src/pages/', 150]]);
  assert.equal(tree[0].size, 180);
  assert.deepEqual(tree[1].children.map((n) => n.kind), ['install', 'install']);
  assert.deepEqual(treeRows(tree, new Set(['dir:src/pages'])).map((r) => `${r.depth}:${r.node.label}`), ['0:lodash', '0:tslib', '0:src/pages/', '1:Home.jsx', '1:About.jsx']);
  const d = duplicates([chunk]);
  assert.deepEqual(d.map((x) => [x.name, x.kind, x.wasted]), [['tslib', 'paths', 200]]);
});
