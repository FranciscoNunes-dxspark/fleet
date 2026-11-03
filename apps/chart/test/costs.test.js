// What a plan costs a month: what sets each resource's price, the price list's items picked (never
// guessed), the totals, the provider's paged and cached asking, and where the costs are shown.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { planCosts, pricingPlan, pricingSpec, money, costWords, totalWords, regionOf } from '../src/costs.js';
import { parseTerraformPlan, parseWhatIf } from '../src/plan.js';
import { DEMO_PLAN, DEMO_WHAT_IF, demoChart } from '../src/demo.js';
import { createChart, priceFilter } from '../src/iac.js';
import { runHeadless } from '../src/headless.js';
import { markdownReport } from '../src/share.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

const item = (productName, skuName, retailPrice, extra = {}) => ({ productName, skuName, meterName: skuName, retailPrice, unitOfMeasure: '1 Hour', type: 'Consumption', ...extra });

test('what sets the price, from the mapping table: skus, sizes, counts, OS; usage-priced and unknown types said so; nothing sensitive or unknown taken', () => {
  assert.deepEqual(pricingSpec('azurerm_service_plan', { sku_name: 'P1v3', os_type: 'Linux', worker_count: 3, location: 'West Europe' }), { kind: 'appservice', sku: 'P1v3', os: 'linux', count: 3, location: 'West Europe' });
  assert.deepEqual(pricingSpec('azurerm_windows_virtual_machine', { size: 'Standard_D2s_v3' }).pools, [{ size: 'Standard_D2s_v3', os: 'windows', count: 1 }]);
  assert.equal(pricingSpec('azurerm_virtual_machine', { vm_size: 'Standard_D2s_v3' }).pools[0].os, undefined, 'no OS profile: no OS, so no price');
  assert.deepEqual(pricingSpec('azurerm_kubernetes_cluster', { default_node_pool: [{ vm_size: 'Standard_D4s_v5', min_count: 2, node_count: null }] }).pools, [{ size: 'Standard_D4s_v5', os: 'linux', count: 2 }]);
  assert.deepEqual(pricingSpec('Microsoft.ContainerService/managedClusters', { properties: { agentPools: [{ vmSize: 'Standard_D2s_v3', count: 3 }, { vmSize: 'Standard_D2s_v3', count: 1, osType: 'Windows' }] } }).pools.map((p) => [p.os, p.count]), [['linux', 3], ['windows', 1]]);
  assert.equal(pricingSpec('Microsoft.Sql/servers/databases', { sku: { name: 'GP_Gen5', capacity: 2 } }).sku, 'GP_Gen5_2');
  assert.equal(pricingSpec('Microsoft.DBforPostgreSQL/flexibleServers', { sku: { name: 'Standard_D2s_v3', tier: 'GeneralPurpose' } }).sku, 'GP_Standard_D2s_v3');
  assert.deepEqual(pricingSpec('azurerm_redis_cache', { sku_name: 'Premium', family: 'P', capacity: 1, shard_count: 2 }), { kind: 'redis', tier: 'Premium', family: 'P', capacity: 1, shards: 2 });
  assert.equal(pricingSpec('azurerm_storage_account', {}).kind, 'usage');
  assert.equal(pricingSpec('azurerm_key_vault_secret', { value: 'x' }).kind, null);
  assert.equal(pricingSpec('azurerm_service_plan', { sku_name: 'P1v3' }, { sensitive: { sku_name: true } }).sku, undefined);
  assert.equal(pricingSpec('azurerm_service_plan', { sku_name: null }, { unknown: { sku_name: true } }).sku, undefined);
  assert.equal(pricingSpec('azurerm_service_plan', null), null);
  assert.match(pricingPlan({ kind: 'appservice', os: 'linux' }).none, /known only after apply/);
  assert.match(pricingPlan({ kind: null }).none, /doesn't price/);
  assert.ok(pricingPlan({ kind: 'sql', sku: 'GP_S_Gen5_2' }).usage, 'serverless is usage-priced');
});

test("the price list's items: Linux or Windows, never a spot price, one price or none; DTUs by the day, flexible servers by the vCore", () => {
  const vm = pricingPlan({ kind: 'vm', pools: [{ size: 'Standard_D2s_v3', os: 'linux', count: 2 }] }).parts[0];
  assert.deepEqual(vm.query, { serviceName: 'Virtual Machines', armSkuName: 'Standard_D2s_v3' });
  const items = [item('Virtual Machines DSv3 Series', 'D2s v3', 0.1), item('Virtual Machines DSv3 Series', 'D2s v3 Spot', 0.02), item('Virtual Machines DSv3 Series Windows', 'D2s v3', 0.2), item('Virtual Machines DSv3 Series', 'D2s v3', 0.05, { type: 'Reservation' })];
  assert.equal(vm.pick(items).monthly, 73);
  assert.match(vm.pick([item('Virtual Machines DSv3 Series', 'D2s v3', 0.1), item('Virtual Machines DSv3 Series', 'D2s v3', 0.3)]).error, /2 different prices/);
  assert.match(vm.pick([]).error, /no price/);
  const app = pricingPlan({ kind: 'appservice', sku: 'P1v3', os: 'windows', count: 1 }).parts[0];
  assert.equal(app.query.skuName, 'P1 v3');
  assert.equal(app.pick([item('Azure App Service Premium v3 Plan - Linux', 'P1 v3', 0.1), item('Azure App Service Premium v3 Plan', 'P1 v3', 0.2)]).monthly, 146);
  const s1 = pricingPlan({ kind: 'sql', sku: 'S1' }).parts[0];
  assert.equal(s1.query.productName, 'SQL Database Single Standard');
  assert.equal(Math.round(s1.pick([item('SQL Database Single Standard', 'S1', 1.2, { unitOfMeasure: '1/Day' }), item('SQL Database Single Standard', 'S0', 0.5, { unitOfMeasure: '1/Day' })]).monthly * 100) / 100, 36.5);
  assert.deepEqual(pricingPlan({ kind: 'sql', sku: 'GP_Gen5_4' }).parts[0].query, { serviceName: 'SQL Database', productName: 'SQL Database Single/Elastic Pool General Purpose - Compute Gen5', skuName: '4 vCore' });
  const pg = pricingPlan({ kind: 'flex', engine: 'postgresql', sku: 'GP_Standard_D4ds_v4' }).parts[0];
  assert.deepEqual(pg.query, { serviceName: 'Azure Database for PostgreSQL' });
  assert.equal(Math.round(pg.pick([item('Azure Database for PostgreSQL Flexible Server General Purpose Ddsv4 Series Compute', 'vCore', 0.1, { meterName: 'vCore' }), item('Azure Database for PostgreSQL Single Server General Purpose', 'vCore', 9, { meterName: 'vCore' })]).monthly), 292);
  const b = pricingPlan({ kind: 'flex', engine: 'mysql', sku: 'B_Standard_B1ms' }).parts[0];
  assert.equal(b.pick([item('Azure Database for MySQL Flexible Server Burstable BS Series Compute', 'B1MS', 0.02)]).monthly, 14.6);
});

test("a plan's costs: what's resized, destroyed and created priced, in total; the region from the resource, its parent or its resource group", async () => {
  const provider = demoChart();
  const plan = parseTerraformPlan(DEMO_PLAN);
  const costs = await planCosts(plan, { prices: (q) => provider.prices(q) });
  const by = costs.byAddress;
  assert.equal(Math.round(by['azurerm_service_plan.main'].delta * 100) / 100, 233.6);
  assert.match(by['azurerm_service_plan.main'].after.label, /P1v3 × 2 \(Linux\), westeurope, its resource group shop-prod's region/);
  assert.equal(costWords(by['azurerm_mssql_database.reports'], 'USD'), '-$15/month');
  assert.deepEqual([by['azurerm_linux_web_app.admin'].status, by['azurerm_key_vault_secret.db'].status, by['azurerm_application_insights.main'].status], ['included', 'none', 'usage']);
  assert.equal(by['azurerm_linux_web_app.api'], undefined, 'an update that leaves the price alone');
  assert.equal(totalWords(costs), '+$219/month (3 with no price, 2 usage-priced)');
  assert.deepEqual(provider.calls.filter((c) => c[0] === 'prices').map((c) => c[1].serviceName).sort(), ['Azure App Service', 'Azure App Service', 'SQL Database']);
  const whatIf = await planCosts(parseWhatIf(DEMO_WHAT_IF), { prices: (q) => provider.prices(q), currency: 'USD' });
  assert.equal(totalWords(whatIf), '-$99/month (1 usage-priced)');
  const server = { address: 'azurerm_mssql_server.s', id: '/subscriptions/x/resourceGroups/rg/providers/Microsoft.Sql/servers/s', pricing: { before: { kind: null, location: 'North Europe' } } };
  assert.deepEqual(regionOf({ kind: 'sql', parents: [server.id] }, {}, [server]), { region: 'northeurope', from: "azurerm_mssql_server.s's region" });
  assert.equal(regionOf({ kind: 'sql' }, {}, []), null);
  const failing = await planCosts(plan, { prices: async () => Promise.reject(new Error('offline')) });
  assert.equal(failing.failed, 2);
  assert.match(failing.byAddress['azurerm_service_plan.main'].note, /couldn't be asked: offline/);
});

test('amounts as they read', () => {
  assert.equal(money(340.2, 'EUR', { signed: true }), '+€340');
  assert.equal(money(-14.72, 'USD', { signed: true }), '-$15');
  assert.equal(money(4.5, 'GBP'), '£4.50');
  assert.equal(money(1204, 'SEK'), '1,204 SEK');
  assert.equal(money(0.001, 'USD', { signed: true }), '±$0.00');
});

test('the price list asked through the provider: every page, the filter quoted, kept for the session, a failure not kept', async () => {
  const asked = [];
  const pages = [{ Items: [{ retailPrice: 1 }], NextPageLink: 'https://prices.azure.com/api/retail/prices?page=2' }, { Items: [{ retailPrice: 2 }], NextPageLink: null }];
  const fetch = async (url) => {
    asked.push(url);
    return { ok: true, json: async () => pages[asked.length - 1] };
  };
  const chart = createChart({ fetch });
  const items = await chart.prices({ serviceName: 'Virtual Machines', armRegionName: 'westeurope', armSkuName: "Standard_D2s_v3'" }, { currency: 'EUR' });
  assert.deepEqual(items.map((i) => i.retailPrice), [1, 2]);
  assert.match(asked[0], /^https:\/\/prices\.azure\.com\/api\/retail\/prices\?currencyCode='EUR'&\$filter=/);
  assert.equal(decodeURIComponent(asked[0].split('$filter=')[1]), "serviceName eq 'Virtual Machines' and armRegionName eq 'westeurope' and armSkuName eq 'Standard_D2s_v3''' and priceType eq 'Consumption'");
  assert.equal(asked[1], 'https://prices.azure.com/api/retail/prices?page=2');
  await chart.prices({ serviceName: 'Virtual Machines', armRegionName: 'westeurope', armSkuName: "Standard_D2s_v3'" }, { currency: 'EUR' });
  assert.equal(asked.length, 2, 'asked once a session');
  await assert.rejects(chart.prices({ serviceName: 'x' }, { currency: 'eu' }), /isn't a currency code/);
  let n = 0;
  const flaky = createChart({ fetch: async () => (n++ ? { ok: true, json: async () => ({ Items: [{ retailPrice: 3 }] }) } : { ok: false, status: 503, statusText: 'Service Unavailable' }) });
  await assert.rejects(flaky.prices({ serviceName: 'x' }), /answered 503 Service Unavailable/);
  assert.deepEqual(await flaky.prices({ serviceName: 'x' }), [{ retailPrice: 3 }]);
  const offline = createChart({ fetch: async () => Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })) });
  await assert.rejects(offline.prices({ serviceName: 'x' }), /Couldn't reach prices\.azure\.com: ENOTFOUND/);
  assert.equal(priceFilter({ serviceName: 'Redis Cache', skuName: undefined }), "serviceName eq 'Redis Cache' and priceType eq 'Consumption'");
});

test("chart check and the report: each change's cost and the total; --currency, --no-costs", async () => {
  const out = [];
  const write = (s) => out.push(s);
  await runHeadless(['check'], { provider: demoChart(), write });
  const text = out.join('');
  assert.match(text, /- azurerm_mssql_database\.reports {2}\(it is no longer in the configuration\) {2}-\$15\/month/);
  assert.match(text, /~ azurerm_service_plan\.main {2}\+\$234\/month/);
  assert.match(text, /Cost: \+\$219\/month \(3 with no price, 2 usage-priced\), from Azure's retail prices in USD/);
  out.length = 0;
  await runHeadless(['check', '--currency', 'eur', '--json'], { provider: demoChart(), write });
  const json = JSON.parse(out.join(''));
  assert.equal(json.cost.currency, 'EUR');
  assert.equal(Math.round(json.cost.total), 201);
  out.length = 0;
  const provider = demoChart();
  await runHeadless(['check', '--no-costs'], { provider, write });
  assert.ok(!out.join('').includes('/month'));
  assert.ok(!provider.calls.some((c) => c[0] === 'prices'));
  assert.equal(await runHeadless(['check', '--currency', 'XYZ'], { provider: demoChart(), write }), 2);
  const plan = parseTerraformPlan(DEMO_PLAN);
  const costs = await planCosts(plan, { prices: (q) => demoChart().prices(q) });
  const md = markdownReport(plan, { label: 'infra', costs });
  assert.match(md, /\*\*Monthly cost: \+\$219\/month \(3 with no price, 2 usage-priced\)\*\*, from Azure's retail prices in USD/);
  assert.match(md, /\| `-` \| `azurerm_mssql_database\.reports` \| destroy \| it is no longer in the configuration \| -\$15 \|/);
});

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);
const run = async (app, line) => {
  await type(app.stdin, line);
  app.stdin.write(KEYS.enter);
};

test('the plan view: a cost per change and the total; ↵ says what it is of; /currency prices it again', async () => {
  const app = start();
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/plan');
  await until(shows(app, 'cost +$219/month'), 'the total');
  assert.match(app.lastFrame(), /- azurerm_mssql_database\.reports +destroy +5 attributes +-\$15\/month/);
  assert.match(app.lastFrame(), /\+ azurerm_key_vault_secret\.db +create +\d attributes +no price/);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Cost: -$15/month'), 'the detail');
  assert.match(app.lastFrame(), /was \$15\/month: S0 \(compute\), westeurope/);
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Declared in'), 'the detail closed');
  await run(app, '/currency EUR');
  await until(shows(app, 'cost +€201/month'), 'the total in euros');
  assert.ok(app.provider.calls.some((c) => c[0] === 'prices' && c[2] === 'EUR'));
  app.unmount();
});
