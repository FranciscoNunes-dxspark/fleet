// Lantern in the family (family.js): its names, its mood, the activity it adds, environments and recording.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_NAMES, FAMILY, PET_NAMES, ROLES, TAKEN_BY, readActivity } from '@fleet/kit/family.js';
import { currentEnvironment } from '@fleet/kit/environments.js';
import { recordedLines } from '@fleet/kit/recording.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';
import { familyMood, reactionTo } from '../src/moods.js';
import { createLantern } from '../src/provider.js';
import { demoLantern } from '../src/demo.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);

test('Lantern is in the family, with its names, and takes the page context', () => {
  assert.ok(FAMILY.includes('lantern'));
  assert.deepEqual([APP_NAMES.lantern, PET_NAMES.lantern, ROLES.lantern], ['Lantern', 'Flit', 'WEB']);
  assert.deepEqual(TAKEN_BY.page, ['lantern']);
});

test("Flit's mood: a high finding worries it, a clean page makes it happy, an audit keeps it busy", () => {
  const counts = (c) => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0, ...c });
  assert.deepEqual(familyMood({ mood: 'wave', result: { url: 'https://s/', counts: counts({ high: 2 }) } }), { mood: 'worried', reason: '2 high on https://s/' });
  assert.deepEqual(familyMood({ mood: 'wave', result: { url: 'https://s/', counts: counts({ low: 1 }) } }), { mood: 'happy', reason: 'only 1 low on https://s/' });
  assert.equal(familyMood({ mood: 'look', busy: { label: 'Auditing' } }).reason, 'Auditing');
  assert.equal(familyMood({ mood: 'idle' }).reason, 'nothing audited yet');
  assert.match(reactionTo([{ app: 'bilge', mood: 'worried', reason: '2 critical', at: 1 }]).text, /Flit circles the lamp faster: Bilge is worried \(2 critical\)/);
});

/** A project folder whose environments each name a page for Lantern. */
function project() {
  const dir = join(process.env.LANTERN_HOME, 'shop');
  mkdirSync(join(dir, '.fleet'), { recursive: true });
  writeFileSync(join(dir, '.fleet', 'project.json'), JSON.stringify({ default: 'staging', environments: { staging: { lantern: { url: 'https://staging.shop.example/' } }, prod: { prod: true, lantern: { url: 'https://shop.example/' } } } }));
  return dir;
}

test('the pages come from the environments; /env switches every app and selects its page; an audit goes in the activity log', async () => {
  const dir = project();
  const real = createLantern();
  const app = start({ cwd: dir, provider: { ...demoLantern(), pages: real.pages } });
  await until(shows(app, 'https://shop.example/'), 'the pages');
  assert.match(app.lastFrame(), /shop {2}│ {2}staging {2}│ {2}https:\/\/staging\.shop\.example\//);
  await type(app.stdin, '/env prod');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'prod (production)'), 'the header saying so');
  assert.equal(currentEnvironment(dir).name, 'prod');
  await until(shows(app, '│  https://shop.example/'), 'its page selected');
  app.stdin.write('a');
  await until(shows(app, 'LCP 2.9 s'), 'the audit');
  await until(() => readActivity().some((e) => /^Audited https:\/\/shop\.example\/: 1 critical · \d+ high · .*, LCP 2\.9 s$/.test(e.text)), 'the audit in the activity log');
  app.unmount();
});

test('while Fleet records a runbook, every slash command and /take line the prompt runs goes in it', async () => {
  mkdirSync(process.env.FAMILY_HOME, { recursive: true });
  writeFileSync(join(process.env.FAMILY_HOME, 'recording.json'), JSON.stringify({ project: '/tmp/shop', since: 1 }));
  const app = start();
  await until(shows(app, 'not audited'), 'the pages');
  await type(app.stdin, '/runs 2');
  app.stdin.write(KEYS.enter);
  await until(() => recordedLines().length === 1, '/runs recorded');
  const context = 'family:v1:commit:eyJoYXNoIjoiYWJjIn0';
  app.stdin.write(context);
  await until(shows(app, context), 'the prompt with it');
  app.stdin.write(KEYS.enter);
  await until(() => recordedLines().length === 2, 'the pasted one recorded');
  assert.deepEqual(recordedLines().map((l) => [l.app, l.line]), [['lantern', '/runs 2'], ['lantern', `/take ${context}`]]);
  app.unmount();
});
