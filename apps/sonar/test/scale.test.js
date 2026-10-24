// Scaling a plan: /scale's words, the SKUs, autoscale in a line, and /scale driven through the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { autoscaleFor, autoscaleSummary, consumption, parseScale, planLine, scaledSku, skuName, skuTier } from '../src/scale.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('scale: instances or a tier, an app named first; SKUs and their tiers; autoscale in words', () => {
  const names = ['contoso-web', 'contoso-web/staging'];
  assert.deepEqual(parseScale('3', names), { app: null, instances: 3 });
  assert.deepEqual(parseScale('contoso-web p2v3', names), { app: 'contoso-web', sku: 'P2v3' });
  assert.deepEqual(parseScale('contoso-web 4', names), { app: 'contoso-web', instances: 4 });
  assert.match(parseScale('contoso-web', names).error, /Say how to scale contoso-web/);
  assert.match(parseScale('nope 3', names).error, /no app called nope/);
  assert.match(parseScale('X9', names).error, /isn't an App Service tier/);
  assert.match(parseScale('0', names).error, /Between 1 and 100/);
  assert.match(parseScale('', names).error, /Say how/);
  assert.equal(skuTier('P1mv3'), 'PremiumMV3');
  assert.equal(skuTier('ep2'), 'ElasticPremium');
  assert.equal(skuName('p1mv3'), 'P1mv3');
  const plan = { name: 'p', sku: { name: 'P1v3', tier: 'PremiumV3', capacity: 2 } };
  assert.deepEqual(scaledSku(plan, { instances: 5 }), { name: 'P1v3', tier: 'PremiumV3', capacity: 5 });
  assert.deepEqual(scaledSku(plan, { sku: 'S1' }), { name: 'S1', tier: 'Standard', capacity: 2 });
  assert.equal(planLine(plan), 'P1v3 PremiumV3 · 2 instances');
  assert.ok(consumption({ sku: { tier: 'Dynamic' } }));
  const auto = [{ name: 'a', enabled: true, target: '/X/plan', profiles: [{ min: 2, max: 5, rules: [{ metric: 'Cpu', operator: 'GreaterThan', threshold: 70, direction: 'Increase', change: 1 }, { metric: 'Cpu', operator: 'LessThan', threshold: 30, direction: 'Decrease', change: 1 }] }] }];
  assert.equal(autoscaleFor(auto, '/x/PLAN').length, 1);
  assert.equal(autoscaleSummary(auto), 'on: 2–5 instances, Cpu > 70 → +1, Cpu < 30 → -1');
  assert.equal(autoscaleSummary([{ ...auto[0], enabled: false }]), 'off (a)');
  assert.equal(autoscaleSummary([]), null);
});

test('the plan in the details, and /scale: says who shares it and that autoscale is on, asks for the name, scales it', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  const plan = () => app.provider.state.plans.find((p) => p.name === 'contoso-prod-plan');
  try {
    await until(() => frame().includes('P1v3 PremiumV3 · 2 instances'), 'the plan in the details');
    assert.match(frame(), /autoscale on: 2–5 instances, CpuPercentage > 70 → \+1/);
    assert.match(frame(), /shared\s+with contoso-api, contoso-orders/);
    app.stdin.write('/');
    await type(app.stdin, 'scale 3');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Scale contoso-prod-plan from P1v3 × 2 to 3 instances?'), 'the question');
    assert.match(frame(), /It also runs contoso-api, contoso-orders/);
    assert.match(frame(), /Autoscale is on/);
    await type(app.stdin, 'contoso-web');
    app.stdin.write(KEYS.enter);
    await until(() => plan().sku.capacity === 3, 'the plan scaled');
    await until(() => frame().includes('P1v3 PremiumV3 · 3 instances'), 'the details read again');
    app.stdin.write('/');
    await type(app.stdin, 'scale contoso-web S9');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("S9 isn't an App Service tier"), 'a tier that is not one');
  } finally {
    app.unmount();
  }
});
