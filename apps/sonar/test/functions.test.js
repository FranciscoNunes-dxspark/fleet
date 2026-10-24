// A function app's functions: the pure rules, the demo's runs, and the list driven through the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { demoAzure, demoQuery } from '../src/demo.js';
import { functionFrom, functionLogQuery, functionRunsQuery, functionUrl, invocation, isDisabled, prettyBody, triggerLabel, withDisabled } from '../src/functions.js';
import { records } from '../src/insights.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('functions: triggers in words, turned off by their setting (either spelling) or function.json, what invoking sends', () => {
  const http = functionFrom({ id: 'x/functions/Get', properties: { name: 'Get', config: { bindings: [{ type: 'httpTrigger', methods: ['get', 'post'], route: 'items/{id}' }] } } });
  const timer = functionFrom({ name: 'app/Tick', properties: { isDisabled: true, config: { bindings: [{ type: 'timerTrigger', schedule: '0 */5 * * * *' }] } } });
  assert.equal(triggerLabel(http), 'http GET,POST');
  assert.equal(triggerLabel(timer), 'timer 0 */5 * * * *');
  assert.equal(triggerLabel(functionFrom({ properties: { name: 'Q', config: { bindings: [{ type: 'serviceBusTrigger', queueName: 'payments' }] } } })), 'serviceBus payments');
  assert.equal(functionUrl(http, 'a.azurewebsites.net'), 'https://a.azurewebsites.net/api/items/{id}');

  assert.equal(isDisabled(http, {}), false);
  assert.equal(isDisabled(http, { 'AzureWebJobs.Get.Disabled': 'true' }), true);
  assert.equal(isDisabled(http, { AzureWebJobs__Get__Disabled: '1' }), true);
  assert.equal(isDisabled(timer, {}), true, 'function.json says so');
  assert.equal(isDisabled(timer, { 'AzureWebJobs.Tick.Disabled': 'false' }), false, 'the setting wins');
  assert.deepEqual(withDisabled({ A: '1' }, http, true), { A: '1', 'AzureWebJobs.Get.Disabled': 'true' });
  assert.deepEqual(withDisabled({ A: '1', AzureWebJobs__Get__Disabled: 'true' }, http, false), { A: '1' });
  assert.deepEqual(withDisabled({ AzureWebJobs__Get__Disabled: 'false' }, http, true), { AzureWebJobs__Get__Disabled: 'true' });
  assert.deepEqual(withDisabled({}, timer, false), { 'AzureWebJobs.Tick.Disabled': 'false' });

  assert.deepEqual(invocation(http, ''), { method: 'GET', body: undefined });
  assert.deepEqual(invocation(http, '{"a":1}'), { method: 'POST', body: '{"a":1}' });
  assert.deepEqual(invocation(timer, 'go'), { admin: true, method: 'POST', body: '{"input":"go"}' });
  assert.equal(prettyBody('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyBody('plain'), 'plain');
});

test('the demo: each function\'s runs and failures by name, and one function\'s runs', async () => {
  const demo = demoAzure();
  const component = { appId: 'app-prod', name: 'contoso-prod-ai' };
  const runs = records(await demo.query(component, functionRunsQuery('contoso-orders'), { timespan: 'P7D' }));
  const mine = runs.filter((r) => !r.name.startsWith('GET '));
  assert.deepEqual(mine.map((r) => r.name), ['NightlyCleanup', 'PlaceOrder', 'ProcessPayment']);
  assert.ok(mine.every((r) => r.runs > 0 && r.last));
  assert.ok(runs.find((r) => r.name === 'ProcessPayment').failed > 0);
  const one = records(await demo.query(component, functionLogQuery('contoso-orders', 'PlaceOrder'), { timespan: 'P7D' }));
  assert.ok(one.length > 0 && one.every((r) => r.name === 'PlaceOrder'));
  assert.equal(demoQuery("requests | where name == 'Nope' | take 5", []).rows.length, 0);
});

test('f on a function app: its functions with their runs; d turns one off through its setting, i invokes one, ↵ shows its runs in Logs', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  const settings = () => app.provider.state.sites.find((s) => s.name === 'contoso-orders' && !s.slot).settings;
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('/');
    await type(app.stdin, 'find contoso-orders');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('contoso-orders  function app'), 'the function app selected');
    app.stdin.write('f');
    await until(() => frame().includes('Functions of contoso-orders') && frame().includes('ProcessPayment'), 'its functions');
    assert.match(frame(), /PlaceOrder\s+on\s+http POST\s+\d+ runs,/);
    assert.match(frame(), /ProcessPayment\s+on\s+serviceBus payments/);

    // Turning NightlyCleanup off: production, so its name is typed.
    app.stdin.write('d');
    await until(() => frame().includes('Turn NightlyCleanup off in contoso-orders?'), 'the question');
    await type(app.stdin, 'contoso-orders');
    app.stdin.write(KEYS.enter);
    await until(() => settings()['AzureWebJobs.NightlyCleanup.Disabled'] === 'true', 'the setting saved');
    await until(() => /NightlyCleanup\s+off/.test(frame()), 'it shown off');

    // Invoking PlaceOrder with a body.
    app.stdin.write('j');
    await until(() => /❯ \S+ PlaceOrder/.test(frame()), "the cursor on PlaceOrder");
    app.stdin.write('i');
    await until(() => frame().includes('PlaceOrder: a body to send'), 'the body asked for');
    await type(app.stdin, '{"sku":"A1"}');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Invoke PlaceOrder in contoso-orders (POST)?'), 'the question');
    await type(app.stdin, 'contoso-orders');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('PlaceOrder: 201') && frame().includes('"orderId": "o-10234"'), 'its answer');
    assert.deepEqual(app.provider.state.invocations, [{ target: 'contoso-orders', name: 'PlaceOrder', input: '{"sku":"A1"}' }]);
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Functions of contoso-orders'), 'back to the functions');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("where name == 'PlaceOrder'") && /\d+ rows/.test(frame()), 'its runs in Logs');
  } finally {
    app.unmount();
  }
});
