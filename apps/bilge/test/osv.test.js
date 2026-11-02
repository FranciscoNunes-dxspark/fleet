// OSV's and the registries' answers, through a fake fetch: batches, pages, records kept, newest versions and licences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BATCH, createOsv } from '../src/osv.js';
import { createRegistry, npmPath, nuspecLicence, packageUrl } from '../src/registry.js';
import { createBilge } from '../src/provider.js';
import { CACHE_FILE, QUERY_TTL, createOsvCache } from '../src/cache.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeFetch, tempHome } from './helpers.js';

const pkg = (name, version, ecosystem = 'npm') => ({ ecosystem, name, version, key: `${ecosystem}:${name}@${version}` });

test("OSV's batch query: a thousand packages a call, a package's further pages asked for, ids by package", async () => {
  const many = Array.from({ length: BATCH + 2 }, (_, i) => pkg(`p${i}`, '1.0.0'));
  const fetchImpl = fakeFetch({
    'POST https://api.osv.dev/v1/querybatch': (body) => {
      if (body.queries[0].page_token) return { results: [{ vulns: [{ id: 'GHSA-page-2' }] }] };
      return { results: body.queries.map((q) => (q.package.name === 'p1' ? { vulns: [{ id: 'GHSA-1' }], next_page_token: 'more' } : q.package.name === `p${BATCH + 1}` ? { vulns: [{ id: 'GHSA-2' }] } : {})) };
    },
  });
  const ids = await createOsv({ fetchImpl }).query(many);
  assert.deepEqual([...ids], [['npm:p1@1.0.0', ['GHSA-1', 'GHSA-page-2']], [`npm:p${BATCH + 1}@1.0.0`, ['GHSA-2']]]);
  const batches = fetchImpl.calls.filter((c) => !c.body.queries[0].page_token);
  assert.deepEqual(batches.map((c) => c.body.queries.length), [BATCH, 2]);
  assert.deepEqual(batches[0].body.queries[0], { package: { name: 'p0', ecosystem: 'npm' }, version: '1.0.0' });
});

test("OSV's records: each asked for once in the session; a failure says who answered how", async () => {
  const fetchImpl = fakeFetch({ 'GET https://api.osv.dev/v1/vulns/GHSA-1': { id: 'GHSA-1', summary: 'one' }, 'GET https://api.osv.dev/v1/vulns/GHSA-2': { id: 'GHSA-2' } });
  const osv = createOsv({ fetchImpl });
  assert.deepEqual([...(await osv.vulns(['GHSA-1', 'GHSA-2', 'GHSA-1'])).keys()], ['GHSA-1', 'GHSA-2']);
  await osv.vulns(['GHSA-1']);
  assert.equal(fetchImpl.calls.length, 2);
  const down = createOsv({ fetchImpl: fakeFetch({ 'POST https://api.osv.dev/v1/querybatch': { status: 503 } }) });
  await assert.rejects(down.query([pkg('a', '1.0.0')]), /OSV answered 503/);
  const offline = createOsv({ fetchImpl: fakeFetch({ 'POST https://api.osv.dev/v1/querybatch': Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }) }) });
  await assert.rejects(offline.query([pkg('a', '1.0.0')]), /Couldn't reach api\.osv\.dev: ENOTFOUND/);
});

test("the provider's audit: OSV's ids, then their records", async () => {
  const cleanup = tempHome();
  try {
    const fetchImpl = fakeFetch({ 'POST https://api.osv.dev/v1/querybatch': { results: [{ vulns: [{ id: 'GHSA-1' }] }, {}] }, 'GET https://api.osv.dev/v1/vulns/GHSA-1': { id: 'GHSA-1' } });
    const { ids, details, cached } = await createBilge({ fetchImpl }).audit([pkg('a', '1.0.0'), pkg('b', '1.0.0')]);
    assert.deepEqual([...ids], [['npm:a@1.0.0', ['GHSA-1']]]);
    assert.deepEqual([...details.keys()], ['GHSA-1']);
    assert.equal(cached, 0);
  } finally {
    cleanup();
  }
});

test("OSV's answers kept between runs in Bilge's home: a package's for 6 hours, a record's for a day, fresh asks again", async () => {
  const cleanup = tempHome();
  try {
    let clock = Date.parse('2026-11-02T09:00:00Z');
    const now = () => clock;
    const asked = (fetchImpl) => fetchImpl.calls.map((c) => (c.method === 'POST' ? c.body.queries.map((q) => q.package.name).join(',') : c.url.split('/').pop()));
    const routes = {
      'POST https://api.osv.dev/v1/querybatch': (body) => ({ results: body.queries.map((q) => (q.package.name === 'a' ? { vulns: [{ id: 'GHSA-1' }] } : {})) }),
      'GET https://api.osv.dev/v1/vulns/GHSA-1': { id: 'GHSA-1', summary: 'one' },
    };
    const list = [pkg('a', '1.0.0'), pkg('b', '1.0.0')];
    // Each run is a new Bilge: nothing kept in the session, only in the file.
    const run = async (opts = {}, packages = list) => {
      const fetchImpl = fakeFetch(routes);
      const result = await createBilge({ fetchImpl, now }).audit(packages, opts);
      return { result, asked: asked(fetchImpl) };
    };
    assert.deepEqual((await run()).asked, ['a,b', 'GHSA-1']);
    assert.ok(existsSync(join(process.env.BILGE_HOME, 'cache', CACHE_FILE)));
    clock += 60 * 60_000;
    const again = await run();
    assert.deepEqual(again.asked, [], 'an hour later, all of it from the cache');
    assert.deepEqual([...again.result.ids], [['npm:a@1.0.0', ['GHSA-1']]]);
    assert.equal(again.result.details.get('GHSA-1').summary, 'one');
    assert.equal(again.result.cached, 2);
    // A package not asked about before is asked about alone.
    assert.deepEqual((await run({}, [...list, pkg('c', '2.0.0')])).asked, ['c']);
    assert.deepEqual((await run({ fresh: true })).asked, ['a,b', 'GHSA-1'], 'fresh asks about everything');
    clock += 7 * 60 * 60_000;
    assert.deepEqual((await run()).asked, ['a,b'], "after 6 hours the packages again, the record still a day's");
    clock += 24 * 60 * 60_000;
    assert.deepEqual((await run()).asked, ['a,b', 'GHSA-1']);
  } finally {
    cleanup();
  }
});

test('a cache that cannot be read is empty, and stale entries are dropped when it is written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bilge-cache-'));
  try {
    writeFileSync(join(dir, CACHE_FILE), '{not json');
    let clock = 0;
    const cache = createOsvCache({ dir, now: () => clock });
    assert.equal(cache.query('npm:a@1.0.0'), undefined);
    cache.setQuery('npm:a@1.0.0', []);
    cache.setVuln('GHSA-1', { id: 'GHSA-1' });
    assert.deepEqual(cache.query('npm:a@1.0.0'), [], 'no advisories is an answer too');
    clock = QUERY_TTL + 1;
    cache.setQuery('npm:b@1.0.0', ['GHSA-1']);
    cache.save();
    const kept = JSON.parse(readFileSync(join(dir, CACHE_FILE), 'utf8'));
    assert.deepEqual(Object.keys(kept.queries), ['npm:b@1.0.0']);
    assert.deepEqual(Object.keys(kept.vulns), ['GHSA-1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the registries: npm's latest and licence, NuGet's newest stable version and its .nuspec's licence", async () => {
  const fetchImpl = fakeFetch({
    'GET https://registry.npmjs.org/@types%2fnode/latest': { version: '22.1.0', license: 'MIT' },
    'GET https://registry.npmjs.org/request/latest': { version: '2.88.2', license: 'Apache-2.0', deprecated: 'request has been deprecated' },
    'GET https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json': { versions: ['12.0.1', '13.0.3', '14.0.1-beta1'] },
    'GET https://api.nuget.org/v3-flatcontainer/newtonsoft.json/12.0.1/newtonsoft.json.nuspec': '<package><metadata><license type="expression">MIT</license></metadata></package>',
  });
  const progress = [];
  const out = await createRegistry({ fetchImpl }).latest([pkg('@types/node', '20.0.0'), pkg('request', '2.88.0'), pkg('Newtonsoft.Json', '12.0.1', 'NuGet'), pkg('gone', '1.0.0')], { onProgress: (n, of) => progress.push(`${n}/${of}`) });
  assert.deepEqual(out.get('npm:@types/node@20.0.0'), { latest: '22.1.0', license: 'MIT' });
  assert.deepEqual(out.get('npm:request@2.88.0'), { latest: '2.88.2', deprecated: 'request has been deprecated', license: 'Apache-2.0' });
  assert.deepEqual(out.get('NuGet:Newtonsoft.Json@12.0.1'), { latest: '13.0.3', license: 'MIT' });
  assert.deepEqual(out.get('npm:gone@1.0.0'), { latest: null });
  assert.equal(progress.at(-1), '4/4');
  assert.equal(npmPath('@scope/x'), '@scope%2fx');
  assert.equal(packageUrl(pkg('Serilog', '3.1.1', 'NuGet')), 'https://www.nuget.org/packages/Serilog/3.1.1');
});

test("a .nuspec's licence: the expression, a file of its own, or what a known licence page says", () => {
  assert.equal(nuspecLicence('<license type="expression">Apache-2.0</license>'), 'Apache-2.0');
  assert.equal(nuspecLicence('<license type="file">LICENSE.txt</license>'), 'SEE LICENSE IN LICENSE.txt');
  assert.equal(nuspecLicence('<licenseUrl>https://opensource.org/licenses/MIT</licenseUrl>'), 'MIT');
  assert.equal(nuspecLicence('<licenseUrl>https://aka.ms/deprecateLicenseUrl</licenseUrl>'), null);
  assert.equal(nuspecLicence(null), null);
});

test("what a version needs: npm's engines and required peers, a NuGet .nuspec's frameworks; the newest that fits", async () => {
  const nuspec = (...frameworks) => `<package><metadata><dependencies>${frameworks.map((f) => `<group targetFramework="${f}" />`).join('')}</dependencies></metadata></package>`;
  const flat = 'https://api.nuget.org/v3-flatcontainer/microsoft.data.sqlclient';
  const fetchImpl = fakeFetch({
    'GET https://registry.npmjs.org/express/latest': { version: '5.1.0', license: 'MIT', engines: { node: '>= 18' } },
    'GET https://registry.npmjs.org/express/4.20.0': { version: '4.20.0', engines: { node: '>= 0.10.0' } },
    'GET https://registry.npmjs.org/react-redux/latest': { version: '9.1.0', peerDependencies: { react: '^18.0', redux: '^5' }, peerDependenciesMeta: { redux: { optional: true } } },
    'GET https://registry.npmjs.org/express': { versions: { '4.17.1': { version: '4.17.1' }, '4.21.2': { version: '4.21.2', engines: { node: '>= 0.10.0' } }, '5.0.0-beta.1': { version: '5.0.0-beta.1' }, '5.1.0': { version: '5.1.0', engines: { node: '>= 18' } } } },
    [`GET ${flat}/index.json`]: { versions: ['5.1.1', '5.1.6', '5.2.3', '6.0.2', '6.1.1', '7.0.0-preview1'] },
    [`GET ${flat}/5.1.1/microsoft.data.sqlclient.nuspec`]: '<package><metadata><license type="expression">MIT</license></metadata></package>',
    [`GET ${flat}/6.1.1/microsoft.data.sqlclient.nuspec`]: nuspec('.NETFramework4.6.2', 'net8.0', 'net9.0'),
    [`GET ${flat}/5.2.3/microsoft.data.sqlclient.nuspec`]: nuspec('net462', 'net6.0', 'netstandard2.0'),
  });
  const registry = createRegistry({ fetchImpl });
  const express = pkg('express', '4.17.1');
  const sql = pkg('Microsoft.Data.SqlClient', '5.1.1', 'NuGet');
  const out = await registry.latest([express, pkg('react-redux', '8.1.3'), sql]);
  assert.deepEqual(out.get(express.key).needs, { node: '>= 18' });
  assert.deepEqual(out.get('npm:react-redux@8.1.3').needs, { peers: { react: '^18.0' } });
  assert.deepEqual(out.get(sql.key), { latest: '6.1.1', license: 'MIT', needs: { frameworks: ['net462', 'net8.0', 'net9.0'] } });
  assert.deepEqual(await registry.needs(express, '4.20.0'), { node: '>= 0.10.0' });
  assert.deepEqual(await registry.needs(sql, '5.2.3'), { frameworks: ['net462', 'net6.0', 'netstandard2.0'] });
  assert.equal(await registry.needs(express, '9.9.9'), null);
  // npm's every version in one document: the newest stable one that fits, none older than what's installed.
  const tried = [];
  const npmFit = await registry.fitting(express, (v, needs) => tried.push(v) && needs.node !== '>= 18');
  assert.deepEqual(npmFit, { version: '4.21.2', needs: { node: '>= 0.10.0' } });
  assert.deepEqual(tried, ['5.1.0', '4.21.2']);
  // NuGet's: the newest of each major version, down.
  const nugetFit = await registry.fitting(sql, (v, needs) => needs.frameworks?.includes('net6.0'));
  assert.deepEqual(nugetFit, { version: '5.2.3', needs: { frameworks: ['net462', 'net6.0', 'netstandard2.0'] } });
  assert.equal(await registry.fitting(sql, () => false), null);
});
