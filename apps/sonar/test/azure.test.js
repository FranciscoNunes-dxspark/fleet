// The Azure client against a fake fetch, the az sign-in, and the pure rules: queries, linking an app to
// its Application Insights, production, settings, sparklines, completion, the tree, the demo's answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAzure, kindOf, label, siteFrom } from '../src/azure/arm.js';
import { token } from '../src/azure/az.js';
import { demoAzure, demoQuery } from '../src/demo.js';
import { TIMESPANS, cellText, completeQuery, componentFor, isProduction, looksSecret, problemsQuery, records, settingsDiff, sparklines, starterQuery, trendQuery } from '../src/insights.js';
import { loadSubscription } from '../src/load.js';
import { mapLimited, resourceRows, targetsByLabel } from '../src/tree.js';

/** A fetch that answers from `routes` (method + path → body, or [status, body]) and records the calls. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.host === 'management.azure.com' ? '' : u.host}${u.pathname}`;
    calls.push({ key, url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const hit = routes[key];
    const [status, body] = Array.isArray(hit) ? hit : [hit === undefined ? 404 : 200, hit ?? { error: { code: 'NotFound', message: `No route ${key}` } }];
    return { ok: status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

const site = (name, rg, kind = 'app', extra = {}) => ({
  id: `/subscriptions/s1/resourceGroups/${rg}/providers/Microsoft.Web/sites/${name}`,
  name,
  kind,
  location: 'westeurope',
  properties: { state: 'Running', defaultHostName: `${name}.azurewebsites.net`, resourceGroup: rg, serverFarmId: '/x/serverfarms/plan-1', ...extra },
});

test('the ARM client: lists across pages, slots, settings, changes with the right calls, queries, errors in words', async () => {
  const web = site('web', 'rg-prod');
  const { fetch, calls } = fakeFetch({
    'GET /subscriptions': { value: [{ subscriptionId: 's1', displayName: 'One', state: 'Enabled' }, { subscriptionId: 's2', displayName: 'Off', state: 'Disabled' }] },
    'GET /subscriptions/s1/providers/Microsoft.Web/sites': { value: [web], nextLink: 'https://management.azure.com/subscriptions/s1/page2?api-version=1' },
    'GET /subscriptions/s1/page2': { value: [site('jobs', 'rg-dev', 'functionapp,linux')] },
    [`GET ${web.id}/slots`]: { value: [{ ...site('web/staging', 'rg-prod'), id: `${web.id}/slots/staging` }] },
    [`POST ${web.id}/config/appsettings/list`]: { properties: { A: '1' } },
    [`PUT ${web.id}/config/appsettings`]: {},
    [`POST ${web.id}/restart`]: {},
    [`POST ${web.id}/slots/staging/slotsswap`]: {},
    'GET /subscriptions/s1/providers/Microsoft.Insights/components': { value: [{ id: '/subscriptions/s1/resourceGroups/rg/providers/microsoft.insights/components/ai', name: 'ai', properties: { AppId: 'app-1', InstrumentationKey: 'K1' } }] },
    'POST api.applicationinsights.io/v1/apps/app-1/query': { tables: [{ name: 'PrimaryResult', columns: [{ name: 'n', type: 'long' }], rows: [[3]] }] },
    'POST api.applicationinsights.io/v1/apps/app-2/query': [400, { error: { message: 'The request had some invalid properties', innererror: { message: "Failed to resolve table 'requestz'" } } }],
  });
  const tokens = [];
  const azure = createAzure({ fetch, token: async (r) => (tokens.push(r), `t-${r}`) });

  assert.deepEqual(await azure.subscriptions(), [{ id: 's1', name: 'One' }]);
  const apps = await azure.apps('s1');
  assert.deepEqual(apps.map((a) => [a.name, a.kind, a.resourceGroup]), [['jobs', 'function', 'rg-dev'], ['web', 'app', 'rg-prod']]);
  const [staging] = await azure.slots(apps[1]);
  assert.deepEqual([staging.name, staging.slot, label(staging)], ['web', 'staging', 'web/staging']);
  assert.deepEqual(await azure.settings(apps[1]), { A: '1' });
  await azure.saveSettings(apps[1], { A: '2' });
  assert.deepEqual(calls.at(-1).body, { properties: { A: '2' } });
  await azure.restart(apps[1]);
  await azure.swap(staging);
  assert.deepEqual(calls.at(-1).body, { targetSlot: 'production', preserveVnet: true });
  const [ai] = await azure.components('s1');
  assert.deepEqual([ai.name, ai.appId, ai.key], ['ai', 'app-1', 'K1']);
  assert.deepEqual(await azure.query(ai, 'requests | count', { timespan: 'PT1H' }), { columns: [{ name: 'n', type: 'long' }], rows: [[3]] });
  assert.deepEqual(calls.at(-1).body, { query: 'requests | count', timespan: 'PT1H' });
  assert.match(calls.at(-1).init.headers.Authorization, /^Bearer t-https:\/\/api\.applicationinsights\.io$/);
  assert.ok(tokens.includes('https://management.azure.com/'));
  await assert.rejects(azure.query({ ...ai, name: 'ai2', appId: 'app-2' }, 'requestz'), /Querying ai2: The request had some invalid properties: Failed to resolve table 'requestz'/);
  await assert.rejects(azure.stop(apps[1]), /Stopping web: not found/);
  assert.equal(azure.portalUrl(apps[1]), `https://portal.azure.com/#resource${apps[1].id}`);
});

test('az: a token kept until near its end, and sign-in trouble said plainly', async () => {
  let runs = 0;
  const runner = async () => (runs++, { stdout: JSON.stringify({ token: `tok${runs}`, expires: String(Math.floor(Date.now() / 1000) + 3600) }) });
  assert.equal(await token('https://r1/', { runner }), 'tok1');
  assert.equal(await token('https://r1/', { runner }), 'tok1');
  assert.equal(await token('https://r1/', { runner, now: Date.now() + 58 * 60 * 1000 }), 'tok2', 'five minutes before it ends, a new one');
  const refused = async () => {
    throw Object.assign(new Error('failed'), { stderr: "AADSTS700082: The refresh token has expired. Please run 'az login'" });
  };
  await assert.rejects(token('https://r2/', { runner: refused }), /not signed in, or its sign-in ran out: run az login/);
});

test('linking an app to its Application Insights, production, secrets, settings compared', () => {
  const components = [{ name: 'ai', key: 'ABC-1' }, { name: 'other', key: 'x' }];
  assert.equal(componentFor({ APPLICATIONINSIGHTS_CONNECTION_STRING: 'InstrumentationKey=abc-1;IngestionEndpoint=https://x/' }, components).name, 'ai');
  assert.equal(componentFor({ APPINSIGHTS_INSTRUMENTATIONKEY: 'x' }, components).name, 'other');
  assert.equal(componentFor({}, components), null);
  assert.ok(isProduction({ name: 'shop-prd', resourceGroup: 'rg' }));
  assert.ok(isProduction({ name: 'shop', resourceGroup: 'rg-live-weu' }));
  assert.ok(!isProduction({ name: 'shop', resourceGroup: 'rg-dev', slot: 'production' }), "the main slot's name doesn't count");
  assert.ok(looksSecret('Db__ConnectionString', 'x') && looksSecret('Url', 'https://a?sig=1;SharedAccessSignature=x') && !looksSecret('APP_VERSION', '1.0'));
  assert.deepEqual(settingsDiff({ A: '1', B: '2', C: '3' }, { A: '1', B: '9', D: '4' }), [
    { name: 'B', a: '2', b: '9', change: 'differs' },
    { name: 'C', a: '3', change: 'only-a' },
    { name: 'D', b: '4', change: 'only-b' },
  ]);
});

test('queries, sparklines, cells and completion', () => {
  assert.match(problemsQuery("o'brien"), /^exceptions \| where cloud_RoleName == 'o\\'brien' \| summarize/);
  assert.doesNotMatch(problemsQuery(null), /where/);
  assert.match(trendQuery(null, TIMESPANS[0]), /bin\(timestamp, 5m\)/);
  assert.match(trendQuery(null, TIMESPANS[2]), /bin\(timestamp, 1d\)/);
  assert.equal(starterQuery('web'), "requests | where cloud_RoleName == 'web' | order by timestamp desc | take 50");
  const spark = sparklines([
    { problemId: 'a', bucket: '2026-01-01T00', n: 1 },
    { problemId: 'a', bucket: '2026-01-01T01', n: 4 },
    { problemId: 'b', bucket: '2026-01-01T02', n: 2 },
  ]);
  assert.deepEqual(spark, { a: '▃█ ', b: '  █' });
  assert.equal(cellText('2026-10-22T08:15:00.1234567Z', 'datetime'), '2026-10-22 08:15:00');
  assert.equal(cellText({ a: 1 }), '{"a":1}');
  assert.equal(cellText('two\n  lines'), 'two ⏎ lines');
  assert.deepEqual(completeQuery('req', 3).items, ['requests']);
  assert.ok(completeQuery('requests | where res', 20).items.includes('resultCode'));
  assert.ok(completeQuery('requests | summ', 15).items.includes('summarize'));
  assert.deepEqual(completeQuery('requests ', 9).items, []);
});

test('the tree: groups as headings, slots under their app, a filter; targets by label; limited concurrency', async () => {
  const apps = [siteFrom(site('api', 'rg-a')), siteFrom(site('web', 'rg-a')), siteFrom(site('jobs', 'rg-b', 'functionapp'))];
  const slots = { [apps[1].id]: [siteFrom({ ...site('web/staging', 'rg-a'), id: `${apps[1].id}/slots/staging` }, apps[1])] };
  const rows = resourceRows(apps, slots);
  assert.deepEqual(rows.map((r) => r.text ?? `${r.kind}:${label(r.target)}`), ['rg-a', 'app:api', 'app:web', 'slot:web/staging', 'rg-b', 'app:jobs']);
  assert.deepEqual(resourceRows(apps, slots, 'WE').map((r) => r.text ?? label(r.target)), ['rg-a', 'web', 'web/staging']);
  assert.deepEqual(Object.keys(targetsByLabel(apps, slots)), ['api', 'web', 'web/staging', 'jobs']);
  assert.equal(kindOf('functionapp,linux'), 'function');
  let running = 0;
  let most = 0;
  const out = await mapLimited([1, 2, 3, 4, 5], 2, async (n) => {
    most = Math.max(most, ++running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.equal(most, 2);
});

test('the demo: a subscription to read, the queries Sonar sends answered, changes kept, other queries refused', async () => {
  const azure = demoAzure({ now: Date.parse('2026-10-22T12:00:00Z') });
  const d = await loadSubscription(azure);
  assert.equal(d.subscription.name, 'Contoso Production');
  assert.deepEqual(d.apps.map((a) => a.name), ['contoso-web', 'contoso-api', 'contoso-orders']);
  assert.deepEqual(d.slots[d.apps[0].id].map(label), ['contoso-web/staging']);
  const ai = componentFor(await azure.settings(d.apps[0]), d.components);
  assert.equal(ai.name, 'contoso-prod-ai');
  const problems = records(await azure.query(ai, problemsQuery('contoso-web'), { timespan: 'P7D' }));
  assert.ok(problems.length >= 2 && problems[0].count >= problems[1].count);
  assert.ok(problems.every((p) => p.role === 'contoso-web'));
  const timeline = records(await azure.query(ai, `union requests | where operation_Id == '${problems[0].operation}'`, { timespan: 'P7D' }));
  assert.deepEqual([...new Set(timeline.map((r) => r.itemType))].sort(), ['dependency', 'exception', 'request', 'trace']);
  assert.equal((await azure.query(ai, 'requests | take 3')).rows.length, 3);
  assert.throws(() => demoQuery('pageViews | take 1', []), /it answers requests, exceptions, traces and dependencies/);
  const staging = d.slots[d.apps[0].id][0];
  await azure.swap(staging);
  assert.equal((await azure.settings(d.apps[0])).APP_VERSION, '2.15.0-rc.1');
  assert.equal((await azure.settings(d.apps[0])).ASPNETCORE_ENVIRONMENT, 'Production', 'sticky settings stay with their slot');
});
