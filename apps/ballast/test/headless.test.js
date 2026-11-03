// bilge-ignore-file: the made-up key in the built file below is there to be found.
// ballast check, compare and security, over the demo and over a folder on the disk: the text, the
// JSON, the exit codes, budgets given here or in ballast.json, growth against a base, and nothing
// built unless --build says so.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs, runHeadless } from '../src/headless.js';
import { demoBallast, DEMO_MAIN } from '../src/demo.js';
import { createBallast } from '../src/provider.js';
import { loadRuns } from '../src/history.js';

let home;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ballast-home-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function headless(args, provider = demoBallast(), config = {}) {
  let out = '';
  const code = await runHeadless(args, { provider, config, write: (s) => (out += s), version: '9.9.9' });
  return { code, out, provider };
}

test('ballast check: a file over its budget fails (exit 1), and says which', async () => {
  const { code, out } = await headless(['check', '/demo/shop']);
  assert.equal(code, 1);
  assert.match(out, /^5 files under .*shop \(rollup-plugin-visualizer data, dist\/stats\.json\): 190\.0 kB gzip/);
  assert.match(out, /OVER {2}dist\/assets\/index-\*\.js {2}112\.7 kB gzip > 100\.0 kB {2}\(dist\/assets\/index-B7xk2Lq9\.js\)/);
  assert.match(out, /ok {4}total {2}190\.0 kB gzip ≤ 250\.0 kB/);
  // ballast.json's failOn has growth>10% too: against the last build, only +0.2%.
  assert.match(out, /Against the last build \(b4d5e6f, .*\): \+465 B gzip \(\+0\.2%\)/);
  assert.match(out, /ok {4}growth>10%: grew 0\.2%/);
  assert.match(out, /Failing: budget dist\/assets\/index-\*\.js/);
});

test('ballast check --budget replaces the file\'s for the same glob; --fail-on growth>5% --base main fails on the growth', async () => {
  const { code, out } = await headless(['check', '/demo/shop', '--budget', 'dist/assets/index-*.js=180kB', '--fail-on', 'growth>5%', '--base', 'main']);
  assert.equal(code, 1);
  assert.match(out, /ok {4}dist\/assets\/index-\*\.js {2}112\.7 kB gzip ≤ 180\.0 kB/);
  assert.match(out, /Against main \(a1b2c3d, .*\): \+51\.5 kB gzip, from date-fns 4 now imported whole \(\+37\.2%\)/);
  assert.match(out, /FAIL {2}growth>5%: grew 37\.2%/);
  assert.match(out, /Failing: growth>5%$/m);
  const ok = await headless(['check', '/demo/shop', '--budget=dist/assets/index-*.js=180kB', '--fail-on', 'growth>60%', '--base', 'main', '--measure', 'brotli']);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /Within its budgets\./);
  assert.match(ok.out, /kB brotli/);
});

test('ballast check --json: every budget, the base and the growth, and what fails; the run is kept', async () => {
  const { code, out, provider } = await headless(['check', '/demo/shop', '--json', '--base', 'main']);
  assert.equal(code, 1);
  const j = JSON.parse(out);
  assert.equal(j.measure, 'gzip');
  assert.deepEqual(j.budgets.map((b) => [b.pattern, b.limit, b.over]), [['dist/assets/index-*.js', 100000, true], ['total', 250000, false]]);
  assert.equal(j.base.name, 'main');
  assert.equal(j.base.commit, DEMO_MAIN);
  assert.equal(j.growth.headline, '+51.5 kB gzip, from date-fns 4 now imported whole');
  assert.deepEqual(j.failing, ['budget dist/assets/index-*.js', 'growth>10%']);
  assert.ok(provider.state.calls.some((c) => c[0] === 'saveRun'));
});

test("growth against main whose build isn't kept: said, with --build and --base-stats offered; --build builds it in a worktree", async () => {
  const off = await headless(['check', '/demo/shop', '--fail-on', 'growth>5%', '--base', 'main'], demoBallast({ mainSaved: false }));
  assert.equal(off.code, 0);
  assert.match(off.out, /Not compared: No build of main \(a1b2c3d\) has been read yet\. --build builds it in a git worktree, or --base-stats <file>/);
  assert.match(off.out, /---- {2}growth>5%: not checked, nothing to compare with/);
  const on = await headless(['check', '/demo/shop', '--fail-on', 'growth>5%', '--base', 'main', '--build'], demoBallast({ mainSaved: false }));
  assert.equal(on.code, 1);
  assert.match(on.out, /Building main \(a1b2c3d\) in a git worktree…/);
  assert.ok(on.provider.state.calls.some((c) => c[0] === 'buildRef' && c[1] === DEMO_MAIN));
  assert.ok(on.provider.state.runs.some((r) => r.commit === DEMO_MAIN));
});

test('ballast compare --base main --markdown: the table for a pull request; plain text and --json too', async () => {
  const md = await headless(['compare', '/demo/shop', '--base', 'main', '--markdown']);
  assert.equal(md.code, 0);
  assert.match(md.out, /^### Bundle size: \+51\.5 kB gzip \(\+37\.2%\)/);
  assert.match(md.out, /\| \*\*Total\*\* \| 138\.5 kB \| 190\.0 kB \|/);
  const text = await headless(['compare', '/demo/shop', '--base', 'main']);
  assert.match(text.out, /^\+51\.5 kB gzip, from date-fns 4 now imported whole \(\+37\.2%\)\nAgainst main/);
  assert.match(text.out, /more {2}dist\/assets\/index-\[hash\]\.js {2}61\.2 kB → 112\.7 kB/);
  assert.match(text.out, /^ +\+48\.3 kB {2}date-fns 4 now imported whole$/m);
  const j = JSON.parse((await headless(['compare', '/demo/shop', '--base', 'main', '--json'])).out);
  assert.ok(j.total.delta > 51400 && j.total.delta < 51600);
  assert.equal(j.packages[0].reason, 'date-fns 4 now imported whole');
  // Written to a file: the provider's writeFile, and a line saying where.
  const file = await headless(['compare', '/demo/shop', '--markdown', '-o', 'size.md']);
  assert.match(file.out, /written to .*size\.md/);
  assert.match([...file.provider.state.written.values()][0], /### Bundle size/);
});

test('ballast compare with nothing to compare with exits 2 and says why; bad arguments exit 2', async () => {
  const p = demoBallast();
  p.state.runs = [];
  const none = await headless(['compare', '/demo/shop'], p);
  assert.equal(none.code, 2);
  assert.match(none.out, /No earlier build of this project has been read/);
  assert.equal((await headless(['check', '--budget', 'x'])).code, 2);
  assert.match(parseArgs(['check', '--fail-on', 'sometimes']).error, /--fail-on is budget/);
  assert.match(parseArgs(['check', '--measure', 'weight']).error, /--measure is gzip, brotli or raw/);
  assert.match(parseArgs(['compare', '--markdown', '--json']).error, /not both/);
  assert.match(parseArgs(['check', '--sarif']).error, /--sarif is for security/);
  assert.match(parseArgs(['check', '--base']).error, /--base needs a value/);
  assert.match(parseArgs(['check', '--nope']).error, /Unknown option --nope/);
});

test("ballast security --json: the family's security JSON, source maps and the key in the bundle, the key never in it", async () => {
  const { code, out } = await headless(['security', '/demo/shop', '--json']);
  assert.equal(code, 1);
  const j = JSON.parse(out);
  assert.equal(j.app, 'ballast');
  assert.equal(j.check, 'security');
  assert.deepEqual(j.counts, { critical: 1, high: 0, medium: 1, low: 0, unknown: 0 });
  assert.deepEqual(j.findings.map((f) => [f.rule, f.where, f.line ?? null]), [['stripe-key', 'dist/assets/index-B7xk2Lq9.js', 1], ['source-map', 'dist', null]]);
  assert.ok(!out.includes('Zq8Xv3Lm0Rt5Wy2Bn7Kd4Hs9'));
  assert.ok(j.findings.every((f) => !('excerpt' in f)));
  // --fail-on none never fails; the config's securityIgnore leaves a rule out; --sarif writes SARIF.
  assert.equal((await headless(['security', '/demo/shop', '--fail-on', 'none'])).code, 0);
  const ignored = await headless(['security', '/demo/shop', '--json'], demoBallast(), { securityIgnore: ['stripe-key'] });
  assert.equal(ignored.code, 0);
  const sarif = await headless(['security', '/demo/shop', '--sarif', 'ballast.sarif']);
  const written = JSON.parse([...sarif.provider.state.written.values()][0]);
  assert.equal(written.runs[0].tool.driver.name, 'Ballast');
  assert.deepEqual(written.runs[0].results.map((r) => r.ruleId), ['stripe-key', 'source-map']);
});

test('over a folder on the disk: budgets from ballast.json, nothing built unasked, security of dist/', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ballast-project-'));
  const put = (p, t) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  };
  try {
    const run = async (command) => {
      if (command.startsWith('git')) throw Object.assign(new Error('not a git repository'), { code: 128 });
      throw new Error(`nothing else runs here: ${command}`);
    };
    const provider = createBallast({ home, run });
    put('package.json', JSON.stringify({ name: 'site', scripts: { build: 'vite build' }, devDependencies: { vite: '^5.4.0' } }));
    const none = await headless(['check', dir], provider);
    assert.equal(none.code, 2);
    assert.match(none.out, /Nothing to read under .*: no stats file and no output folder .* --build runs npx vite build --sourcemap/);
    put('ballast.json', JSON.stringify({ budgets: { 'dist/assets/*.js': '2kB' } }));
    // Text that compresses badly: random letters, so the gzip size is over the budget.
    let seed = 7;
    const noise = Array.from({ length: 9000 }, () => String.fromCharCode(97 + ((seed = (seed * 48271) % 2147483647) % 26))).join('');
    put('dist/assets/app-Q1w2E3r4.js', `const t="${noise}";const k="${['AKIA', 'Z7Q2VXK4M9TBLR3E'].join('')}";`);
    put('dist/assets/app-Q1w2E3r4.js.map', JSON.stringify({ version: 3, sources: ['../../src/app.js'], sourcesContent: ['const t = 1'], mappings: 'AAAA' }));
    const over = await headless(['check', dir, '--json'], provider);
    assert.equal(over.code, 1);
    const j = JSON.parse(over.out);
    assert.equal(j.source, 'dist/ and its source maps');
    assert.equal(j.budgets[0].over, true);
    assert.equal(j.base, null);
    const sec = await headless(['security', dir], provider);
    assert.equal(sec.code, 1);
    assert.match(sec.out, /CRIT AWS access key in the bundle {2}dist\/assets\/app-Q1w2E3r4\.js:1/);
    assert.match(sec.out, /MED {2}Source map shipped in dist \(1\) {2}dist\/assets\/app-Q1w2E3r4\.js\.map/);
    // The run was kept, under the home given.
    assert.equal(loadRuns(home, dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
