// What depends on what: from the plan's configuration, terraform graph's DOT and a what-if's ids; the
// tree the view draws; what destroying or replacing something affects, in the view, the detail and /apply.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { affectedBy, affectsLine, configAddress, dependencyRows, dependentsOf, idDependencies, parseDot, planDependencies } from '../src/graph.js';
import { actionRank, parseTerraformPlan, parseWhatIf } from '../src/plan.js';
import { DEMO_GRAPH, DEMO_PLAN, DEMO_WHAT_IF } from '../src/demo.js';
import { createChart } from '../src/iac.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

test("the plan's configuration: references and depends_on, modules' too, instances by their configuration's address", () => {
  const plan = parseTerraformPlan(DEMO_PLAN);
  assert.deepEqual(plan.dependsOn['azurerm_linux_web_app.api'], ['azurerm_application_insights.main', 'azurerm_linux_web_app.admin', 'azurerm_service_plan.main']);
  assert.deepEqual(plan.dependsOn['azurerm_mssql_database.reports'], [], 'no longer in the configuration, so nothing');
  assert.deepEqual(plan.dependsOn['azurerm_service_plan.main'], ['azurerm_resource_group.main'], 'a variable is no resource');
  assert.equal(configAddress('module.a[0].azurerm_x.y["k"]'), 'module.a.azurerm_x.y');
  const configuration = {
    root_module: {
      resources: [
        { address: 'azurerm_subnet.s', expressions: { virtual_network_name: { references: ['module.net.name'] } } },
        { address: 'azurerm_network_interface.nic', count_expression: { references: ['var.n'] }, expressions: { ip_configuration: [{ subnet_id: { references: ['azurerm_subnet.s.id', 'azurerm_subnet.s'] } }] }, depends_on: ['data.azurerm_client_config.me'] },
        { address: 'data.azurerm_client_config.me', mode: 'data' },
      ],
      module_calls: { net: { expressions: { rg: { references: ['azurerm_resource_group.rg.name'] } }, module: { resources: [{ address: 'azurerm_virtual_network.v', expressions: {} }] } } },
    },
  };
  const deps = planDependencies(configuration, ['azurerm_subnet.s', 'azurerm_network_interface.nic[0]', 'azurerm_network_interface.nic[1]', 'module.net.azurerm_virtual_network.v', 'azurerm_resource_group.rg', 'data.azurerm_client_config.me']);
  assert.deepEqual(deps['azurerm_subnet.s'], ['module.net.azurerm_virtual_network.v']);
  assert.deepEqual(deps['azurerm_network_interface.nic[1]'], ['azurerm_subnet.s', 'data.azurerm_client_config.me']);
  assert.deepEqual(deps['module.net.azurerm_virtual_network.v'], ['azurerm_resource_group.rg'], "what a module is given, its resources depend on");
  assert.equal(planDependencies(undefined, ['a.b']), null, 'no configuration, no answer');
});

test("terraform graph's DOT, old and new; a what-if's children under their parents", () => {
  const addresses = ['azurerm_resource_group.main', 'azurerm_service_plan.main', 'azurerm_linux_web_app.admin', 'azurerm_linux_web_app.api'];
  assert.deepEqual(parseDot(DEMO_GRAPH, addresses)['azurerm_linux_web_app.api'], ['azurerm_linux_web_app.admin', 'azurerm_service_plan.main']);
  const old = 'digraph {\n  "[root] azurerm_service_plan.main (expand)" -> "[root] azurerm_resource_group.main (expand)"\n  "[root] azurerm_service_plan.main (expand)" -> "[root] provider[\\"registry.terraform.io/hashicorp/azurerm\\"]"\n  "[root] azurerm_service_plan.main (expand)" -> "[root] var.sku"\n}';
  assert.deepEqual(parseDot(old, addresses)['azurerm_service_plan.main'], ['azurerm_resource_group.main']);
  const ids = idDependencies(parseWhatIf({ changes: [{ resourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/app', changeType: 'Modify' }, { resourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/app/slots/staging', changeType: 'Delete' }] }).changes);
  assert.deepEqual(ids['Microsoft.Web/sites/slots/app/staging'], ['Microsoft.Web/sites/app']);
  assert.deepEqual(parseWhatIf(DEMO_WHAT_IF).dependsOn['Microsoft.Cache/Redis/shop-cache'], []);
});

test('the tree: what nothing depends on at the top, what depends on each under it, once in full; what a replacement affects', () => {
  const plan = parseTerraformPlan(DEMO_PLAN);
  const rows = dependencyRows(plan.changes, plan.dependsOn, { rank: actionRank });
  const text = rows.map((r) => `${'  '.repeat(r.depth)}${r.change.address}${r.repeat ? ' (above)' : ''}`);
  assert.deepEqual(text.slice(0, 3), ['azurerm_mssql_database.reports', 'azurerm_resource_group.main', '  azurerm_service_plan.main']);
  assert.ok(text.includes('    azurerm_linux_web_app.admin'));
  assert.ok(text.includes('      azurerm_linux_web_app.api'));
  assert.equal(rows.filter((r) => r.change.address === 'azurerm_linux_web_app.api' && !r.repeat).length, 1, 'in full once');
  assert.ok(rows.some((r) => r.change.address === 'azurerm_linux_web_app.api' && r.repeat));
  assert.equal(new Set(rows.map((r) => r.change.address)).size, plan.changes.length, 'every resource is in it');
  assert.deepEqual(dependentsOf(plan.dependsOn, 'azurerm_key_vault_secret.db'), ['azurerm_linux_web_app.admin', 'azurerm_linux_web_app.api']);
  assert.equal(affectsLine(plan.changes.find((c) => c.address === 'azurerm_linux_web_app.admin'), plan.dependsOn), 'Replacing azurerm_linux_web_app.admin affects azurerm_linux_web_app.api');
  assert.equal(affectsLine(plan.changes.find((c) => c.address === 'azurerm_mssql_database.reports'), plan.dependsOn), null);
  assert.deepEqual(affectedBy(plan.changes, plan.dependsOn), { 'azurerm_linux_web_app.api': ['azurerm_linux_web_app.admin'] });
  // A cycle still shows each of them.
  const cyclic = dependencyRows([{ address: 'a.a', action: 'update' }, { address: 'b.b', action: 'update' }], { 'a.a': ['b.b'], 'b.b': ['a.a'] });
  assert.deepEqual(cyclic.map((r) => r.change.address).sort(), ['a.a', 'b.b']);
});

test("the provider's terraform graph runs in the environment's workspace", async () => {
  const calls = [];
  const chart = createChart({ run: async (command, opts) => (calls.push({ command, env: opts.env }), { stdout: DEMO_GRAPH, stderr: '' }) });
  assert.equal(await chart.graph('/srv', { workspace: 'prod' }), DEMO_GRAPH);
  assert.deepEqual(calls[0], { command: 'terraform graph', env: { TF_WORKSPACE: 'prod' } });
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

test('g on a change opens what depends on what on it; the replacement and what it affects are marked, in the detail and before /apply too', async () => {
  const app = start();
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/plan');
  await until(shows(app, 'azurerm_mssql_database.reports'), 'the changes');
  app.stdin.write('j');
  await until(() => /❯ ± azurerm_linux_web_app\.admin/.test(app.lastFrame()), 'the cursor on the replacement');
  app.stdin.write('g');
  await until(shows(app, '─ Depends '), 'the dependency view');
  const frame = app.lastFrame();
  assert.match(frame, /2 destroyed or replaced · 1 affected/);
  assert.match(frame, /❯ +└ ± azurerm_linux_web_app\.admin +replace: affects 1/);
  assert.match(frame, /└ ~ azurerm_linux_web_app\.api +← replacing azurerm_linux_web_app\.admin/);
  assert.match(frame, /5 Depends/);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Replacing azurerm_linux_web_app.admin affects azurerm_linux_web_app.api'), 'the detail');
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Declared in'), 'the detail closed');
  app.stdin.write('1');
  await until(shows(app, '─ Changes '), 'back in Changes');
  await run(app, '/show api');
  await until(shows(app, 'Depends on azurerm_linux_web_app.admin, which is destroyed or replaced'), "the dependent's detail");
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Depends on azurerm'), 'the detail closed');
  await run(app, '/apply');
  await until(shows(app, 'Type default to apply'), 'the question');
  assert.match(app.lastFrame(), /± azurerm_linux_web_app\.admin {2}\(an argument that forces replacement changed\)[^\n]*\n[^\n]*affects azurerm_linux_web_app\.api/);
  app.stdin.write(KEYS.esc);
  app.unmount();
});

test('/graph asks terraform graph for a plan without its configuration', async () => {
  const provider = (await import('../src/demo.js')).demoChart();
  const bare = { ...DEMO_PLAN };
  delete bare.configuration;
  provider.readFile = async () => ({ kind: 'plan', ...parseTerraformPlan(bare) });
  const app = start({ provider });
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/open plan.json');
  await until(shows(app, 'azurerm_mssql_database.reports'), 'the plan read');
  app.stdin.write('5');
  await until(shows(app, '/graph asks terraform graph'), 'the hint to ask');
  await run(app, '/graph');
  await until(shows(app, '← replacing azurerm_linux_web_app.admin'), 'the graph');
  assert.ok(provider.calls.some((c) => c[0] === 'graph'));
  app.unmount();
});
