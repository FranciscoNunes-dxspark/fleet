// Ballast in the family (family.js): its names, its mood and what it says of the siblings', the
// activity it adds, /env, and the lines it records for Fleet's runbooks.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { APP_NAMES, FAMILY, PET_NAMES, ROLES, readActivity, readMoods } from '@fleet/kit/family.js';
import { currentEnvironment } from '@fleet/kit/environments.js';
import { recordedLines } from '@fleet/kit/recording.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEYS, start, tempHome, type, until } from './helpers.js';
import { familyMood, reactionTo } from '../src/moods.js';
import { moodFor, moodLine, petPixels } from '../src/pet.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);

test('Ballast is in the family, with its names', () => {
  assert.ok(FAMILY.includes('ballast'));
  assert.deepEqual([APP_NAMES.ballast, PET_NAMES.ballast, ROLES.ballast], ['Ballast', 'Plod', 'BUNDLE']);
});

test("Plod's mood: a file over its budget worries it, a build within its budgets makes it happy", () => {
  const build = { chunks: [{}] };
  const over = [{ pattern: 'dist/assets/index-*.js', size: 112700, limit: 100000 }];
  assert.deepEqual(familyMood({ mood: 'wave', build, over }), { mood: 'worried', reason: '1 over budget: dist/assets/index-*.js 112.7 kB > 100.0 kB' });
  assert.deepEqual(familyMood({ mood: 'wave', build, budgeted: true, total: 190000 }), { mood: 'happy', reason: '190.0 kB gzip, within its budgets' });
  assert.equal(familyMood({ mood: 'sleep', build: { chunks: [] } }).reason, 'no build read');
  assert.equal(familyMood({ mood: 'look', busy: { label: 'Building' } }).mood, 'busy');
  assert.equal(moodFor({ build, over: 1 }), 'worried');
  assert.equal(moodFor({ build, over: 0 }), 'wave');
  assert.equal(moodFor({ build: { chunks: [] } }), 'sleep');
  assert.match(moodLine({ build, over: 1, total: 190000 }), /1 file, 190\.0 kB gzip; 1 over budget/);
  for (const m of ['idle', 'look', 'sleep', 'happy', 'worried', 'wave']) assert.ok(petPixels(m).every((row) => row.length === 16), m);
  const said = reactionTo([{ app: 'bilge', mood: 'worried', reason: '2 critical', at: 5 }]);
  assert.match(said.text, /Plod pulls its head in: Bilge is worried \(2 critical\)/);
});

test('opening writes its mood for the siblings and the read to the activity log (sizes, nothing from the bundle)', async () => {
  const app = start();
  await until(shows(app, 'dist/assets/index-B7xk2Lq9.js'), 'the chunks');
  await until(() => readMoods('bilge').some((m) => m.app === 'ballast'), 'the mood');
  const mood = readMoods('bilge').find((m) => m.app === 'ballast');
  assert.equal(mood.mood, 'worried');
  assert.match(mood.reason, /over budget/);
  assert.match(readActivity()[0].text, /^Read shop: 190\.0 kB gzip in 5 files$/);
  await type(app.stdin, '/security');
  app.stdin.write(KEYS.enter);
  await until(() => /Security of shop's build/.test(readActivity()[0].text), 'the security line');
  assert.equal(readActivity()[0].text, "Security of shop's build: 1 critical · 1 medium");
  app.unmount();
});

/** A project folder naming dev and prod in .fleet/project.json, under the temporary home. */
function projectWithEnvironments() {
  const dir = join(process.env.BALLAST_HOME, 'shop');
  mkdirSync(join(dir, '.fleet'), { recursive: true });
  writeFileSync(join(dir, '.fleet', 'project.json'), JSON.stringify({ default: 'dev', environments: { dev: {}, prod: { prod: true } } }));
  return dir;
}

test("/env says the project's environment and switches every app's", async () => {
  const dir = projectWithEnvironments();
  const app = start({ cwd: dir });
  await until(shows(app, 'dist/assets/index-B7xk2Lq9.js'), 'the chunks');
  assert.match(app.lastFrame(), /shop {2}│ {2}dev/);
  await type(app.stdin, '/env prod');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'prod (production)'), 'the header saying so');
  assert.equal(currentEnvironment(dir).name, 'prod');
  app.unmount();
});

test('while Fleet records a runbook, every slash command the prompt runs goes in it', async () => {
  mkdirSync(process.env.FAMILY_HOME, { recursive: true });
  writeFileSync(join(process.env.FAMILY_HOME, 'recording.json'), JSON.stringify({ project: '/demo/shop', since: 1 }));
  const app = start();
  await until(shows(app, 'dist/assets/index-B7xk2Lq9.js'), 'the chunks');
  await type(app.stdin, '/compare main');
  app.stdin.write(KEYS.enter);
  await until(() => recordedLines().length === 1, '/compare recorded');
  assert.deepEqual(recordedLines().map((l) => [l.app, l.line]), [['ballast', '/compare main']]);
  app.unmount();
});
