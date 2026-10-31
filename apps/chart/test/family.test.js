// Chart in the family (family.js): its names, what it hands Splice and Locker, its mood and the activity it adds.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { APP_NAMES, FAMILY, PET_NAMES, ROLES, contextIn, readActivity } from '@fleet/kit/family.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';
import { familyMood, reactionTo } from '../src/moods.js';
import { parseTerraformPlan } from '../src/plan.js';
import { DEMO_PLAN } from '../src/demo.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);

test('Chart is in the family, with its names', () => {
  assert.ok(FAMILY.includes('chart'));
  assert.deepEqual([APP_NAMES.chart, PET_NAMES.chart, ROLES.chart], ['Chart', 'Plot', 'IAC']);
});

test("Plot's mood: a plan that destroys, or drift, worries it; a plan with nothing to do makes it happy", () => {
  const plan = parseTerraformPlan(DEMO_PLAN);
  assert.deepEqual(familyMood({ mood: 'worried', data: { plan } }), { mood: 'worried', reason: 'the plan destroys 2 (+2 ~2 ±1 -1)' });
  assert.deepEqual(familyMood({ mood: 'worried', data: { plan: { ...plan, changes: [] } } }), { mood: 'worried', reason: '1 changed outside Terraform' });
  assert.deepEqual(familyMood({ mood: 'sleep', data: { plan: { ...plan, changes: [], drift: [] } } }), { mood: 'happy', reason: 'the infrastructure matches' });
  assert.equal(familyMood({ mood: 'idle', data: {} }).reason, 'no plan yet');
  assert.match(reactionTo([{ app: 'bilge', mood: 'worried', reason: '2 critical', at: 1 }]).text, /Plot ruffles its feathers: Bilge is worried \(2 critical\)/);
});

test('t copies where a resource is declared for Splice, s an App Service app for Locker; the plan goes in the activity log', async () => {
  const app = start();
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await type(app.stdin, '/plan');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'azurerm_mssql_database.reports'), 'the changes');
  assert.match(readActivity().at(-1).text, /Planned infra: \+2 ~2 ±1 -1/);
  app.stdin.write('t');
  await until(() => app.copied.length === 1, 'the copy for Splice');
  assert.deepEqual(contextIn(app.copied[0]), { kind: 'file', data: { path: 'db.tf', line: 20 } });
  app.stdin.write('s');
  await until(shows(app, "isn't an App Service app"), 'the refusal');
  app.stdin.write('j');
  await until(() => /❯ ± azurerm_linux_web_app\.admin/.test(app.lastFrame()), 'the cursor on the app');
  app.stdin.write('s');
  await until(() => app.copied.length === 2, 'the copy for Locker');
  assert.deepEqual(contextIn(app.copied[1]).kind, 'site');
  assert.equal(contextIn(app.copied[1]).data.name, 'shop-admin-v2');
  assert.match(app.lastFrame(), /Copied for Locker/);
  app.unmount();
});
