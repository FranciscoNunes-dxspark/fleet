// How bad an advisory is, what fixes it, the findings, licences and versions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advisory, counts, countLine, cvss3Score, denied, findings, fixedIn, licenceKind, severityOf } from '../src/audit.js';
import { bumpOf, compareVersions, newest } from '../src/versions.js';
import { withoutIgnored, packageRows, findPackage, findFinding } from '../src/rows.js';
import { DEMO_VULNS } from '../src/demo.js';

test('CVSS 3 base scores, as the calculator gives them', () => {
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H'), 7.2);
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H'), 10);
  assert.equal(cvss3Score('CVSS:3.0/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N'), 6.1);
  assert.equal(cvss3Score('CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:N'), 0);
  assert.equal(cvss3Score('CVSS:4.0/AV:N/AC:L'), null);
  assert.equal(cvss3Score(undefined), null);
});

test("an advisory's severity: GitHub's word first, else the score's band", () => {
  assert.deepEqual(severityOf({ database_specific: { severity: 'MODERATE' } }), { severity: 'medium' });
  assert.deepEqual(severityOf({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }), { severity: 'critical', score: 9.8 });
  assert.deepEqual(severityOf({ database_specific: { severity: 'LOW' }, severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N' }] }), { severity: 'low', score: 6.1 });
  assert.deepEqual(severityOf({}), { severity: 'unknown' });
});

test('the version that fixes it: the end of the range the version is in, else the next fix', () => {
  const v = {
    affected: [
      { package: { ecosystem: 'npm', name: 'express' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.19.2' }, { introduced: '5.0.0-alpha.1' }, { fixed: '5.0.0-beta.3' }] }] },
      { package: { ecosystem: 'npm', name: 'other' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '9.9.9' }] }] },
    ],
  };
  assert.equal(fixedIn(v, { ecosystem: 'npm', name: 'express', version: '4.17.1' }), '4.19.2');
  assert.equal(fixedIn(v, { ecosystem: 'npm', name: 'express', version: '5.0.0-alpha.8' }), '5.0.0-beta.3');
  assert.equal(fixedIn({ affected: [{ package: { ecosystem: 'NuGet', name: 'Newtonsoft.Json' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '13.0.1' }] }] }] }, { ecosystem: 'NuGet', name: 'newtonsoft.json', version: '12.0.1' }), '13.0.1');
  assert.equal(fixedIn({ affected: [{ package: { ecosystem: 'npm', name: 'x' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { last_affected: '2.0.0' }] }] }] }, { ecosystem: 'npm', name: 'x', version: '1.0.0' }), null);
});

const pkg = (name, version, ecosystem = 'npm', extra = {}) => ({ ecosystem, name, version, key: `${ecosystem}:${ecosystem === 'NuGet' ? name.toLowerCase() : name}@${version}`, direct: true, dev: false, where: [{ path: 'package-lock.json' }], ...extra });

test('the findings: one per vulnerable package, worst first, fixed by the highest of its fixes', () => {
  const packages = [pkg('lodash', '4.17.20'), pkg('express', '4.17.1', 'npm', { direct: false }), pkg('react', '18.2.0'), pkg('minimist', '1.2.5', 'npm', { direct: false })];
  const details = new Map(DEMO_VULNS.map((v) => [v.id, v]));
  const ids = new Map([
    ['npm:lodash@4.17.20', ['GHSA-29mw-wpgm-hmr9', 'GHSA-35jh-r3h4-6jhm']],
    ['npm:express@4.17.1', ['GHSA-rv95-896h-c2vc', 'GHSA-qwcr-r2fm-qrc7']],
    ['npm:minimist@1.2.5', ['GHSA-xvch-5gv4-984h']],
  ]);
  const found = findings(packages, ids, details);
  assert.deepEqual(found.map((f) => [f.pkg.name, f.severity, f.fixed]), [['minimist', 'critical', '1.2.6'], ['lodash', 'high', '4.17.21'], ['express', 'high', '4.20.0']]);
  assert.deepEqual(found[1].advisories.map((a) => a.id), ['GHSA-35jh-r3h4-6jhm', 'GHSA-29mw-wpgm-hmr9']);
  assert.equal(found[0].advisories[0].aliases[0], 'CVE-2021-44906');
  assert.equal(found[0].advisories[0].url, 'https://osv.dev/vulnerability/GHSA-xvch-5gv4-984h');
  assert.equal(countLine(counts(found)), '1 critical · 2 high');
  // Ignoring an advisory takes it out; a finding left with none goes.
  const less = withoutIgnored(found, ['CVE-2021-44906', 'GHSA-qwcr-r2fm-qrc7']);
  assert.deepEqual(less.map((f) => [f.pkg.name, f.severity, f.fixed]), [['lodash', 'high', '4.17.21'], ['express', 'medium', '4.19.2']]);
  assert.equal(findFinding(found, 'cve-2021-23337').pkg.name, 'lodash');
  assert.equal(findFinding(found, 'express').pkg.name, 'express');
  assert.equal(findPackage(packages, 'react@18.2.0').name, 'react');
  assert.equal(findPackage(packages, 'react@17'), null);
  assert.match(advisory({ id: 'X-1', details: '\n  First line.\nMore' }, packages[0]).summary, /^First line\.$/);
});

test('licences: copyleft, weak, permissive and unknown, an OR taking the friendliest; a deny list by prefix', () => {
  assert.equal(licenceKind('MIT'), 'permissive');
  assert.equal(licenceKind('Apache-2.0'), 'permissive');
  assert.equal(licenceKind('GPL-3.0-only'), 'copyleft');
  assert.equal(licenceKind('AGPL-3.0'), 'copyleft');
  assert.equal(licenceKind('LGPL-2.1-or-later'), 'weak');
  assert.equal(licenceKind('MPL-2.0'), 'weak');
  assert.equal(licenceKind('(MIT OR GPL-3.0)'), 'permissive');
  assert.equal(licenceKind('SEE LICENSE IN LICENSE.md'), 'unknown');
  assert.equal(licenceKind(null), 'unknown');
  assert.equal(denied('GPL-3.0-only', ['GPL-']), true);
  assert.equal(denied('LGPL-2.1', ['GPL-']), false);
  assert.equal(denied('MIT OR GPL-3.0', ['GPL-']), false);
  assert.equal(denied('GPL-2.0 OR AGPL-3.0', ['GPL-', 'AGPL-']), true);
  assert.equal(denied('MIT', []), false);
});

test('versions: compared as npm and NuGet write them, the newest stable one, how far behind', () => {
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('2.0.0-beta.2', '2.0.0-beta.10'), -1);
  assert.equal(compareVersions('2.0.0-rc.1', '2.0.0'), -1);
  assert.equal(compareVersions('4.0.0.1', '4.0.0'), 1);
  assert.equal(newest(['1.0.0', '2.0.0-preview', '1.5.0']), '1.5.0');
  assert.equal(newest(['2.0.0-preview']), '2.0.0-preview');
  assert.deepEqual([bumpOf('1.2.3', '2.0.0'), bumpOf('1.2.3', '1.3.0'), bumpOf('1.2.3', '1.2.4'), bumpOf('1.2.3', '1.2.3'), bumpOf('1.2.3', null)], ['major', 'minor', 'patch', null, null]);
});

test("the Packages view's lists: direct, outdated, flagged, one manifest's", () => {
  const packages = [pkg('lodash', '4.17.20'), pkg('ms', '2.0.0', 'npm', { direct: false, license: 'GPL-3.0' }), pkg('react', '18.2.0', 'npm', { where: [{ path: 'web/package-lock.json' }] })];
  const latest = new Map([['npm:react@18.2.0', { latest: '19.0.0' }], ['npm:lodash@4.17.20', { latest: '4.17.20' }]]);
  const names = (list) => list.map((p) => p.name);
  assert.deepEqual(names(packageRows(packages, { filter: 'direct' })), ['lodash', 'react']);
  assert.deepEqual(names(packageRows(packages, { filter: 'outdated', latest })), ['react']);
  assert.deepEqual(names(packageRows(packages, { filter: 'flagged', found: [{ key: 'npm:lodash@4.17.20' }] })), ['lodash', 'ms']);
  assert.deepEqual(names(packageRows(packages, { manifest: 'web/package-lock.json' })), ['react']);
});
