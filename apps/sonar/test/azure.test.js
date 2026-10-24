// The Azure client against a fake fetch, the az sign-in, and the pure rules: queries, linking an app to
// its Application Insights, production, settings, sparklines, completion, the tree, the demo's answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { alertFrom, alertRange, createAzure, retryAfter, deploymentFrom, sqlServerFrom, kindOf, label, readLines, siteFrom, xmlError } from '../src/azure/arm.js';
import { token } from '../src/azure/az.js';
import { demoAzure, demoQuery } from '../src/demo.js';
import { TIMESPANS, availabilityQuery, cellText, completeQuery, hailRequest, componentFor, isProduction, looksSecret, problemsQuery, records, settingsDiff, sparklines, starterQuery, trendQuery } from '../src/insights.js';
import { loadSubscription } from '../src/load.js';
import { METRICS, metricInterval, metricRows, metricsFor, seriesFrom } from '../src/metrics.js';
import { mapLimited, resourceRows, sqlByLabel, targetForUrl, targetsByLabel } from '../src/tree.js';

/** A fetch that answers from `routes` (method + path → body, or [status, body]) and records the calls. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.host === 'management.azure.com' ? '' : u.host}${u.pathname}`;
    let sent;
    try {
      sent = init.body ? JSON.parse(init.body) : undefined;
    } catch {
      sent = init.body;
    }
    calls.push({ key, url, init, body: sent });
    // A route can be a function of the request's body (pages asked for by token, say).
    const hit = typeof routes[key] === 'function' ? routes[key](calls.at(-1).body, calls.at(-1)) : routes[key];
    const [status, body] = Array.isArray(hit) ? hit : [hit === undefined ? 404 : 200, hit ?? { error: { code: 'NotFound', message: `No route ${key}` } }];
    // { raw, headers } answers text with headers of its own (Storage's XML, a Service Bus message).
    return { ok: status < 300, status, headers: new Headers(body?.headers ?? {}), text: async () => (typeof body?.raw === 'string' ? body.raw : body == null ? '' : JSON.stringify(body)) };
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

test('slots: Resource Graph says which apps have any, across its pages, and only theirs are listed; without it, every app\'s', async () => {
  const [web, api, jobs] = [site('web', 'rg-prod'), site('api', 'RG-PROD'), site('jobs', 'rg-dev')];
  const routes = {
    'GET /subscriptions': { value: [{ subscriptionId: 's1', displayName: 'One', state: 'Enabled' }] },
    'GET /subscriptions/s1/providers/Microsoft.Web/sites': { value: [web, api, jobs] },
    'GET /subscriptions/s1/providers/Microsoft.Insights/components': { value: [] },
    // Two pages; Resource Graph may write an id's case differently from ARM.
    'POST /providers/Microsoft.ResourceGraph/resources': (body) =>
      body.options.$skipToken === 'p2' ? { data: [{ id: `${api.id.toLowerCase()}/slots/blue` }] } : { data: [{ id: `${web.id}/slots/staging` }, { id: `${web.id}/slots/qa` }], $skipToken: 'p2' },
    [`GET ${web.id}/slots`]: { value: [{ ...site('web/staging', 'rg-prod'), id: `${web.id}/slots/staging` }] },
    [`GET ${api.id}/slots`]: { value: [{ ...site('api/blue', 'RG-PROD'), id: `${api.id}/slots/blue` }] },
    [`GET ${jobs.id}/slots`]: { value: [] },
  };
  const { fetch, calls } = fakeFetch(routes);
  const azure = createAzure({ fetch, token: async () => 't' });
  const ids = await azure.appsWithSlots('s1');
  assert.deepEqual([...ids], [web.id.toLowerCase(), api.id.toLowerCase()]);
  const graph = calls.filter((c) => c.key.includes('ResourceGraph'));
  assert.deepEqual(graph[0].body.subscriptions, ['s1']);
  assert.match(graph[0].body.query, /microsoft\.web\/sites\/slots/);
  assert.equal(graph[1].body.options.$skipToken, 'p2');

  calls.length = 0;
  const d = await loadSubscription(azure, 's1');
  assert.deepEqual(Object.values(d.slots).flat().map(label).sort(), ['api/blue', 'web/staging']);
  assert.ok(!calls.some((c) => c.key === `GET ${jobs.id}/slots`), 'not asked for an app without slots');

  // Resource Graph refused: every app's slots, as before.
  const without = fakeFetch({ ...routes, 'POST /providers/Microsoft.ResourceGraph/resources': [403, { error: { message: 'no' } }] });
  const d2 = await loadSubscription(createAzure({ fetch: without.fetch, token: async () => 't' }), 's1');
  assert.deepEqual(Object.values(d2.slots).flat().map(label).sort(), ['api/blue', 'web/staging']);
  assert.ok(without.calls.some((c) => c.key === `GET ${jobs.id}/slots`));

  // The demo says the same as its slots.
  const demo = demoAzure();
  const dd = await loadSubscription(demo);
  assert.deepEqual([...(await demo.appsWithSlots('sub-prod'))].sort(), dd.apps.filter((a) => dd.slots[a.id].length).map((a) => a.id.toLowerCase()).sort());
});

test('loading: the subscription az has selected is asked for while the list is read, and a name or id given wins', async () => {
  const order = [];
  const provider = {
    subscriptions: async () => (order.push('list'), await new Promise((r) => setTimeout(r, 10)), order.push('listed'), [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]),
    currentSubscription: async () => (order.push('current'), { id: 'b', name: 'B' }),
    apps: async () => [],
    components: async () => [],
  };
  assert.equal((await loadSubscription(provider)).subscription.id, 'b');
  assert.ok(order.indexOf('current') < order.indexOf('listed'), order.join(' '));
  order.length = 0;
  assert.equal((await loadSubscription(provider, 'A')).subscription.id, 'a');
  assert.ok(!order.includes('current'), 'not asked when one is named');
});

test('a throttled call (429) is tried again after Retry-After, up to three times', async () => {
  let n = 0;
  const fetch = async () => {
    n++;
    const throttled = n <= 2;
    return { ok: !throttled, status: throttled ? 429 : 200, headers: { get: (h) => (h === 'retry-after' ? '0' : null) }, text: async () => JSON.stringify(throttled ? { error: { message: 'Too many requests' } } : { value: [{ subscriptionId: 's1', displayName: 'One' }] }) };
  };
  assert.deepEqual(await createAzure({ fetch, token: async () => 't' }).subscriptions(), [{ id: 's1', name: 'One' }]);
  assert.equal(n, 3);
  let m = 0;
  const always = async () => (m++, { ok: false, status: 429, headers: { get: () => '0' }, text: async () => JSON.stringify({ error: { message: 'Too many requests' } }) });
  await assert.rejects(createAzure({ fetch: always, token: async () => 't' }).subscriptions(), /Listing subscriptions: Too many requests/);
  assert.equal(m, 4, 'the first call and three more');
  assert.equal(retryAfter({ headers: { get: () => '7' } }), 7000);
  assert.equal(retryAfter({ headers: { get: () => '600' } }), 30_000);
  assert.equal(retryAfter({}, 2), 4000);
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

test('az: calls that ask for a token at once share one az run, and a failed one is asked again', async () => {
  let runs = 0;
  const slow = async () => {
    runs++;
    await new Promise((r) => setTimeout(r, 20));
    return { stdout: JSON.stringify({ token: `slow${runs}`, expires: String(Math.floor(Date.now() / 1000) + 3600) }) };
  };
  assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map(() => token('https://r3/', { runner: slow }))), ['slow1', 'slow1', 'slow1', 'slow1', 'slow1']);
  assert.equal(runs, 1);
  let tries = 0;
  const flaky = async () => {
    if (++tries === 1) throw new Error('network');
    return { stdout: JSON.stringify({ token: 'ok', expires: String(Math.floor(Date.now() / 1000) + 3600) }) };
  };
  await assert.rejects(Promise.all([token('https://r4/', { runner: flaky }), token('https://r4/', { runner: flaky })]), /network/);
  assert.equal(tries, 1, 'both waited on the one run');
  assert.equal(await token('https://r4/', { runner: flaky }), 'ok');
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
  assert.throws(() => demoQuery('pageViews | take 1', []), /it answers requests, exceptions, traces, dependencies and availabilityResults/);
  const staging = d.slots[d.apps[0].id][0];
  await azure.swap(staging);
  assert.equal((await azure.settings(d.apps[0])).APP_VERSION, '2.15.0-rc.1');
  assert.equal((await azure.settings(d.apps[0])).ASPNETCORE_ENVIRONMENT, 'Production', 'sticky settings stay with their slot');
});

test('an address to its app, by default host or custom domain; a request row for Hail', () => {
  const web = { id: 'w', name: 'web', host: 'web.azurewebsites.net', hostNames: ['web.azurewebsites.net', 'shop.example.com'] };
  const staging = { id: 'w/s', name: 'web', slot: 'staging', host: 'web-staging.azurewebsites.net' };
  assert.equal(targetForUrl([web], { w: [staging] }, 'https://SHOP.example.com/health?x=1'), web);
  assert.equal(targetForUrl([web], { w: [staging] }, 'https://web-staging.azurewebsites.net/'), staging);
  assert.equal(targetForUrl([web], {}, 'https://other.example.com/'), null);
  assert.equal(hailRequest({ name: 'POST /api/orders', url: 'https://x/api/orders', resultCode: '500' }), '### POST /api/orders (answered 500)\nPOST https://x/api/orders\n');
  assert.equal(hailRequest({ message: 'a trace' }), null);
});

test('the log stream: lines across chunks, from the Kudu site with the ARM token', async () => {
  const got = [];
  const enc = new TextEncoder();
  async function* body() {
    yield enc.encode('first li');
    yield enc.encode('ne\r\nsecond\nthi');
    yield enc.encode('rd');
  }
  await readLines(body(), (l) => got.push(l));
  assert.deepEqual(got, ['first line', 'second', 'third']);
  const asked = [];
  const azure = createAzure({
    token: async (r) => `t-${r}`,
    fetch: async (url, init) => (asked.push([url, init.headers.Authorization]), { ok: true, status: 200, body: body() }),
  });
  const web = siteFrom({ ...site('web', 'rg'), properties: { ...site('web', 'rg').properties, enabledHostNames: ['web.azurewebsites.net', 'web.scm.azurewebsites.net'] } });
  const lines = [];
  await azure.logStream(web, { onLine: (l) => lines.push(l) });
  assert.deepEqual(asked, [['https://web.scm.azurewebsites.net/api/logstream', 'Bearer t-https://management.azure.com/']]);
  assert.equal(lines.length, 3);
  assert.equal(siteFrom(site('shop', 'rg')).scmHost, 'shop.scm.azurewebsites.net', 'worked out when ARM lists no Kudu host');
});

test('metrics: the site\'s Azure Monitor metrics over the span, at its grain, as sparklines and a summary', async () => {
  const web = siteFrom(site('web', 'rg'));
  const body = {
    value: [
      { name: { value: 'CpuTime' }, unit: 'Seconds', timeseries: [{ data: [{ timeStamp: '2026-10-22T10:00:00Z', total: 30 }, { timeStamp: '2026-10-22T11:00:00Z', total: 90 }] }] },
      { name: { value: 'MemoryWorkingSet' }, unit: 'Bytes', timeseries: [{ data: [{ timeStamp: '2026-10-22T10:00:00Z', average: 200 * 1024 ** 2 }, { timeStamp: '2026-10-22T11:00:00Z', average: 300 * 1024 ** 2 }] }] },
      { name: { value: 'Http5xx' }, unit: 'Count', timeseries: [{ data: [{ timeStamp: '2026-10-22T10:00:00Z', total: 0 }, { timeStamp: '2026-10-22T11:00:00Z', total: 3 }] }] },
      { name: { value: 'HttpResponseTime' }, unit: 'Seconds', timeseries: [] },
    ],
  };
  const { fetch, calls } = fakeFetch({ [`GET ${web.id}/providers/Microsoft.Insights/metrics`]: body });
  const azure = createAzure({ fetch, token: async () => 't' });
  const series = await azure.metrics(web, { span: TIMESPANS[1] });
  const q = new URL(calls[0].url).searchParams;
  assert.equal(q.get('metricnames'), METRICS.map((m) => m.name).join(','));
  assert.equal(q.get('interval'), 'PT1H');
  assert.match(q.get('timespan'), /^\d{4}-.*Z\/\d{4}-.*Z$/);
  assert.equal(q.get('aggregation'), 'Total,Average');
  assert.deepEqual(series[0].points.map((p) => p.value), [30, 90]);
  assert.deepEqual(seriesFrom(body)[1].points.map((p) => p.value), [200 * 1024 ** 2, 300 * 1024 ** 2]);
  assert.deepEqual([metricInterval(TIMESPANS[0]), metricInterval(TIMESPANS[2]), metricInterval(TIMESPANS[3])], ['PT5M', 'PT6H', 'P1D']);
  const rows = Object.fromEntries(metricRows(series, { width: 4 }).map((r) => [r.label, r]));
  assert.equal(rows.cpu.summary, '2.0 min cpu');
  assert.equal(rows.cpu.spark, '▄█');
  assert.equal(rows.memory.summary, '300 MB · peak 300 MB');
  assert.equal(rows['5xx'].summary, '3 errors');
  assert.equal(rows.response.summary, 'no data');
  const failing = createAzure({ fetch: fakeFetch({}).fetch, token: async () => 't' });
  await assert.rejects(failing.metrics(web, { span: TIMESPANS[0] }), /Reading web's metrics: not found/);

  const demo = demoAzure();
  const d = await loadSubscription(demo);
  const m = await demo.metrics(d.apps[0], { span: TIMESPANS[0] });
  assert.deepEqual(m.map((x) => x.name), METRICS.map((x) => x.name));
  assert.equal(m[0].points.length, 12, 'an hour at five minutes');
});

test('deployments: listed newest first with Kudu\'s states in words, and one\'s log in order', async () => {
  const web = siteFrom(site('web', 'rg'));
  const dep = (name, status, start, extra = {}) => ({ id: `${web.id}/deployments/${name}`, name: `web/${name}`, properties: { status, start_time: start, end_time: start, author: 'Ana', deployer: 'GitHub', message: `m ${name}\n`, ...extra } });
  const { fetch, calls } = fakeFetch({
    [`GET ${web.id}/deployments`]: { value: [dep('a1', 4, '2026-10-01T10:00:00Z'), dep('b2', 3, '2026-10-05T10:00:00Z', { active: false }), dep('c3', 1, '2026-10-06T10:00:00Z', { active: true })] },
    [`GET ${web.id}/deployments/b2/log`]: { value: [{ properties: { log_time: '2026-10-05T10:00:09Z', message: 'Build failed.' } }, { properties: { log_time: '2026-10-05T10:00:01Z', message: 'Fetching changes.' } }] },
  });
  const azure = createAzure({ fetch, token: async () => 't' });
  const list = await azure.deployments(web);
  assert.deepEqual(list.map((d) => [d.name, d.status, d.active]), [['c3', 'building', true], ['b2', 'failed', false], ['a1', 'succeeded', false]]);
  assert.deepEqual([list[0].author, list[0].deployer, list[0].message], ['Ana', 'GitHub', 'm c3']);
  assert.match(calls[0].url, /api-version=2023-12-01/);
  assert.deepEqual((await azure.deploymentLog(list[1])).map((l) => l.message), ['Fetching changes.', 'Build failed.']);
  const slot = { ...web, id: `${web.id}/slots/staging`, slot: 'staging' };
  await assert.rejects(azure.deployments(slot), /Listing web\/staging's deployments: not found/);
  assert.equal(deploymentFrom({ name: 'x', properties: { status: 9 } }).status, '9');
});

test('alerts: the fired ones over the span, most severe first; availability tests summarised by the demo', async () => {
  const alert = (name, severity, fired, extra = {}) => ({ id: `/subscriptions/s1/providers/Microsoft.AlertsManagement/alerts/${name}`, name, properties: { essentials: { severity, signalType: 'Metric', alertState: 'New', monitorCondition: 'Fired', targetResource: '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Web/sites/web', targetResourceType: 'microsoft.web/sites', targetResourceGroup: 'rg', startDateTime: fired, alertRule: '/x/metricalerts/r1', ...extra } } });
  const { fetch, calls } = fakeFetch({
    'GET /subscriptions/s1/providers/Microsoft.AlertsManagement/alerts': { value: [alert('slow', 'Sev3', '2026-10-22T10:00:00Z'), alert('down', 'Sev0', '2026-10-22T09:00:00Z', { targetResourceName: 'web' })] },
  });
  const azure = createAzure({ fetch, token: async () => 't' });
  const list = await azure.alerts('s1', { span: TIMESPANS[2] });
  assert.deepEqual(list.map((a) => [a.name, a.severity, a.target]), [['down', 'Sev0', 'web'], ['slow', 'Sev3', 'web']]);
  const q = new URL(calls[0].url).searchParams;
  assert.deepEqual([q.get('monitorCondition'), q.get('timeRange'), q.get('api-version')], ['Fired', '7d', '2019-05-05-preview']);
  assert.deepEqual(TIMESPANS.map(alertRange), ['1h', '1d', '7d', '30d']);
  assert.equal(alertFrom({ id: 'x', name: 'n', properties: {} }).target, '');

  const demo = demoAzure({ now: Date.parse('2026-10-22T12:00:00Z') });
  assert.deepEqual((await demo.alerts('sub-prod', { span: TIMESPANS[0] })).map((a) => a.severity), ['Sev1']);
  assert.equal((await demo.alerts('sub-prod', { span: TIMESPANS[2] })).length, 3);
  assert.equal((await demo.alerts('sub-dev', { span: TIMESPANS[3] })).length, 0);
  const tests = records(await demo.query({ appId: 'app-prod' }, availabilityQuery(), { timespan: 'P1D' }));
  assert.deepEqual(tests.map((t) => t.name).sort(), ['shop.contoso.com checkout', 'shop.contoso.com home page']);
  assert.ok(tests.every((t) => t.total > 200 && t.locations === 3));
  assert.equal(tests.find((t) => t.name.endsWith('home page')).failed, 0);
});

test('other resources: container apps, storage, SQL servers, databases, admins, firewall, connection strings, the public address, a workspace query', async () => {
  const rg = '/subscriptions/s1/resourceGroups/rg-prod';
  const ca = { id: `${rg}/providers/Microsoft.App/containerApps/worker`, name: 'worker', location: 'westeurope', properties: { runningStatus: 'Running', latestRevisionName: 'worker--r3', latestReadyRevisionName: 'worker--r2', managedEnvironmentId: `${rg}/providers/Microsoft.App/managedEnvironments/env`, configuration: { ingress: { fqdn: 'worker.x.azurecontainerapps.io' } }, template: { containers: [{ image: 'cr.io/worker:1' }] } } };
  const sql = { id: `${rg}/providers/Microsoft.Sql/servers/db1`, name: 'db1', location: 'westeurope', properties: { state: 'Ready', fullyQualifiedDomainName: 'db1.database.windows.net', version: '12.0' } };
  const web = siteFrom(site('web', 'rg-prod'));
  const { fetch, calls } = fakeFetch({
    'GET /subscriptions/s1/providers/Microsoft.App/containerApps': { value: [ca] },
    [`POST ${ca.id}/revisions/worker--r3/restart`]: {},
    [`GET ${rg}/providers/Microsoft.App/managedEnvironments/env`]: { name: 'env', properties: { appLogsConfiguration: { logAnalyticsConfiguration: { customerId: 'ws-1' } } } },
    'POST api.loganalytics.io/v1/workspaces/ws-1/query': { tables: [{ columns: [{ name: 'Log_s', type: 'string' }], rows: [['hello']] }] },
    'GET /subscriptions/s1/providers/Microsoft.Storage/storageAccounts': { value: [{ id: `${rg}/providers/Microsoft.Storage/storageAccounts/st1`, name: 'st1', kind: 'StorageV2', sku: { name: 'Standard_LRS' }, properties: { provisioningState: 'Succeeded', statusOfPrimary: 'available', accessTier: 'Hot', primaryEndpoints: { blob: 'https://st1.blob.core.windows.net/' } } }] },
    'GET /subscriptions/s1/providers/Microsoft.Sql/servers': { value: [sql] },
    [`GET ${sql.id}/databases`]: { value: [{ id: `${sql.id}/databases/master`, name: 'master', properties: { status: 'Online' } }, { id: `${sql.id}/databases/shop`, name: 'shop', sku: { name: 'S1', tier: 'Standard' }, properties: { status: 'Online' } }] },
    [`GET ${sql.id}/administrators`]: { value: [{ properties: { login: 'DBAs', principalType: 'Group', azureADOnlyAuthentication: true } }] },
    [`GET ${sql.id}/firewallRules`]: { value: [{ name: 'AllowAllWindowsAzureIps', properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' } }] },
    [`PUT ${sql.id}/firewallRules/sonar-198-51-100-7`]: {},
    [`POST ${web.id}/config/connectionstrings/list`]: { properties: { Db: { value: 'Server=db1;Password=x', type: 'SQLAzure' } } },
    'GET api.ipify.org/': { raw: '198.51.100.7\n' },
  });
  const tokens = [];
  const azure = createAzure({ fetch, token: async (r) => (tokens.push(r), 't') });
  const [worker] = await azure.containerApps('s1');
  assert.deepEqual([worker.type, worker.name, worker.resourceGroup, worker.state, worker.host, worker.latestRevision, worker.image], ['container', 'worker', 'rg-prod', 'Running', 'worker.x.azurecontainerapps.io', 'worker--r3', 'cr.io/worker:1']);
  await azure.restartRevision(worker);
  assert.match(calls.at(-1).url, /revisions\/worker--r3\/restart\?api-version=2024-03-01$/);
  const ws = await azure.containerAppWorkspace(worker);
  assert.deepEqual([ws.workspaceId, ws.name], ['ws-1', 'env logs']);
  assert.deepEqual((await azure.query(ws, 'ContainerAppConsoleLogs_CL | take 1')).rows, [['hello']]);
  assert.equal(tokens.at(-1), 'https://api.loganalytics.io');
  const [st] = await azure.storageAccounts('s1');
  assert.deepEqual([st.type, st.state, st.sku, st.tier, st.host], ['storage', 'Available', 'Standard_LRS', 'Hot', 'st1.blob.core.windows.net']);
  const [server] = await azure.sqlServers('s1');
  assert.deepEqual([server.type, server.fqdn, server.state, server.admin], ['sqlserver', 'db1.database.windows.net', 'Ready', null]);
  const dbs = await azure.sqlDatabases(server);
  assert.deepEqual(dbs.map((d) => [d.name, d.sku, d.tier, label(d)]), [['shop', 'S1', 'Standard', 'db1/shop']]);
  assert.deepEqual(await azure.sqlAdmin(server), { login: 'DBAs', type: 'Group', only: true });
  assert.deepEqual(await azure.firewallRules(server), [{ name: 'AllowAllWindowsAzureIps', start: '0.0.0.0', end: '0.0.0.0' }]);
  await azure.addFirewallRule(server, { name: 'sonar-198-51-100-7', start: '198.51.100.7' });
  assert.deepEqual([calls.at(-1).init.method, calls.at(-1).body], ['PUT', { properties: { startIpAddress: '198.51.100.7', endIpAddress: '198.51.100.7' } }]);
  assert.match(calls.at(-1).url, /api-version=2021-11-01/);
  assert.deepEqual(await azure.connectionStrings(web), { Db: 'Server=db1;Password=x' });
  assert.equal(await azure.publicIp(), '198.51.100.7');
  assert.equal(sqlServerFrom({ id: 'x', name: 'n', properties: { administrators: { login: 'me', principalType: 'User' } } }).admin.login, 'me');
});

test('the tree with the other kinds: under their resource groups, databases under their server, a filter that finds a database', async () => {
  const d = await loadSubscription(demoAzure());
  const rows = resourceRows(d.apps, d.slots, '', d);
  assert.deepEqual(rows.map((r) => r.text ?? `${r.kind}:${label(r.target)}`), [
    'contoso-prod', 'app:contoso-web', 'slot:contoso-web/staging', 'app:contoso-api', 'slot:contoso-api/staging', 'app:contoso-orders',
    'container:contoso-worker', 'sqlserver:contoso-sql-prod', 'sqldb:contoso-sql-prod/contoso', 'sqldb:contoso-sql-prod/contoso-reporting', 'storage:contosoprodstore', 'servicebus:contoso-bus', 'cosmos:contoso-cosmos', 'workspace:contoso-logs',
    'contoso-qa', 'sqlserver:contoso-sql-qa', 'sqldb:contoso-sql-qa/contoso-qa',
  ]);
  assert.deepEqual(resourceRows(d.apps, d.slots, 'reporting', d).map((r) => r.text ?? label(r.target)), ['contoso-prod', 'contoso-sql-prod', 'contoso-sql-prod/contoso-reporting']);
  assert.equal(d.sqlServers[0].admin, null, 'the admin is read when the cursor stops on a server, not with the subscription');
  assert.equal((await demoAzure().sqlAdmin(d.sqlServers[0])).login, 'SQL Admins');
  assert.deepEqual(Object.keys(sqlByLabel(d.sqlServers)), ['contoso-sql-prod', 'contoso-sql-prod/contoso', 'contoso-sql-prod/contoso-reporting', 'contoso-sql-qa', 'contoso-sql-qa/contoso-qa']);
});

test('calls under one signal (a load\'s) leave no listeners on it, and it still cancels them', async () => {
  const { fetch, calls } = fakeFetch({ 'GET /subscriptions': { value: [{ subscriptionId: 's1', displayName: 'One', state: 'Enabled' }] } });
  const azure = createAzure({ fetch, token: async () => 't' });
  const load = new AbortController();
  for (let i = 0; i < 30; i++) await azure.subscriptions({ signal: load.signal });
  assert.equal(getEventListeners(load.signal, 'abort').length, 0);
  // Each call had a signal of its own, aborted with the load's.
  const hanging = createAzure({
    fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    token: async () => 't',
  });
  const p = hanging.subscriptions({ signal: load.signal });
  await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(calls[0].init.signal, load.signal);
  load.abort();
  await assert.rejects(p, /aborted/);
  assert.equal(getEventListeners(load.signal, 'abort').length, 0);
});

test('Key Vault references: each setting\'s status from configreferences; the demo resolves from its vault', async () => {
  const web = site('web', 'rg-prod');
  const { fetch, calls } = fakeFetch({
    [`GET ${web.id}/config/configreferences/appsettings`]: {
      value: [
        { id: `${web.id}/config/configreferences/appsettings/Db__Password`, name: 'Db__Password', properties: { reference: '@Microsoft.KeyVault(VaultName=kv;SecretName=db)', status: 'AccessToKeyVaultDenied', vaultName: 'kv', secretName: 'db', identityType: 'SystemAssigned', details: 'Forbidden' } },
        { id: `${web.id}/config/configreferences/appsettings/ApiKey`, properties: { status: 'Resolved', vaultName: 'kv', secretName: 'api' } },
      ],
    },
  });
  const azure = createAzure({ fetch, token: async () => 't' });
  const refs = await azure.keyVaultReferences(siteFrom(web));
  assert.deepEqual(refs.map((r) => [r.name, r.status, r.vault, r.secret]), [['Db__Password', 'AccessToKeyVaultDenied', 'kv', 'db'], ['ApiKey', 'Resolved', 'kv', 'api']]);
  assert.match(calls[0].url, /api-version=2022-03-01/);

  const demo = demoAzure();
  const api = demo.state.sites.find((s) => s.name === 'contoso-api' && !s.slot);
  const said = Object.fromEntries((await demo.keyVaultReferences(api)).map((r) => [r.name, r.status]));
  assert.deepEqual(said, { Payments__ApiKey: 'Resolved', Smtp__Password: 'AccessToKeyVaultDenied' });
  assert.deepEqual(await demo.keyVaultReferences(demo.state.sites.find((s) => s.name === 'contoso-web' && !s.slot)), []);
});

test('Storage\'s XML errors are said in words, with the status on the error', async () => {
  assert.deepEqual(xmlError('<?xml version="1.0"?><Error><Code>AuthorizationPermissionMismatch</Code><Message>This request is not authorized.\nRequestId:1</Message></Error>'), { error: { message: 'AuthorizationPermissionMismatch: This request is not authorized.' } });
  assert.equal(xmlError('nothing'), null);
});

test('functions: listed with their triggers; invoked over HTTP with the function\'s key in a header only, else through the admin endpoint with the master key', async () => {
  const fnApp = site('orders', 'rg-prod', 'functionapp');
  const { fetch, calls } = fakeFetch({
    [`GET ${fnApp.id}/functions`]: {
      value: [
        { id: `${fnApp.id}/functions/PlaceOrder`, name: 'orders/PlaceOrder', properties: { name: 'PlaceOrder', invoke_url_template: 'https://orders.azurewebsites.net/api/orders', config: { bindings: [{ type: 'httpTrigger', methods: ['post'], authLevel: 'function', route: 'orders' }, { type: 'http', direction: 'out' }] } } },
        { id: `${fnApp.id}/functions/Cleanup`, name: 'orders/Cleanup', properties: { name: 'Cleanup', isDisabled: true, config: { bindings: [{ type: 'timerTrigger', schedule: '0 0 2 * * *' }] } } },
      ],
    },
    [`POST ${fnApp.id}/functions/PlaceOrder/listkeys`]: { default: 'fn-key-123' },
    [`POST ${fnApp.id}/host/default/listkeys`]: { masterKey: 'master-456', functionKeys: { default: 'host-fn-key' } },
    'POST orders.azurewebsites.net/api/orders': [500, { raw: 'boom', headers: { 'content-type': 'text/plain' } }],
    'POST orders.azurewebsites.net/admin/functions/Cleanup': [202, { raw: '' }],
    'GET orders.azurewebsites.net/api/health': { raw: 'Healthy' },
  });
  const azure = createAzure({ fetch, token: async () => 'arm-token' });
  const target = siteFrom(fnApp);
  const list = await azure.functions(target);
  assert.deepEqual(list.map((f) => [f.name, f.trigger, f.methods, f.source, f.disabled]), [['Cleanup', 'timerTrigger', null, '0 0 2 * * *', true], ['PlaceOrder', 'httpTrigger', ['POST'], null, false]]);

  const res = await azure.invokeFunction(target, list[1], { input: '{"sku":1}' });
  assert.deepEqual([res.status, res.type, res.body, res.method, res.url], [500, 'text/plain', 'boom', 'POST', 'https://orders.azurewebsites.net/api/orders']);
  const sent = calls.at(-1);
  assert.equal(sent.init.headers['x-functions-key'], 'fn-key-123');
  assert.equal(sent.init.headers.Authorization, undefined, 'no Azure token goes to the function');
  assert.deepEqual(sent.body, { sku: 1 });
  assert.equal(sent.init.body, '{"sku":1}');
  assert.doesNotMatch(sent.url, /fn-key|code=/);

  const admin = await azure.invokeFunction(target, list[0], { input: 'now' });
  assert.equal(admin.status, 202);
  assert.equal(calls.at(-1).init.headers['x-functions-key'], 'master-456');
  assert.deepEqual(calls.at(-1).body, { input: 'now' });

  const before = calls.length;
  const health = await azure.invokeFunction(target, { name: 'Health', trigger: 'httpTrigger', methods: ['GET'], authLevel: 'anonymous', url: 'https://orders.azurewebsites.net/api/health' });
  assert.equal(health.body, 'Healthy');
  assert.equal(calls.length, before + 1, 'an anonymous function needs no key');
  assert.equal(calls.at(-1).init.headers['x-functions-key'], undefined);
});

test('plans: read, scaled by writing them back whole with the new SKU; autoscale settings with their rules', async () => {
  const planId = '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Web/serverfarms/plan-1';
  const raw = { id: planId, name: 'plan-1', location: 'westeurope', kind: 'linux', tags: { team: 'a' }, sku: { name: 'P1v3', tier: 'PremiumV3', size: 'P1v3', family: 'Pv3', capacity: 2 }, properties: { numberOfSites: 3, maximumNumberOfWorkers: 30, reserved: true, status: 'Ready' } };
  const { fetch, calls } = fakeFetch({
    [`GET ${planId}`]: raw,
    [`PUT ${planId}`]: (body) => ({ ...raw, sku: body.sku }),
    'GET /subscriptions/s1/providers/Microsoft.Insights/autoscalesettings': {
      value: [{ id: '/x/autoscalesettings/a1', name: 'a1', properties: { enabled: true, targetResourceUri: planId.toLowerCase(), profiles: [{ name: 'Default', capacity: { minimum: '2', maximum: '5', default: '2' }, rules: [{ metricTrigger: { metricName: 'CpuPercentage', operator: 'GreaterThan', threshold: 70 }, scaleAction: { direction: 'Increase', type: 'ChangeCount', value: '1' } }] }] } }],
    },
  });
  const azure = createAzure({ fetch, token: async () => 't' });
  const plan = await azure.plan(planId);
  assert.deepEqual([plan.name, plan.sku, plan.maxWorkers, plan.sites], ['plan-1', { name: 'P1v3', tier: 'PremiumV3', capacity: 2 }, 30, 3]);
  const after = await azure.scalePlan(plan, { name: 'P1v3', tier: 'PremiumV3', capacity: 4 });
  assert.equal(after.sku.capacity, 4);
  const put = calls.at(-1);
  assert.equal(put.init.method, 'PUT');
  assert.deepEqual(put.body, { location: 'westeurope', kind: 'linux', tags: { team: 'a' }, sku: { name: 'P1v3', tier: 'PremiumV3', capacity: 4 }, properties: raw.properties });
  const [auto] = await azure.autoscaleSettings('s1');
  assert.deepEqual([auto.enabled, auto.profiles[0].min, auto.profiles[0].max, auto.profiles[0].rules[0].metric], [true, 2, 5, 'CpuPercentage']);
});

test('routing: the ramp-up rules read from config/web, and written back whole with PATCH', async () => {
  const web = site('web', 'rg-prod');
  const { fetch, calls } = fakeFetch({
    [`GET ${web.id}/config/web`]: { properties: { experiments: { rampUpRules: [{ actionHostName: 'web-staging.azurewebsites.net', reroutePercentage: 10, name: 'staging' }] } } },
    [`PATCH ${web.id}/config/web`]: {},
  });
  const azure = createAzure({ fetch, token: async () => 't' });
  assert.deepEqual(await azure.routing(siteFrom(web)), [{ slot: 'staging', host: 'web-staging.azurewebsites.net', percent: 10 }]);
  await azure.setRouting(siteFrom(web), [{ slot: 'beta', host: 'web-beta.azurewebsites.net', percent: 5 }]);
  assert.deepEqual(calls.at(-1).body, { properties: { experiments: { rampUpRules: [{ actionHostName: 'web-beta.azurewebsites.net', reroutePercentage: 5, name: 'beta' }] } } });
});

test('Service Bus: namespaces and entities with their counts; dead letters peeked by locking and letting go, resubmitted, purged; a 403 names the role', async () => {
  const nsId = '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.ServiceBus/namespaces/bus';
  const letter = (seq, extra = {}) => ({ raw: `{"n":${seq}}`, headers: { BrokerProperties: JSON.stringify({ MessageId: `m${seq}`, SequenceNumber: seq, DeliveryCount: 10, EnqueuedTimeUtc: 'Sat, 24 Oct 2026 10:00:00 GMT', Label: 'charge' }), 'Content-Type': 'application/json', Location: `https://bus.servicebus.windows.net/q/$DeadLetterQueue/messages/m${seq}/lock-${seq}`, DeadLetterReason: '"MaxDeliveryCountExceeded"', Attempt: '10', ...extra } });
  let queue = [1, 2, 3];
  const locked = new Set();
  const lockHead = () => {
    const seq = queue.find((x) => !locked.has(x));
    if (seq == null) return [204, { raw: '' }];
    locked.add(seq);
    return [201, letter(seq)];
  };
  const routes = {
    'GET /subscriptions/s1/providers/Microsoft.ServiceBus/namespaces': { value: [{ id: nsId, name: 'bus', location: 'westeurope', sku: { name: 'Standard' }, properties: { serviceBusEndpoint: 'https://bus.servicebus.windows.net:443/', status: 'Active' } }] },
    [`GET ${nsId}/queues`]: { value: [{ name: 'q', properties: { status: 'Active', countDetails: { activeMessageCount: 5, deadLetterMessageCount: 3, scheduledMessageCount: 1 } } }] },
    [`GET ${nsId}/topics`]: { value: [{ name: 't', properties: { subscriptionCount: 1, countDetails: { activeMessageCount: 0 } } }] },
    [`GET ${nsId}/topics/t/subscriptions`]: { value: [{ name: 's', properties: { countDetails: { activeMessageCount: 2, deadLetterMessageCount: 1 } } }] },
    'POST bus.servicebus.windows.net/q/$DeadLetterQueue/messages/head': lockHead,
    'POST bus.servicebus.windows.net/q/messages': [201, { raw: '' }],
    'DELETE bus.servicebus.windows.net/q/$DeadLetterQueue/messages/head': () => (queue.length ? (queue.shift(), [200, letter(9)]) : [204, { raw: '' }]),
  };
  for (const n of [1, 2, 3]) {
    routes[`PUT bus.servicebus.windows.net/q/$DeadLetterQueue/messages/m${n}/lock-${n}`] = () => (locked.delete(n), [200, { raw: '' }]);
    routes[`DELETE bus.servicebus.windows.net/q/$DeadLetterQueue/messages/m${n}/lock-${n}`] = () => ((queue = queue.filter((x) => x !== n)), locked.delete(n), [200, { raw: '' }]);
  }
  const { fetch, calls } = fakeFetch(routes);
  const tokens = [];
  const azure = createAzure({ fetch, token: async (r) => (tokens.push(r), 't') });
  const [ns] = await azure.serviceBusNamespaces('s1');
  assert.deepEqual([ns.name, ns.host, ns.sku, ns.type], ['bus', 'bus.servicebus.windows.net', 'Standard', 'servicebus']);
  const entities = await azure.serviceBusEntities(ns);
  assert.deepEqual(entities.map((e) => [e.kind, e.name, e.path, e.active, e.deadLetter, e.scheduled]), [['queue', 'q', 'q', 5, 3, 1], ['topic', 't', 't', 0, 0, 0], ['subscription', 't/s', 't/subscriptions/s', 2, 1, 0]]);

  const peeked = await azure.peekDeadLetters(ns, entities[0], { max: 10 });
  assert.deepEqual(peeked.map((m) => [m.sequence, m.id, m.reason, m.label, m.body, m.properties.attempt]), [1, 2, 3].map((n) => [n, `m${n}`, 'MaxDeliveryCountExceeded', 'charge', `{"n":${n}}`, '10']));
  assert.equal(locked.size, 0, 'every lock let go');
  assert.deepEqual(queue, [1, 2, 3], 'nothing taken');
  assert.ok(tokens.includes('https://servicebus.azure.net'));

  const { moved, missing } = await azure.resubmitDeadLetters(ns, entities[0], [2, 7]);
  assert.deepEqual([moved, missing], [1, ['7']]);
  assert.deepEqual(queue, [1, 3]);
  assert.equal(locked.size, 0);
  const sent = calls.find((c) => c.key === 'POST bus.servicebus.windows.net/q/messages');
  assert.equal(sent.init.body, '{"n":2}');
  assert.deepEqual(JSON.parse(sent.init.headers.BrokerProperties), { MessageId: 'm2', Label: 'charge' });
  // fetch gives header names in lower case, so a custom property goes back that way.
  assert.equal(sent.init.headers.attempt, '10');
  assert.equal(Object.keys(sent.init.headers).some((k) => /deadletter/i.test(k)), false);

  assert.equal(await azure.purgeDeadLetters(ns, entities[0]), 2);
  assert.deepEqual(queue, []);

  const denied = createAzure({ fetch: fakeFetch({ 'POST bus.servicebus.windows.net/q/$DeadLetterQueue/messages/head': [401, { raw: '<Error><Code>401</Code><Detail>Unauthorized</Detail></Error>' }] }).fetch, token: async () => 't' });
  await assert.rejects(denied.peekDeadLetters(ns, entities[0]), /Azure Service Bus Data Owner \(or Data Receiver to peek\) on bus/);
});

test('blobs: containers across pages, a folder\'s prefixes and blobs, a blob\'s first megabyte, with Storage\'s version and token; a 403 names the role', async () => {
  const account = { name: 'acct', host: 'acct.blob.core.windows.net' };
  const { fetch, calls } = fakeFetch({
    'GET acct.blob.core.windows.net/': (_, call) =>
      new URL(call.url).searchParams.get('marker')
        ? { raw: '<EnumerationResults><Containers><Container><Name>logs</Name><Properties><Last-Modified>Sat, 24 Oct 2026 10:00:00 GMT</Last-Modified></Properties></Container></Containers><NextMarker /></EnumerationResults>' }
        : { raw: '<?xml version="1.0"?><EnumerationResults><Containers><Container><Name>exports</Name><Properties><Last-Modified>Fri, 23 Oct 2026 10:00:00 GMT</Last-Modified><PublicAccess>blob</PublicAccess></Properties></Container></Containers><NextMarker>m2</NextMarker></EnumerationResults>' },
    'GET acct.blob.core.windows.net/exports': { raw: '<EnumerationResults><Blobs><BlobPrefix><Name>orders/archive/</Name></BlobPrefix><Blob><Name>orders/a &amp; b.csv</Name><Properties><Last-Modified>Fri, 23 Oct 2026 10:00:00 GMT</Last-Modified><Content-Length>91</Content-Length><Content-Type>text/csv</Content-Type><BlobType>BlockBlob</BlobType><AccessTier>Hot</AccessTier></Properties></Blob></Blobs><NextMarker/></EnumerationResults>' },
    'GET acct.blob.core.windows.net/exports/orders/a%20%26%20b.csv': [206, { raw: 'a,b\n1,2\n', headers: { 'content-type': 'text/csv', 'content-range': 'bytes 0-7/8' } }],
    'GET acct.blob.core.windows.net/secret': [403, { raw: '<Error><Code>AuthorizationPermissionMismatch</Code><Message>This request is not authorized to perform this operation using this permission.</Message></Error>' }],
  });
  const tokens = [];
  const azure = createAzure({ fetch, token: async (r) => (tokens.push(r), 't') });
  const containers = await azure.containers(account);
  assert.deepEqual(containers.map((c) => [c.name, c.access]), [['exports', 'blob'], ['logs', 'private']]);
  assert.equal(calls[0].init.headers['x-ms-version'], '2023-11-03');
  assert.ok(tokens.every((t) => t === 'https://storage.azure.com/'));
  const folder = await azure.blobs(account, 'exports', 'orders/');
  assert.deepEqual(folder.prefixes, ['orders/archive/']);
  assert.deepEqual(folder.blobs.map((b) => [b.name, b.size, b.type, b.tier]), [['orders/a & b.csv', 91, 'text/csv', 'Hot']]);
  const q = new URL(calls.at(-1).url).searchParams;
  assert.deepEqual([q.get('restype'), q.get('comp'), q.get('delimiter'), q.get('prefix')], ['container', 'list', '/', 'orders/']);
  const read = await azure.readBlob(account, 'exports', 'orders/a & b.csv');
  assert.deepEqual([read.text, read.type, read.partial], ['a,b\n1,2\n', 'text/csv', false]);
  assert.equal(calls.at(-1).init.headers['x-ms-range'], 'bytes=0-1048575');
  await assert.rejects(azure.blobs(account, 'secret'), /Storage Blob Data Reader on acct is needed to read its blobs \(Listing secret\/\)/);
});

test('Cosmos DB: accounts with their API, databases and containers with partition keys and throughput (none where it is shared)', async () => {
  const acc = '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.DocumentDB/databaseAccounts/cos';
  const { fetch } = fakeFetch({
    'GET /subscriptions/s1/providers/Microsoft.DocumentDB/databaseAccounts': { value: [{ id: acc, name: 'cos', kind: 'GlobalDocumentDB', location: 'westeurope', properties: { provisioningState: 'Succeeded', documentEndpoint: 'https://cos.documents.azure.com:443/', consistencyPolicy: { defaultConsistencyLevel: 'Session' }, locations: [{ locationName: 'West Europe' }], capabilities: [] } }, { id: `${acc}2`, name: 'mon', kind: 'MongoDB', properties: {} }] },
    [`GET ${acc}/sqlDatabases`]: { value: [{ name: 'shop', properties: { resource: { id: 'shop' } } }] },
    [`GET ${acc}/sqlDatabases/shop/throughputSettings/default`]: { properties: { resource: { autoscaleSettings: { maxThroughput: 4000 } } } },
    [`GET ${acc}/sqlDatabases/shop/containers`]: { value: [{ name: 'orders', properties: { resource: { id: 'orders', partitionKey: { paths: ['/customerId'], kind: 'Hash' }, defaultTtl: -1 } } }, { name: 'carts', properties: { resource: { id: 'carts', partitionKey: { paths: ['/tenant', '/userId'], kind: 'MultiHash' } } } }] },
    [`GET ${acc}/sqlDatabases/shop/containers/orders/throughputSettings/default`]: { properties: { resource: { throughput: 400 } } },
    [`GET ${acc}/sqlDatabases/shop/containers/carts/throughputSettings/default`]: [404, { error: { message: 'Throughput settings are not found' } }],
  });
  const azure = createAzure({ fetch, token: async () => 't' });
  const [cos, mon] = await azure.cosmosAccounts('s1');
  assert.deepEqual([cos.api, cos.host, cos.consistency, cos.regions, cos.state, mon.api], ['NoSQL', 'cos.documents.azure.com', 'Session', ['West Europe'], 'Online', 'MongoDB']);
  const [shop] = await azure.cosmosTree(cos);
  assert.deepEqual(shop.throughput, { autoscale: 4000 });
  assert.deepEqual(shop.containers.map((c) => [c.name, c.partitionKey, c.hierarchical, c.throughput]), [['carts', '/tenant, /userId', true, null], ['orders', '/customerId', false, { manual: 400 }]]);
  assert.deepEqual(await azure.cosmosTree({ ...cos, api: 'Cassandra' }), []);
});

test('container apps\' metrics: requests, CPU, memory and replicas asked for, read with each one\'s aggregation, as sparklines', async () => {
  const id = '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.App/containerApps/worker';
  const point = (t, v) => ({ timeStamp: t, total: v, average: v / 2, maximum: v * 2 });
  const { fetch, calls } = fakeFetch({
    [`GET ${id}/providers/Microsoft.Insights/metrics`]: {
      value: ['Requests', 'UsageNanoCores', 'WorkingSetBytes', 'Replicas'].map((n, i) => ({ name: { value: n }, unit: 'Count', timeseries: [{ data: [point('2026-10-24T10:00:00Z', 2 + i), point('2026-10-24T11:00:00Z', 4 + i)] }] })),
    },
  });
  const azure = createAzure({ fetch, token: async () => 't' });
  const target = { type: 'container', id, name: 'worker' };
  const series = await azure.metrics(target, { span: TIMESPANS[1] });
  const q = new URL(calls[0].url).searchParams;
  assert.equal(q.get('metricnames'), 'Requests,UsageNanoCores,WorkingSetBytes,Replicas');
  assert.equal(q.get('aggregation'), 'Total,Average,Maximum');
  assert.deepEqual(series.map((s) => s.points.map((p) => p.value)), [[2, 4], [1.5, 2.5], [2, 3], [10, 14]]);
  const rows = metricRows(series, { width: 4, defs: metricsFor(target) });
  assert.deepEqual(rows.map((r) => r.label), ['requests', 'cpu', 'memory', 'replicas']);
  assert.equal(rows[0].summary, '6 requests');
  assert.equal(rows[3].summary, '14 · peak 14');
  assert.equal(metricsFor({ kind: 'app' }), METRICS);
  const demo = demoAzure();
  const d = await demo.metrics(demo.state.containers[0], { span: TIMESPANS[0] });
  assert.deepEqual(d.map((s) => [s.name, s.points.length]), [['Requests', 12], ['UsageNanoCores', 12], ['WorkingSetBytes', 12], ['Replicas', 12]]);
  assert.match(metricRows(d, { defs: metricsFor(target) })[1].summary, /millicores · peak \d+ millicores/);
});

test('Log Analytics workspaces: listed with their customer id; their tables from the query API\'s metadata, else from a query', async () => {
  const wsId = '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/logs';
  const { fetch, calls } = fakeFetch({
    'GET /subscriptions/s1/providers/Microsoft.OperationalInsights/workspaces': { value: [{ id: wsId, name: 'logs', location: 'westeurope', properties: { customerId: 'cust-1', retentionInDays: 30, provisioningState: 'Succeeded', sku: { name: 'PerGB2018' } } }] },
    'GET api.loganalytics.io/v1/workspaces/cust-1/metadata': { tables: [{ name: 'AppTraces', columns: [{ name: 'Message' }] }, { name: 'AppRequests', columns: [{ name: 'Name' }, { name: 'Url' }] }] },
    'GET api.loganalytics.io/v1/workspaces/cust-2/metadata': [403, { error: { message: 'no' } }],
    'POST api.loganalytics.io/v1/workspaces/cust-2/query': { tables: [{ columns: [{ name: '$table', type: 'string' }], rows: [['Heartbeat'], ['AppRequests']] }] },
  });
  const tokens = [];
  const azure = createAzure({ fetch, token: async (r) => (tokens.push(r), 't') });
  const [ws] = await azure.logWorkspaces('s1');
  assert.deepEqual([ws.type, ws.name, ws.workspaceId, ws.retention, ws.sku, ws.state], ['workspace', 'logs', 'cust-1', 30, 'PerGB2018', 'Ready']);
  assert.deepEqual(await azure.workspaceTables(ws), { AppRequests: ['Name', 'Url'], AppTraces: ['Message'] });
  assert.equal(tokens.at(-1), 'https://api.loganalytics.io');
  assert.deepEqual(await azure.workspaceTables({ ...ws, workspaceId: 'cust-2' }), { AppRequests: [], Heartbeat: [] });
  assert.deepEqual(calls.at(-1).body, { query: 'search * | distinct $table | take 500', timespan: 'P7D' });
});
