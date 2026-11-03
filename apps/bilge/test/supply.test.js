// The supply chain (typosquats, install scripts, packages from outside the registry), SARIF and
// bilge security: the pure parts, a lock file on disk, the headless commands and the Packages view
// over the demo.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slip, typosquatOf } from '../src/typosquat.js';
import { npmEntries, origin, pnpmEntries, supplyFindings, withoutIgnoredSupply, yarnEntries } from '../src/supply.js';
import { auditFindings, codeFindings, sarifOf } from '../src/security.js';
import { scanFolder } from '../src/lockfiles.js';
import { parseArgs, runHeadless } from '../src/headless.js';
import { demoBilge } from '../src/demo.js';
import { findings } from '../src/audit.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);

test('typosquats: one slip from a well-known name, not a well-known name itself', () => {
  assert.equal(slip('lodahs', 'lodash'), 'swapped');
  assert.equal(slip('expres', 'express'), 'one letter');
  assert.equal(slip('exprezs', 'express'), 'one letter');
  assert.equal(slip('exrpess', 'express'), 'swapped');
  assert.equal(slip('expers', 'express'), null);
  assert.deepEqual(typosquatOf('crossenv'), { like: 'cross-env', how: 'separators' });
  assert.deepEqual(typosquatOf('lodahs'), { like: 'lodash', how: 'swapped' });
  assert.deepEqual(typosquatOf('expresss'), { like: 'express', how: 'one letter' });
  assert.deepEqual(typosquatOf('axois'), { like: 'axios', how: 'swapped' });
  assert.deepEqual(typosquatOf('Newtonsoft.Jsom', 'NuGet'), { like: 'Newtonsoft.Json', how: 'one letter' });
  for (const real of ['lodash', 'colors', 'color', 'mysql2', 'tslint', 'preact', 'react', 'object.assign', 'cookies']) assert.equal(typosquatOf(real), null, real);
  // Short names only for swapped letters; a scope is its publisher's.
  assert.equal(typosquatOf('qs'), null);
  assert.equal(typosquatOf('mss'), null);
  assert.equal(typosquatOf('@types/lodash'), null);
  assert.equal(typosquatOf('Newtonsoft.Json', 'NuGet'), null);
  assert.equal(typosquatOf('newtonsoft.json', 'NuGet'), null);
});

test('where a package came from: the registry is nothing, git and other URLs are, http is worse', () => {
  assert.equal(origin('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'), null);
  assert.equal(origin('https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#abc'), null);
  assert.equal(origin('file:../shared'), null);
  assert.equal(origin(undefined), null);
  assert.equal(origin('git+ssh://git@github.com/a/b.git#123').from, 'git');
  assert.equal(origin('github:a/b').from, 'git');
  assert.equal(origin('https://example.com/b-1.0.0.tgz').from, 'url');
  assert.equal(origin('http://registry.npmjs.org/b/-/b-1.0.0.tgz').from, 'http');
});

const NPM_LOCK = JSON.stringify(
  {
    name: 'shop',
    lockfileVersion: 3,
    packages: {
      '': { name: 'shop', dependencies: { crossenv: '^7.0.3', 'left-pad': 'github:someone/left-pad' } },
      'node_modules/crossenv': { version: '7.0.3', resolved: 'https://registry.npmjs.org/crossenv/-/crossenv-7.0.3.tgz', hasInstallScript: true },
      'node_modules/esbuild': { version: '0.20.2', resolved: 'https://registry.npmjs.org/esbuild/-/esbuild-0.20.2.tgz', hasInstallScript: true, dev: true },
      'node_modules/left-pad': { version: '1.3.0', resolved: 'git+ssh://git@github.com/someone/left-pad.git#5f2e1a9' },
      'node_modules/tiny': { version: '1.0.0', resolved: 'http://mirror.example.com/tiny-1.0.0.tgz' },
      'node_modules/lodash': { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
      'packages/web': { name: 'web' },
      'node_modules/web': { resolved: 'packages/web', link: true },
    },
  },
  null,
  2,
);

test("npm's lock file: install scripts and where each package came from, with their lines", () => {
  const entries = npmEntries(NPM_LOCK);
  assert.equal(entries.length, 5);
  const crossenv = entries.find((e) => e.name === 'crossenv');
  assert.equal(crossenv.installScript, true);
  assert.equal(NPM_LOCK.split('\n')[crossenv.line - 1].trim(), '"node_modules/crossenv": {');
  const found = supplyFindings(entries, 'package-lock.json');
  assert.deepEqual(found.map((f) => [f.rule, f.package, f.severity]), [
    ['typosquat', 'crossenv', 'high'],
    ['install-script', 'crossenv', 'medium'],
    ['install-script', 'esbuild', 'low'],
    ['not-from-registry', 'left-pad', 'medium'],
    ['http-download', 'tiny', 'high'],
  ]);
  const squat = found[0];
  assert.equal(squat.kind, 'supply');
  assert.equal(squat.where, 'package-lock.json');
  assert.equal(squat.key, 'npm:crossenv@7.0.3');
  assert.match(squat.excerpt, /looks like cross-env/);
  // Lock file 1 has no install scripts, but says where.
  const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0', resolved: 'http://x.example/a.tgz', dependencies: { b: { version: 'github:o/b#abc' } } } } });
  assert.deepEqual(supplyFindings(npmEntries(v1), 'package-lock.json').map((f) => [f.rule, f.package]), [['http-download', 'a'], ['not-from-registry', 'b']]);
});

test("Yarn's and pnpm's lock files: their resolved URLs, pnpm's requiresBuild", () => {
  const yarn1 = [
    '# yarn lockfile v1',
    '',
    'lodahs@^4.17.21:',
    '  version "4.17.21"',
    '  resolved "https://registry.yarnpkg.com/lodahs/-/lodahs-4.17.21.tgz#abc"',
    '',
    '"pad@https://example.com/pad-1.0.0.tgz":',
    '  version "1.0.0"',
    '  resolved "https://example.com/pad-1.0.0.tgz"',
    '',
  ].join('\n');
  assert.deepEqual(supplyFindings(yarnEntries(yarn1), 'yarn.lock').map((f) => [f.rule, f.package, f.line]), [['typosquat', 'lodahs', 3], ['not-from-registry', 'pad', 7]]);
  const berry = ['__metadata:', '  version: 6', '', '"thing@git+https://github.com/o/thing.git":', '  version: 2.0.0', '  resolution: "thing@git+https://github.com/o/thing.git#commit=abc"', '', '"lodash@npm:^4.17.21":', '  version: 4.17.21', '  resolution: "lodash@npm:4.17.21"', ''].join('\n');
  assert.deepEqual(supplyFindings(yarnEntries(berry), 'yarn.lock').map((f) => [f.rule, f.package]), [['not-from-registry', 'thing']]);
  const pnpm = [
    "lockfileVersion: '6.0'",
    '',
    'packages:',
    '',
    '  /esbuild@0.19.0:',
    '    resolution: {integrity: sha512-abc}',
    '    requiresBuild: true',
    '    dev: true',
    '',
    '  /lodash@4.17.21:',
    '    resolution: {integrity: sha512-def}',
    '    dev: false',
    '',
    '  github.com/o/thing/abc123:',
    '    resolution: {tarball: https://codeload.github.com/o/thing/tar.gz/abc123}',
    '    name: thing',
    '    version: 2.0.0',
    '',
  ].join('\n');
  assert.deepEqual(supplyFindings(pnpmEntries(pnpm), 'pnpm-lock.yaml').map((f) => [f.rule, f.package, f.version]), [['install-script', 'esbuild', '0.19.0'], ['not-from-registry', 'thing', '2.0.0']]);
});

test('what supplyIgnore names is left out: a rule, a package, or rule:package', () => {
  const found = supplyFindings(npmEntries(NPM_LOCK), 'package-lock.json');
  assert.equal(withoutIgnoredSupply(found, ['install-script']).length, 3);
  assert.equal(withoutIgnoredSupply(found, ['crossenv']).length, 3);
  assert.equal(withoutIgnoredSupply(found, ['typosquat:crossenv']).length, 4);
});

test('a folder on disk: each manifest carries its supply findings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bilge-supply-'));
  try {
    writeFileSync(join(dir, 'package-lock.json'), NPM_LOCK);
    const scan = scanFolder(dir);
    assert.equal(scan.manifests[0].supply.length, 5);
    assert.ok(scan.packages.some((p) => p.name === 'left-pad'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the audit's and the code's findings in the shared shape, and SARIF from them", async () => {
  const provider = demoBilge();
  const scan = await provider.scan('/shop');
  const { ids, details } = await provider.audit(scan.packages);
  const list = auditFindings(findings(scan.packages, ids, details));
  const minimist = list.find((f) => f.package === 'minimist');
  assert.deepEqual([minimist.rule, minimist.severity, minimist.where, minimist.line, minimist.fixed, minimist.kind], ['GHSA-xvch-5gv4-984h', 'critical', 'package-lock.json', 48, '1.2.6', 'dependency']);
  // One per advisory: lodash has two.
  assert.equal(list.filter((f) => f.package === 'lodash').length, 2);
  const code = codeFindings((await provider.code('/shop')).findings);
  assert.ok(code.every((f) => !('key' in f) && !('path' in f) && f.where));
  assert.ok(code.filter((f) => f.rule === 'env-committed').every((f) => !('line' in f)));
  const sarif = sarifOf([...list, ...code], '1.2.3');
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].tool.driver.name, 'Bilge');
  const result = sarif.runs[0].results.find((r) => r.ruleId === 'GHSA-xvch-5gv4-984h');
  assert.equal(result.level, 'error');
  assert.deepEqual(result.locations[0].physicalLocation, { artifactLocation: { uri: 'package-lock.json' }, region: { startLine: 48 } });
});

test('--sarif: to the output alone, or to a file beside the text; the folder goes before it', async () => {
  assert.equal(parseArgs(['audit', '--sarif']).sarif, '-');
  assert.equal(parseArgs(['audit', 'web', '--sarif', 'out.sarif']).sarif, 'out.sarif');
  assert.deepEqual([parseArgs(['audit', 'web', '--sarif', 'out.sarif']).dir], ['web']);
  assert.equal(parseArgs(['code', '--sarif=x.sarif', '--json']).sarif, 'x.sarif');
  assert.equal(parseArgs(['code', '--sarif', '--fail-on', 'low']).failOn, 'low');
  assert.match(parseArgs(['audit', '--sarif', '--json']).error, /both want the output/);
  assert.match(parseArgs(['sbom', '--sarif']).error, /--sarif is for/);

  let out = '';
  assert.equal(await runHeadless(['audit', '.', '--sarif'], { provider: demoBilge(), write: (s) => (out += s) }), 1);
  const sarif = JSON.parse(out);
  assert.ok(sarif.runs[0].results.some((r) => r.ruleId === 'GHSA-35jh-r3h4-6jhm'));

  out = '';
  const provider = demoBilge();
  assert.equal(await runHeadless(['code', '.', '--sarif', 'code.sarif', '--fail-on', 'none'], { provider, write: (s) => (out += s) }), 0);
  assert.match(out, /AWS access key/);
  assert.match(out, /SARIF in .*code\.sarif/);
  assert.match(provider.state.written.path, /code\.sarif$/);
  const written = JSON.parse(provider.state.written.text);
  assert.ok(written.runs[0].results.some((r) => r.ruleId === 'aws-key'));
  // A secret's excerpt never goes into the SARIF.
  assert.ok(!provider.state.written.text.includes('AKIA'));
});

test('bilge supply: the demo\'s typosquat, install scripts and git package, exiting on the typosquat', async () => {
  let out = '';
  assert.equal(await runHeadless(['supply', '.'], { provider: demoBilge(), write: (s) => (out += s) }), 1);
  assert.match(out, /HIGH Name like a well-known package: crossenv {2}package-lock\.json:18/);
  assert.match(out, /MED {2}Not from npm's registry: left-pad {2}package-lock\.json:38/);
  assert.match(out, /1 high · 2 medium · 1 low · failing on high and above/);
  out = '';
  assert.equal(await runHeadless(['supply', '--json'], { provider: demoBilge(), config: { supplyIgnore: ['typosquat:crossenv'] }, write: (s) => (out += s) }), 0);
  const j = JSON.parse(out);
  assert.equal(j.app, 'bilge');
  assert.equal(j.check, 'supply');
  assert.deepEqual(j.counts, { critical: 0, high: 0, medium: 2, low: 1, unknown: 0 });
});

test('bilge security: the audit, the code and the supply chain in the family\'s security JSON', async () => {
  let out = '';
  const provider = demoBilge();
  assert.equal(await runHeadless(['security', '.', '--json'], { provider, config: { codeIgnore: ['aws-key'] }, write: (s) => (out += s) }), 1);
  const j = JSON.parse(out);
  assert.deepEqual(Object.keys(j), ['app', 'check', 'target', 'at', 'counts', 'findings']);
  assert.equal(j.check, 'security');
  assert.equal(j.target, process.cwd());
  assert.deepEqual([...new Set(j.findings.map((f) => f.kind))].sort(), ['code', 'config', 'dependency', 'secret', 'supply']);
  assert.ok(j.findings.every((f) => f.rule && f.severity && f.title && f.where !== undefined));
  assert.ok(j.findings.every((f) => !('excerpt' in f)));
  assert.ok(!j.findings.some((f) => f.rule === 'aws-key'));
  assert.equal(j.counts.critical, 2);
  // OSV asked afresh, as bilge audit is.
  assert.deepEqual(provider.state.calls.find((c) => c[0] === 'audit').at(-1), 'fresh');
  out = '';
  assert.equal(await runHeadless(['security', '.', '--fail-on', 'none'], { provider: demoBilge(), write: (s) => (out += s) }), 0);
  assert.match(out, /^17 packages in 3 manifests, 10 files read under /);
  assert.match(out, /CRIT AWS access key {2}src\/config\.js:1/);
});

test('the Packages view: /packages supply lists them, ↵ says what, x ignores one; /sarif writes them all', async () => {
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  await type(app.stdin, '/packages supply');
  app.stdin.write(KEYS.enter);
  await until(shows(app, '3 supply'), 'the supply ones');
  const frame = app.lastFrame();
  assert.match(frame, /crossenv .*typo\?/);
  assert.match(frame, /esbuild .*script/);
  assert.match(frame, /left-pad .*source/);
  assert.ok(!frame.includes('lodash'));
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Supply chain:'), 'the details');
  assert.match(app.lastFrame(), /crossenv looks like cross-env/);
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Supply chain:'), 'the list again');
  app.stdin.write('x');
  await until(shows(app, 'Ignore 2 supply-chain findings on crossenv?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(shows(app, '2 supply'), 'one fewer');
  assert.doesNotMatch(app.lastFrame(), /crossenv +7\.0\.3/);
  await type(app.stdin, '/sarif');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.written?.path?.endsWith('bilge.sarif'), 'the SARIF');
  const sarif = JSON.parse(app.provider.state.written.text);
  const rules = new Set(sarif.runs[0].results.map((r) => r.ruleId));
  for (const id of ['GHSA-xvch-5gv4-984h', 'aws-key', 'install-script', 'not-from-registry']) assert.ok(rules.has(id), id);
  assert.ok(!rules.has('typosquat'), 'what x ignored stays out');
  app.unmount();
});
