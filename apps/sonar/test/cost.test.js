// What things cost: Cost Management's answer read, kept per resource and group, and shown in Resources.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { costsFrom, createAzure } from '../src/azure/arm.js';
import { costDay, costOf, groupCost, money } from '../src/cost.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('Cost Management: MonthToDate ActualCost by resource, across pages, read whole', async () => {
  const calls = [];
  const page = (rows, nextLink) => ({ properties: { nextLink, columns: [{ name: 'Cost', type: 'Number' }, { name: 'ResourceId', type: 'String' }, { name: 'Currency', type: 'String' }], rows } });
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const second = url.includes('skiptoken');
    return { ok: true, status: 200, text: async () => JSON.stringify(second ? page([[2, '/subscriptions/s1/resourcegroups/rg/providers/microsoft.web/sites/web', 'EUR']]) : page([[10.5, '/subscriptions/s1/resourcegroups/rg/providers/microsoft.web/serverfarms/plan', 'EUR'], [1, '/subscriptions/s1/resourcegroups/rg/providers/microsoft.web/sites/web', 'EUR']], 'https://management.azure.com/subscriptions/s1/providers/Microsoft.CostManagement/query?api-version=2023-03-01&$skiptoken=x')) };
  };
  const azure = createAzure({ fetch, token: async () => 't' });
  const costs = await azure.costs('s1');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(new URL(calls[0].url).pathname, '/subscriptions/s1/providers/Microsoft.CostManagement/query');
  assert.equal(new URL(calls[0].url).searchParams.get('api-version'), '2023-03-01');
  assert.deepEqual(calls[0].body, { type: 'ActualCost', timeframe: 'MonthToDate', dataset: { granularity: 'None', aggregation: { totalCost: { name: 'Cost', function: 'Sum' } }, grouping: [{ type: 'Dimension', name: 'ResourceId' }] } });
  assert.equal(calls.length, 2);
  assert.deepEqual(costs, { currency: 'EUR', byId: { '/subscriptions/s1/resourcegroups/rg/providers/microsoft.web/serverfarms/plan': 10.5, '/subscriptions/s1/resourcegroups/rg/providers/microsoft.web/sites/web': 3 } });
  assert.equal(costOf(costs, '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Web/sites/web'), 3);
  assert.equal(costOf(costs, '/x'), null);
  assert.equal(groupCost(costs, 's1', 'RG'), 13.5);
  assert.equal(groupCost(costs, 's1', 'other'), null);
  assert.equal(groupCost(null, 's1', 'rg'), null);
  assert.equal(money(13.5, 'EUR'), '€13.50');
  assert.equal(money(3, 'USD'), '$3.00');
  assert.equal(costsFrom({ properties: { columns: [{ name: 'PreTaxCost' }, { name: 'ResourceId' }], rows: [[1, '/A']] } }).byId['/a'], 1);
  assert.match(costDay(Date.parse('2026-10-23T23:00:00Z')), /^2026-10-23$/);

  const refused = createAzure({ fetch: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: { message: 'no access' } }) }), token: async () => 't' });
  await assert.rejects(refused.costs('s1'), /Reading the costs: you don't have access/);
});

test("Resources: each resource group's cost this month, an app's own and its plan's; nothing said without access", async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  let asked = 0;
  const costs = app.provider.costs;
  app.provider.costs = (...args) => (asked++, costs(...args));
  try {
    await until(() => /contoso-prod\s+€324\.28/.test(frame()), "the group's cost");
    assert.match(frame(), /contoso-qa\s+€3\.65/);
    app.stdin.write(KEYS.esc);
    await until(() => /cost\s+€0\.41 this month · its plan €122\.40/.test(frame()), "the app's cost and its plan's");
    for (let i = 0; i < 5; i++) app.stdin.write('j');
    await until(() => /❯ ● contoso-worker/.test(frame()), 'the container app');
    await until(() => /cost\s+€18\.04 this month/.test(frame()), "the container app's");
    app.stdin.write('r');
    await until(() => frame().includes('contoso-worker') && /contoso-prod\s+€324\.28/.test(frame()), 'read again');
    assert.equal(asked, 1, 'read once, kept for the day, not read again with r');
    app.stdin.write('/');
    await type(app.stdin, 'sub Contoso Dev');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('contoso-web-dev') && frame().includes('insights  contoso-dev-ai'), 'the dev subscription');
    assert.doesNotMatch(frame(), /€|cost\s/);
    assert.doesNotMatch(frame(), /Reading the costs/);
  } finally {
    app.unmount();
  }
});
