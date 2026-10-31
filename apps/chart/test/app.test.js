// End to end: App over the demo infrastructure, typing keys and reading the frame.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, start, tempHome, type, until } from './helpers.js';
import { loadConfig } from '../src/config.js';

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

test('it looks at the folder on opening and plans only when asked', async () => {
  const app = start();
  await until(shows(app, '/plan asks terraform'), 'the hint');
  assert.match(app.lastFrame(), /2 Terraform folders \(\/plan\), 1 Bicep or ARM file \(\/whatif\)/);
  assert.deepEqual(app.provider.calls.map((c) => c[0]), ['detect']);
  app.unmount();
});

test('/plan lists the changes, what is destroyed first, with the summary and drift in the header', async () => {
  const app = start();
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/plan');
  await until(shows(app, 'azurerm_mssql_database.reports'), 'the changes');
  const frame = app.lastFrame();
  assert.match(frame, /infra {2}-1 {2}±1 {2}~2 {2}\+2 {2}1 drifted/);
  assert.ok(frame.indexOf('azurerm_mssql_database.reports') < frame.indexOf('azurerm_linux_web_app.admin'));
  assert.ok(frame.indexOf('azurerm_linux_web_app.admin') < frame.indexOf('azurerm_service_plan.main'));
  assert.match(frame, /± azurerm_linux_web_app\.admin +replace +2 attributes +app +an argument that forces/);
  assert.ok(!frame.includes('random_password.db'), 'what does not change is hidden');
  assert.match(frame, /2 unchanged \(a\)/);
  assert.match(frame, /1 Changes 6 {3}2 Drift 1/);
  assert.deepEqual(app.provider.calls[1], ['plan', app.provider.calls[0][1], 'terraform', false]);
  app.stdin.write('a');
  await until(shows(app, 'random_password.db'), 'the unchanged ones');
  app.unmount();
});

test('↵ shows a change attribute by attribute, sensitive values masked, where it is declared', async () => {
  const app = start();
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/plan');
  await until(shows(app, 'azurerm_mssql_database.reports'), 'the changes');
  app.stdin.write('j');
  await until(() => /❯ ± azurerm_linux_web_app\.admin/.test(app.lastFrame()), 'the cursor on the replacement');
  app.stdin.write(KEYS.enter);
  await until(shows(app, '# forces replacement'), 'the change');
  const frame = app.lastFrame();
  assert.match(frame, /~ name: "shop-admin" → "shop-admin-v2" {2}# forces replacement/);
  assert.match(frame, /Declared in app\.tf:40/);
  assert.ok(!frame.includes('hunter2'));
  app.unmount();
});

test('the Drift view: what changed in the portal; /drift runs a refresh-only plan', async () => {
  const app = start();
  await until(shows(app, '/plan asks terraform'), 'the hint');
  app.stdin.write('2');
  await until(shows(app, '/drift looks for what changed'), 'the empty drift');
  await run(app, '/drift');
  await until(shows(app, 'azurerm_linux_web_app.api'), 'the drift');
  assert.match(app.lastFrame(), /~ azurerm_linux_web_app\.api +drifted +2 attributes/);
  assert.equal(app.provider.calls.at(-1)[3], true);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'tags.owner'), 'what drifted');
  assert.match(app.lastFrame(), /changed outside the code/);
  app.unmount();
});

test('/whatif asks Azure for a Bicep file, keeps its arguments, and lists its changes', async () => {
  const app = start();
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/whatif --rg shop-prod');
  await until(shows(app, 'Microsoft.Cache/Redis/shop-cache'), 'the what-if');
  const call = app.provider.calls.find((c) => c[0] === 'whatIf')[2];
  assert.deepEqual([call.file, call.resourceGroup, call.params], ['bicep/main.bicep', 'shop-prod', 'bicep/main.prod.bicepparam']);
  assert.deepEqual(loadConfig().whatIf, { file: 'bicep/main.bicep', resourceGroup: 'shop-prod', params: 'bicep/main.prod.bicepparam' });
  assert.match(app.lastFrame(), /bicep\/main\.bicep into shop-prod {2}-1 {2}~1 {2}\+1/);
  app.unmount();
});

test('/state lists the resources by module; ↵ shows the values, a sensitive one masked', async () => {
  const app = start();
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/state');
  await until(shows(app, 'module.network'), 'the state');
  assert.match(app.lastFrame(), /root module {2}3/);
  app.stdin.write('j');
  app.stdin.write('j');
  await until(() => /❯ random_password\.db/.test(app.lastFrame()), 'the cursor on the password');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'result = (sensitive)'), 'its values');
  app.unmount();
});

test('/report shows the plan as Markdown', async () => {
  const app = start();
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/plan');
  await until(shows(app, 'azurerm_mssql_database.reports'), 'the changes');
  await run(app, '/report');
  await until(shows(app, '# Terraform plan: infra'), 'the report');
  app.unmount();
});
