// OSV's and the registries' answers, through a fake fetch: batches, pages, records kept, newest versions and licences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BATCH, createOsv } from '../src/osv.js';
import { createRegistry, npmPath, nuspecLicence, packageUrl } from '../src/registry.js';
import { createBilge } from '../src/provider.js';
import { fakeFetch } from './helpers.js';

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
  const fetchImpl = fakeFetch({ 'POST https://api.osv.dev/v1/querybatch': { results: [{ vulns: [{ id: 'GHSA-1' }] }, {}] }, 'GET https://api.osv.dev/v1/vulns/GHSA-1': { id: 'GHSA-1' } });
  const { ids, details } = await createBilge({ fetchImpl }).audit([pkg('a', '1.0.0'), pkg('b', '1.0.0')]);
  assert.deepEqual([...ids], [['npm:a@1.0.0', ['GHSA-1']]]);
  assert.deepEqual([...details.keys()], ['GHSA-1']);
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
