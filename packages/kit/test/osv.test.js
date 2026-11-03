// OSV's client, how bad an advisory is, and npm's and NuGet's lock files: what Bilge and Keel share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOsv, cvss3Score, severityOf } from '../osv.js';
import { keyOf, parseNpmLock, parseNugetLock } from '../lockfiles.js';

test('OSV: one batch for the packages, then each advisory once; a failure says who answered how', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    if (url.endsWith('/v1/querybatch')) return { ok: true, status: 200, json: async () => ({ results: JSON.parse(opts.body).queries.map((q) => (q.package.name === 'lodash' ? { vulns: [{ id: 'GHSA-1' }] } : {})) }) };
    if (url.endsWith('/v1/vulns/GHSA-1')) return { ok: true, status: 200, json: async () => ({ id: 'GHSA-1', database_specific: { severity: 'HIGH' } }) };
    return { ok: false, status: 503, statusText: '', json: async () => ({}) };
  };
  const osv = createOsv({ fetchImpl });
  const pkgs = [{ ecosystem: 'npm', name: 'lodash', version: '4.17.20' }, { ecosystem: 'npm', name: 'ms', version: '2.1.3' }].map((p) => ({ ...p, key: keyOf(p) }));
  const ids = await osv.query(pkgs);
  assert.deepEqual([...ids], [['npm:lodash@4.17.20', ['GHSA-1']]]);
  const records = await osv.vulns(['GHSA-1', 'GHSA-1']);
  assert.equal(severityOf(records.get('GHSA-1')).severity, 'high');
  assert.equal(calls.filter((u) => u.endsWith('GHSA-1')).length, 1);
  await assert.rejects(createOsv({ fetchImpl: async () => ({ ok: false, status: 503, statusText: '', json: async () => ({}) }) }).query(pkgs), /OSV answered 503/);
});

test("an advisory's severity: GitHub's word first, else the CVSS 3 score's band", () => {
  assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
  assert.deepEqual(severityOf({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }), { severity: 'critical', score: 9.8 });
  assert.equal(severityOf({ database_specific: { severity: 'MODERATE' } }).severity, 'medium');
  assert.equal(severityOf({}).severity, 'unknown');
});

test("npm's and NuGet's lock files, from their text: each package once, the direct ones marked", () => {
  const npm = parseNpmLock(JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { express: '^4' } }, 'node_modules/express': { version: '4.17.1' }, 'node_modules/ms': { version: '2.0.0', dev: true } } }));
  assert.deepEqual(npm.map((p) => [p.name, p.version, p.direct, p.dev]), [['express', '4.17.1', true, false], ['ms', '2.0.0', false, true]]);
  const nuget = parseNugetLock(JSON.stringify({ version: 1, dependencies: { 'net8.0': { Serilog: { type: 'Direct', resolved: '3.1.1' }, Api: { type: 'Project' } }, 'net48': { Serilog: { type: 'Direct', resolved: '3.1.1' } } } }));
  assert.deepEqual(nuget.map((p) => [p.name, p.version, p.direct]), [['Serilog', '3.1.1', true]]);
  assert.equal(keyOf(nuget[0]), 'NuGet:serilog@3.1.1');
});
