// bilge-ignore-file: the made-up keys in these built files are there to be found.
// The provider over folders on the disk: an output folder and its source maps, stats files found and
// their chunks sized from the files, versions and licences from the lock file, the budgets file, the
// security read, and the build with stats run through a stand-in for run.js.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createBallast } from '../src/provider.js';
import { findStatsFiles, readBudgetsFile, readBuild, readSecurity } from '../src/disk.js';
import { buildPlan, installCommand, safeRef } from '../src/buildplan.js';
import { pieces } from '../src/security.js';

let dir;
let home;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ballast-project-'));
  home = mkdtempSync(join(tmpdir(), 'ballast-home-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const put = (path, text) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

const LOCK = {
  name: 'shop',
  lockfileVersion: 3,
  packages: {
    '': { name: 'shop', dependencies: { lodash: '^4.17.21', 'chart-kit': '^2.0.0' } },
    'node_modules/lodash': { version: '4.17.21', license: 'MIT' },
    'node_modules/chart-kit': { version: '2.1.0', license: 'Apache-2.0' },
    'node_modules/chart-kit/node_modules/lodash': { version: '3.10.1', license: 'MIT' },
  },
};

// A built file of 'a' * n from src/main.js and 'b' * m from lodash, with its map beside it.
function builtWithMap(path, a, b, { sourcesContent = false } = {}) {
  const code = `${'a'.repeat(a)}${'b'.repeat(b)}\n//# sourceMappingURL=${path.split('/').pop()}.map\n`;
  put(path, code);
  // Sources are relative to the map's folder (dist/assets → the project is two up).
  const map = { version: 3, sources: ['../../src/main.js', '../../node_modules/lodash/lodash.js'], mappings: `AAAA,${b ? 'gBCAA' : ''}`, ...(sourcesContent ? { sourcesContent: ['x', 'y'] } : {}) };
  // gB is 16: only right for a = 16.
  put(`${path}.map`, JSON.stringify(map));
  return code;
}

test('an output folder: each file sized raw, gzip and brotli, and its source map says what is inside', async () => {
  put('package-lock.json', JSON.stringify(LOCK));
  const code = builtWithMap('dist/assets/index-Ab12Cd34.js', 16, 84);
  put('dist/index.html', '<!doctype html><script src="/assets/index-Ab12Cd34.js"></script>');
  put('dist/logo.png', Buffer.alloc(300, 7));
  const build = await readBuild(dir);
  assert.equal(build.source.kind, 'files');
  assert.match(build.source.label, /dist\/ and its source maps/);
  const files = build.chunks.map((c) => c.file).sort();
  assert.deepEqual(files, ['dist/assets/index-Ab12Cd34.js', 'dist/index.html', 'dist/logo.png']);
  const js = build.chunks.find((c) => c.file.endsWith('.js'));
  assert.equal(js.raw, Buffer.byteLength(code));
  assert.equal(js.gzip, gzipSync(Buffer.from(code), { level: 9 }).length);
  assert.ok(js.brotli > 0 && js.brotli < js.raw);
  assert.equal(js.name, 'dist/assets/index-[hash].js');
  const lodash = js.modules.find((m) => m.pkg?.name === 'lodash');
  assert.equal(lodash.id, 'node_modules/lodash/lodash.js');
  assert.equal(lodash.pkg.version, '4.17.21');
  assert.ok(js.modules.some((m) => m.id === 'src/main.js'));
  assert.equal(build.licences['lodash@4.17.21'], 'MIT');
  // An image isn't compressed by a server: its sizes are its bytes.
  const png = build.chunks.find((c) => c.file.endsWith('.png'));
  assert.deepEqual([png.raw, png.gzip, png.brotli], [300, 300, 300]);
});

test('a stats file is found (the newest), its chunks sized from the files on the disk, versions from the lock file', async () => {
  put('package-lock.json', JSON.stringify(LOCK));
  // webpack's stats, made on another machine: its outputPath isn't here, so build/ is looked in.
  const stats = JSON.parse(readFileSync(new URL('./fixtures/webpack-stats.json', import.meta.url), 'utf8'));
  put('build/static/js/vendors.8c2d4e6f.js', 'v'.repeat(5000));
  put('build/static/js/main.3f9a1c2e.js', 'm'.repeat(2000));
  put('stats.json', JSON.stringify(stats));
  put('dist/meta.json', '{"not":"stats"}');
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(dir, 'dist/meta.json'), old, old);
  assert.equal(findStatsFiles(dir)[0].path, join(dir, 'stats.json'));
  const build = await readBuild(dir);
  assert.equal(build.tool, 'webpack');
  assert.equal(build.source.label, 'webpack stats, stats.json');
  const vendors = build.chunks.find((c) => c.file === 'build/static/js/vendors.8c2d4e6f.js');
  assert.equal(vendors.raw, 5000);
  assert.ok(vendors.gzip < 100);
  // The modules scaled to the file on the disk.
  assert.ok(Math.abs(vendors.modules.reduce((n, m) => n + m.bytes, 0) - 5000) <= vendors.modules.length);
  // A chunk the disk hasn't is named as the stats name it, with their size and no compression.
  const lazy = build.chunks.find((c) => c.file === 'static/js/412.a1b2c3d4.chunk.js');
  assert.deepEqual([lazy.raw, lazy.gzip], [22018, null]);
  const nested = lazy.modules.find((m) => m.pkg?.installPath === 'node_modules/chart-kit/node_modules/lodash');
  assert.equal(nested.pkg.version, '3.10.1');
  assert.equal(build.licences['chart-kit@2.1.0'], 'Apache-2.0');
});

test("esbuild's metafile names outputs from the project's folder; a stats file named is read even when others are newer", async () => {
  put('dist/main.js', 'x'.repeat(11102));
  put('dist/main.css', 'y'.repeat(6149));
  put('reports/esbuild.json', readFileSync(new URL('./fixtures/esbuild-meta.json', import.meta.url), 'utf8'));
  put('stats.json', JSON.stringify({ outputs: {}, inputs: {} }));
  const build = await readBuild(dir, { statsPath: 'reports/esbuild.json' });
  assert.equal(build.tool, 'esbuild');
  const main = build.chunks.find((c) => c.file === 'dist/main.js');
  assert.equal(main.raw, 11102);
  assert.ok(main.gzip != null);
  await assert.rejects(() => readBuild(dir, { statsPath: 'package.json' }), /Couldn't read package\.json/);
  put('notstats.json', '{"a":1}');
  await assert.rejects(() => readBuild(dir, { statsPath: 'notstats.json' }), /isn't stats Ballast reads/);
});

test('nothing built: kind none, no chunks', async () => {
  const build = await readBuild(dir);
  assert.equal(build.source.kind, 'none');
  assert.deepEqual(build.chunks, []);
});

test('budgets from ballast.json, else the "ballast" key of package.json\'s fleet section; what doesn\'t read is said', () => {
  put('package.json', JSON.stringify({ name: 'shop', fleet: { ballast: { budgets: [{ path: 'dist/*.js', max: '50 kB' }], failOn: 'growth>10kB' } } }));
  let b = readBudgetsFile(dir);
  assert.equal(b.from, 'package.json (fleet.ballast)');
  assert.deepEqual(b.budgets, [{ pattern: 'dist/*.js', limit: 50000 }]);
  assert.deepEqual(b.failOn, [{ kind: 'growth', bytes: 10000, text: 'growth>10kB' }]);
  put('ballast.json', JSON.stringify({ budgets: { 'dist/assets/index-*.js': '180kB', total: 'lots' }, measure: 'brotli', failOn: ['budget', 'growth>5%', 'sometimes'] }));
  b = readBudgetsFile(dir);
  assert.equal(b.from, 'ballast.json');
  assert.equal(b.measure, 'brotli');
  assert.deepEqual(b.budgets, [{ pattern: 'dist/assets/index-*.js', limit: 180000 }]);
  assert.deepEqual(b.failOn.map((c) => c.text), ['budget', 'growth>5%']);
  assert.equal(b.errors.length, 2);
  rmSync(join(dir, 'ballast.json'));
  rmSync(join(dir, 'package.json'));
  assert.equal(readBudgetsFile(dir).from, null);
});

test('the security read: source maps shipped (with the source in them), and a key in a minified line found and redacted', () => {
  const key = ['AKIA', 'Z7Q2', 'VXK4', 'M9TB', 'LR3E'].join('');
  // One line of 9000 characters, as a minifier writes it, with the key far into it.
  const line = `${'var a=1,b=2;'.repeat(500)}const k="${key}";${'function f(){return 1}'.repeat(100)}`;
  put('dist/assets/index-Ab12Cd34.js', `/*! licence */\n${line}\n`);
  builtWithMap('dist/assets/other-Zz98Yy76.js', 16, 0, { sourcesContent: true });
  put('dist/robots.txt', 'User-agent: *');
  const r = readSecurity(dir);
  assert.deepEqual(r.dirs, ['dist']);
  const secret = r.findings.find((f) => f.rule === 'aws-key');
  assert.ok(secret, 'the key');
  assert.equal(secret.where, 'dist/assets/index-Ab12Cd34.js');
  assert.equal(secret.line, 2);
  assert.ok(!secret.excerpt.includes(key));
  assert.equal(secret.kind, 'secret');
  const maps = r.findings.find((f) => f.rule === 'source-map');
  assert.equal(maps.severity, 'medium');
  assert.equal(maps.where, 'dist/assets/other-Zz98Yy76.js.map');
  // Pieces of a long line cover all of it, none longer than codescan reads.
  const p = pieces('x'.repeat(5000));
  assert.ok(p.every((s) => s.length <= 2000));
  assert.ok(p.join('').length >= 5000);
});

test('how a project builds with stats, and the commands that need checking', () => {
  const temp = join(tmpdir(), 'ballast-x');
  assert.equal(buildPlan({ pkg: { devDependencies: { vite: '^5' } }, temp }).command, `npx vite build --sourcemap --emptyOutDir --outDir "${temp}/vite"`);
  assert.equal(buildPlan({ pkg: { devDependencies: { webpack: '^5' } }, temp }).command, `npx webpack --mode production --json "${temp}/stats.json"`);
  assert.equal(buildPlan({ pkg: { scripts: { build: 'esbuild src/app.ts --bundle --minify --outdir=dist' } }, temp }).command, `npx esbuild src/app.ts --bundle --minify --outdir=dist --metafile="${temp}/meta.json"`);
  assert.equal(buildPlan({ pkg: { scripts: { build: 'esbuild a.ts --bundle && cp x y' } }, temp }).command, 'npm run build');
  assert.equal(buildPlan({ pkg: { scripts: { build: 'next build' } }, files: new Set(['pnpm-lock.yaml']), temp }).command, 'pnpm run build');
  assert.equal(buildPlan({ pkg: {}, temp }), null);
  assert.equal(buildPlan({ pkg: { devDependencies: { vite: '1' } }, temp: 'a"b' }), null);
  assert.equal(installCommand(new Set(['package-lock.json'])), 'npm ci');
  assert.equal(installCommand(new Set(['yarn.lock', '.yarnrc.yml'])), 'yarn install --immutable');
  assert.equal(installCommand(new Set(['pnpm-lock.yaml'])), 'pnpm install --frozen-lockfile');
  assert.ok(safeRef('main') && safeRef('origin/main') && safeRef('v1.2.3') && safeRef('a1b2c3d'));
  assert.ok(!safeRef('-x') && !safeRef('main;rm') && !safeRef('a..b') && !safeRef('$(x)'));
});

/** A stand-in for run.js: records each command, and plays the build (writing what it would) and git. */
function fakeRun(log, { onBuild } = {}) {
  return async (command, { cwd } = {}) => {
    log.push({ command, cwd });
    if (command === 'git rev-parse HEAD') return { stdout: 'c0ffee15e2a94b7d8f3a6c1e0b9d2f4a7c8e5d13\n', stderr: '' };
    if (command === 'git rev-parse --abbrev-ref HEAD') return { stdout: 'feature/x\n', stderr: '' };
    if (command.startsWith('git status')) return { stdout: '', stderr: '' };
    if (command.startsWith('git rev-parse --verify')) return { stdout: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n', stderr: '' };
    if (command === 'git rev-parse --show-prefix') return { stdout: '\n', stderr: '' };
    if (command === 'git rev-parse --show-toplevel') return { stdout: `${dir}\n`, stderr: '' };
    if (command.startsWith('git worktree add')) {
      const tree = /"([^"]+)"/.exec(command)[1];
      mkdirSync(tree, { recursive: true });
      writeFileSync(join(tree, 'package.json'), JSON.stringify({ devDependencies: { webpack: '^5' } }));
      writeFileSync(join(tree, 'package-lock.json'), JSON.stringify(LOCK));
      return { stdout: '', stderr: '' };
    }
    if (command.startsWith('git worktree remove')) {
      rmSync(/"([^"]+)"/.exec(command)[1], { recursive: true, force: true });
      return { stdout: '', stderr: '' };
    }
    if (onBuild && /webpack|vite/.test(command)) onBuild(command, cwd);
    return { stdout: '', stderr: '' };
  };
}

test('the build with stats: run where the project is, read from what it wrote, its folder removed after', async () => {
  put('package.json', JSON.stringify({ devDependencies: { webpack: '^5.94.0' } }));
  const log = [];
  let wrote = null;
  const provider = createBallast({
    home,
    run: fakeRun(log, {
      onBuild: (command) => {
        wrote = /--json "([^"]+)"/.exec(command)[1];
        mkdirSync(dirname(wrote), { recursive: true });
        writeFileSync(wrote, readFileSync(new URL('./fixtures/webpack-stats.json', import.meta.url)));
      },
    }),
  });
  assert.equal((await provider.read(dir)).chunks.length, 0);
  const plan = provider.plan(dir);
  assert.equal(plan.tool, 'webpack');
  const build = await provider.build(dir, plan);
  assert.equal(build.tool, 'webpack');
  assert.equal(build.chunks.length, 5);
  assert.deepEqual(log.map((l) => [l.command.split(' ').slice(0, 2).join(' '), l.cwd]), [['npx webpack', dir]]);
  // Ballast's own folder for the stats is gone.
  assert.throws(() => readFileSync(wrote));
  assert.deepEqual(await provider.git(dir), { commit: 'c0ffee15e2a94b7d8f3a6c1e0b9d2f4a7c8e5d13', branch: 'feature/x', dirty: false });
});

test("a ref's build in a git worktree: added, installed from its lock file, built with stats, removed", async () => {
  const log = [];
  const provider = createBallast({
    home,
    run: fakeRun(log, {
      onBuild: (command) => {
        const stats = /--json "([^"]+)"/.exec(command)[1];
        mkdirSync(dirname(stats), { recursive: true });
        writeFileSync(stats, readFileSync(new URL('./fixtures/webpack-stats.json', import.meta.url)));
      },
    }),
  });
  const commit = await provider.resolveRef(dir, 'main');
  assert.equal(commit, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  const steps = [];
  const build = await provider.buildRef(dir, commit, { progress: (p) => steps.push(p) });
  assert.equal(build.chunks.length, 5);
  const commands = log.map((l) => l.command);
  assert.match(commands.find((c) => c.startsWith('git worktree add')), /^git worktree add --detach ".+" a1b2c3d4e5f60718293a4b5c6d7e8f9012345678$/);
  assert.ok(commands.includes('npm ci'));
  assert.ok(commands.some((c) => c.startsWith('npx webpack --mode production --json')));
  assert.ok(commands.at(-1).startsWith('git worktree remove --force'));
  assert.deepEqual(steps, ['making the worktree', 'installing its packages', 'building (webpack)']);
  // The ref must be one Ballast puts in a command line.
  await assert.rejects(() => provider.buildRef(dir, 'main; rm -rf /'), /isn't a commit/);
  assert.equal(await provider.resolveRef(dir, '$(boom)'), null);
});
