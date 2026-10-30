// Plans, states and what-ifs in one shape, and their attributes' differences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionOf, ordered, parseAny, parseResourceId, parseTerraformPlan, parseTerraformState, parseWhatIf, summarize, summaryLine } from '../src/plan.js';
import { SENSITIVE, UNKNOWN, attributeDiff, diffLines, marked, pathText, valueLines } from '../src/diff.js';
import { DEMO_PLAN, DEMO_STATE, DEMO_WHAT_IF } from '../src/demo.js';
import { findChange, siteOf, stateRows } from '../src/rows.js';

test("Terraform's actions as one word, a delete and a create being a replacement", () => {
  assert.equal(actionOf(['delete', 'create']), 'replace');
  assert.equal(actionOf(['create', 'delete']), 'replace');
  assert.equal(actionOf(['no-op']), 'noop');
  assert.equal(actionOf(['update']), 'update');
  assert.equal(actionOf(['forget']), 'forget');
});

test('a Terraform plan: its changes with why, the drift, the outputs that change; the data sources only read left out', () => {
  const plan = parseTerraformPlan({ ...DEMO_PLAN, resource_changes: [...DEMO_PLAN.resource_changes, { address: 'data.azurerm_client_config.me', mode: 'data', type: 'azurerm_client_config', name: 'me', change: { actions: ['read'] } }] });
  assert.equal(plan.tool, 'terraform');
  assert.equal(plan.version, '1.9.8');
  assert.equal(plan.changes.length, 8);
  assert.equal(summaryLine(summarize(plan.changes)), '+2 ~2 ±1 -1');
  assert.deepEqual(ordered(plan.changes).slice(0, 2).map((c) => [c.action, c.address]), [['delete', 'azurerm_mssql_database.reports'], ['replace', 'azurerm_linux_web_app.admin']]);
  const admin = plan.changes.find((c) => c.address === 'azurerm_linux_web_app.admin');
  assert.equal(admin.reason, 'an argument that forces replacement changed');
  assert.deepEqual(admin.diff.find((d) => d.path === 'name'), { path: 'name', kind: 'change', before: 'shop-admin', after: 'shop-admin-v2', forces: true });
  assert.equal(admin.resourceGroup, 'shop-prod');
  assert.equal(admin.provider, 'hashicorp/azurerm');
  assert.deepEqual(plan.drift[0].diff.map((d) => d.path), ['app_settings.LOG_LEVEL', 'tags.owner']);
  assert.deepEqual(plan.outputs.map((o) => [o.name, o.action]), [['insights_connection', 'create']]);
  assert.throws(() => parseTerraformPlan({ hello: 1 }), /isn't a Terraform plan/);
});

test("an attribute diff: leaves compared, sensitive values never shown, what's known after apply and what forces replacement marked", () => {
  const diff = attributeDiff(
    { name: 'a', tags: { env: 'dev' }, list: [1, 2], secret: 'x', gone: 'y', same: { a: 1 }, nothing: null },
    { name: 'b', tags: { env: 'dev', team: 'shop' }, list: [1, 3], secret: 'z', same: { a: 1 }, nothing: null, id: null },
    { unknown: { id: true }, beforeSensitive: { secret: true }, afterSensitive: { secret: true }, forces: [['name']] },
  );
  assert.deepEqual(diff, [
    { path: 'gone', kind: 'remove', before: 'y' },
    { path: 'id', kind: 'unknown', after: UNKNOWN },
    { path: 'list[1]', kind: 'change', before: 2, after: 3 },
    { path: 'name', kind: 'change', before: 'a', after: 'b', forces: true },
    { path: 'secret', kind: 'change', before: SENSITIVE, after: SENSITIVE, sensitive: true },
    { path: 'tags.team', kind: 'add', after: 'shop' },
  ]);
  assert.deepEqual(diffLines(diff), ['- gone (was "y")', `~ id: ${UNKNOWN}`, '~ list[1]: 2 → 3', '~ name: "a" → "b"  # forces replacement', `~ secret: ${SENSITIVE} → ${SENSITIVE}`, '+ tags.team = "shop"']);
  assert.equal(pathText(['tags', 'odd.key', 0]), 'tags["odd.key"][0]');
  assert.equal(marked({ a: [{ b: true }] }, ['a', 0, 'b', 'c']), true);
  assert.equal(marked({ a: true }, ['b']), false);
  assert.deepEqual(valueLines({ name: 'x', pw: 'hunter2' }, { pw: true }), ['name = "x"', `pw = ${SENSITIVE}`]);
});

test('no secret of the demo plan reaches its diff', () => {
  const text = JSON.stringify(parseTerraformPlan(DEMO_PLAN));
  assert.ok(!text.includes('hunter2'));
  assert.ok(!text.includes('correct horse'));
});

test("a Terraform state: every resource, modules' too", () => {
  const { resources } = parseTerraformState(DEMO_STATE);
  assert.deepEqual(resources.map((r) => [r.address, r.module ?? '']), [['azurerm_resource_group.main', ''], ['azurerm_linux_web_app.api', ''], ['random_password.db', ''], ['module.network.azurerm_virtual_network.main', 'module.network']]);
  assert.deepEqual(stateRows(resources).map((r) => r.heading ?? r.resource.address), ['root module', 'azurerm_linux_web_app.api', 'azurerm_resource_group.main', 'random_password.db', 'module.network', 'module.network.azurerm_virtual_network.main']);
});

test("Azure's what-if: changes by resource id, a property's children flattened, NoEffect marked as noise", () => {
  const plan = parseWhatIf(DEMO_WHAT_IF);
  assert.equal(plan.tool, 'bicep');
  assert.deepEqual(plan.changes.map((c) => [c.action, c.address]), [
    ['update', 'Microsoft.Web/sites/shop-api'],
    ['create', 'Microsoft.Storage/storageAccounts/shopfiles'],
    ['noop', 'Microsoft.Insights/components/shop-insights'],
    ['delete', 'Microsoft.Cache/Redis/shop-cache'],
  ]);
  assert.deepEqual(plan.changes[0].diff, [
    { path: 'properties.siteConfig.alwaysOn', kind: 'change', before: false, after: true },
    { path: 'properties.httpsOnly', kind: 'change', before: true, after: true, noise: true },
  ]);
  assert.deepEqual(plan.changes[1].diff.map((d) => d.path), ['kind', 'name', 'sku.name']);
  assert.deepEqual(parseResourceId('/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Web/sites/app/slots/staging'), { type: 'Microsoft.Web/sites/slots', name: 'app/staging', resourceGroup: 'rg', subscription: 's1' });
  assert.throws(() => parseWhatIf({ status: 'Failed', error: { code: 'InvalidTemplate', message: 'bad template' } }), /What-if failed: bad template/);
  assert.equal(parseAny(JSON.stringify({ properties: DEMO_WHAT_IF })).tool, 'bicep');
  assert.equal(parseAny(JSON.stringify(DEMO_STATE)).kind, 'state');
  assert.equal(parseAny(JSON.stringify(DEMO_PLAN)).kind, 'plan');
  assert.throws(() => parseAny('{"a":1}'), /neither a Terraform plan/);
});

test("an App Service app as Locker's site, a change found by the end of its address", () => {
  const plan = parseTerraformPlan(DEMO_PLAN);
  assert.deepEqual(siteOf(plan.changes.find((c) => c.address === 'azurerm_linux_web_app.admin')), { name: 'shop-admin-v2', resourceGroup: 'shop-prod', id: '/subscriptions/0000/resourceGroups/shop-prod/providers/Microsoft.Web/sites/shop-admin' });
  assert.equal(siteOf(plan.changes.find((c) => c.address === 'azurerm_service_plan.main')), null);
  const slot = parseWhatIf({ changes: [{ resourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/app/slots/staging', changeType: 'Modify', delta: [] }] }).changes[0];
  assert.deepEqual(siteOf(slot), { name: 'app', slot: 'staging', resourceGroup: 'rg', subscription: 's', id: slot.id });
  assert.equal(findChange(plan.changes, 'reports').address, 'azurerm_mssql_database.reports');
  assert.equal(findChange(plan.changes, 'azurerm_linux_web_app'), null);
});
