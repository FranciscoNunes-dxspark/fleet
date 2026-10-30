// Fixes, the bill of materials and bilge audit in a pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixPlan, safe } from '../src/fix.js';
import { cyclonedx, purlOf } from '../src/sbom.js';
import { parseArgs, runHeadless } from '../src/headless.js';
import { markdownReport } from '../src/share.js';
import { demoBilge } from '../src/demo.js';

const finding = (pkg, fixed = '4.17.21') => ({ pkg: { ecosystem: 'npm', direct: true, dev: false, where: [{ path: 'package-lock.json' }], ...pkg }, fixed, advisories: [] });
const npmLock = { path: 'web/package-lock.json', dir: '/srv/shop/web', kind: 'lock' };

test('a fix: npm install for a direct package, npm update and an override for one brought in, dotnet add for NuGet', () => {
  assert.deepEqual(fixPlan(finding({ name: 'lodash', version: '4.17.20' }), npmLock).run, { command: 'npm install lodash@^4.17.21', cwd: '/srv/shop/web' });
  assert.equal(fixPlan(finding({ name: 'typescript', version: '5.0.0', dev: true }, '5.4.5'), npmLock).run.command, 'npm install typescript@^5.4.5 --save-dev');
  const transitive = fixPlan(finding({ name: 'minimist', version: '1.2.5', direct: false }, '1.2.6'), npmLock);
  assert.equal(transitive.run.command, 'npm update minimist');
  assert.match(transitive.text, /"overrides": \{ "minimist": "\^1\.2\.6" \}/);
  const nuget = fixPlan(finding({ ecosystem: 'NuGet', name: 'Newtonsoft.Json', version: '12.0.1' }, '13.0.1'), { path: 'src/Api/packages.lock.json', dir: '/srv/shop/src/Api', kind: 'lock', project: '/srv/shop/src/Api/Api.csproj' });
  assert.deepEqual(nuget.run, { command: 'dotnet add "Api.csproj" package Newtonsoft.Json --version 13.0.1', cwd: '/srv/shop/src/Api' });
  assert.equal(fixPlan(finding({ name: 'x', version: '1.0.0' }, null), npmLock), null);
  assert.equal(fixPlan(finding({ name: 'x', version: '1.0.0' }), { ...npmLock, kind: 'manifest' }).run, undefined);
  // Nothing that isn't a package's name or version goes into a command line.
  assert.equal(fixPlan(finding({ name: 'x; rm -rf /', version: '1.0.0' }), npmLock).run, undefined);
  assert.equal(safe('npm', '@scope/pkg.js', '1.2.3-rc.1'), true);
  assert.equal(safe('npm', 'pkg', '1.0.0 && echo'), false);
  assert.equal(safe('NuGet', 'Microsoft.Data.SqlClient', '5.1.3'), true);
});

test('the bill of materials: CycloneDX 1.5 with purls, licences, scopes and the advisories', () => {
  const packages = [
    { key: 'npm:@scope/a@1.0.0', ecosystem: 'npm', name: '@scope/a', version: '1.0.0', dev: true, license: 'MIT' },
    { key: 'NuGet:serilog@3.1.1', ecosystem: 'NuGet', name: 'Serilog', version: '3.1.1', dev: false },
  ];
  assert.equal(purlOf(packages[0]), 'pkg:npm/%40scope/a@1.0.0');
  const found = [{ pkg: packages[1], advisories: [{ id: 'GHSA-1', url: 'https://osv.dev/vulnerability/GHSA-1', severity: 'high', score: 7.5, summary: 'bad', fixed: '3.1.2' }] }];
  const bom = cyclonedx({ name: 'shop', packages, found, licences: new Map([['NuGet:serilog@3.1.1', { license: 'Apache-2.0 OR MIT' }]]), tool: { name: 'Bilge', version: '1.0.0' }, now: new Date('2026-10-30T00:00:00Z'), serial: 'abc' });
  assert.equal(bom.bomFormat, 'CycloneDX');
  assert.equal(bom.serialNumber, 'urn:uuid:abc');
  assert.deepEqual(bom.components.map((c) => [c.purl, c.scope, c.licenses]), [
    ['pkg:npm/%40scope/a@1.0.0', 'optional', [{ license: { id: 'MIT' } }]],
    ['pkg:nuget/Serilog@3.1.1', 'required', [{ expression: 'Apache-2.0 OR MIT' }]],
  ]);
  assert.deepEqual(bom.vulnerabilities[0].affects, [{ ref: 'pkg:nuget/Serilog@3.1.1' }]);
  assert.deepEqual(bom.vulnerabilities[0].ratings, [{ severity: 'high', score: 7.5, method: 'CVSSv31' }]);
});

test('bilge audit: the findings, and an exit code by --fail-on; --json; what is ignored left out', async () => {
  const out = [];
  const write = (s) => out.push(s);
  assert.equal(await runHeadless(['audit', '.'], { provider: demoBilge(), write }), 1);
  assert.match(out.join(''), /CRIT minimist@1\.2\.5 \(transitive\)  fixed in 1\.2\.6/);
  assert.match(out.join(''), /2 critical · 4 high · 1 medium · failing on high and above/);
  assert.equal(await runHeadless(['audit', '.', '--fail-on', 'none'], { provider: demoBilge(), write }), 0);
  out.length = 0;
  assert.equal(await runHeadless(['audit', '--json', '--fail-on', 'critical'], { provider: demoBilge(), write, config: { ignore: ['GHSA-xvch-5gv4-984h', 'CVE-2021-26701'] } }), 0);
  const json = JSON.parse(out.join(''));
  assert.deepEqual(json.counts, { critical: 0, high: 4, medium: 1, low: 0, unknown: 0 });
  assert.equal(json.findings[0].package, 'express');
  assert.equal(await runHeadless(['audit', '--fail-on', 'bad'], { provider: demoBilge(), write }), 2);
  assert.deepEqual(parseArgs(['sbom', 'web', '-o', 'bom.json']), { command: 'sbom', dir: 'web', failOn: 'high', json: false, out: 'bom.json' });
  const provider = demoBilge();
  assert.equal(await runHeadless(['sbom', '.', '-o', 'bom.json'], { provider, write }), 0);
  assert.equal(JSON.parse(provider.state.written.text).components.length, 14);
});

test('the Markdown report: counts, a row per advisory, the manifests', () => {
  const md = markdownReport({
    name: 'shop',
    manifests: [{ path: 'package-lock.json', ecosystem: 'npm', packages: [1, 2] }],
    packages: [1, 2],
    found: [{ severity: 'high', pkg: { name: 'lodash', version: '4.17.20', direct: false, where: [{ path: 'package-lock.json' }] }, advisories: [{ id: 'GHSA-1', aliases: ['CVE-2021-1'], url: 'https://osv.dev/vulnerability/GHSA-1', severity: 'high', summary: 'a | b', fixed: '4.17.21' }] }],
    when: new Date('2026-10-30T00:00:00Z'),
  });
  assert.match(md, /^# Dependencies of shop/);
  assert.match(md, /\*\*1 high\*\*/);
  assert.match(md, /\| HIGH \| `lodash@4\.17\.20` \(transitive\) \| \[GHSA-1\]\(https:\/\/osv\.dev\/vulnerability\/GHSA-1\) \(CVE-2021-1\) a \\\| b \| 4\.17\.21 \| package-lock\.json \|/);
  assert.match(md, /- `package-lock\.json` \(npm, 2 packages\)/);
});
