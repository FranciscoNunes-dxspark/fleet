// Bilge in the family (family.js): its names, what it hands Splice, its mood and the activity it adds.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { APP_NAMES, FAMILY, PET_NAMES, ROLES, contextIn, readActivity } from '@fleet/kit/family.js';
import { currentEnvironment } from '@fleet/kit/environments.js';
import { recordedLines } from '@fleet/kit/recording.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEYS, start, tempHome, type, until } from './helpers.js';
import { familyMood, reactionTo } from '../src/moods.js';
import { fileData } from '../src/share.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);

test('Bilge is in the family, with its names', () => {
  assert.ok(FAMILY.includes('bilge'));
  assert.deepEqual([APP_NAMES.bilge, PET_NAMES.bilge, ROLES.bilge], ['Bilge', 'Nibs', 'DEPS']);
});

test("Nibs's mood: a critical or high advisory worries it, a clean audit makes it happy", () => {
  const data = (c) => ({ packages: [1, 2, 3], audit: { counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, ...c } } });
  assert.deepEqual(familyMood({ mood: 'wave', data: data({ critical: 1, high: 2 }) }), { mood: 'worried', reason: '1 critical · 2 high' });
  assert.deepEqual(familyMood({ mood: 'wave', data: data({ medium: 1 }) }), { mood: 'happy', reason: 'only 1 medium' });
  assert.deepEqual(familyMood({ mood: 'wave', data: data({}) }), { mood: 'happy', reason: 'nothing known against 3 packages' });
  assert.equal(familyMood({ mood: 'idle', data: { packages: [1] } }).reason, 'not audited yet');
  assert.equal(familyMood({ mood: 'look', data: null, busy: { label: 'Asking OSV' } }).mood, 'busy');
  const said = reactionTo([{ app: 'wharf', mood: 'worried', reason: 'api unhealthy', at: 5 }]);
  assert.match(said.text, /Nibs drops its bucket: Wharf is worried \(api unhealthy\)/);
});

test("t on a vulnerable package copies where it is for Splice's blame; the audit goes in the activity log", async () => {
  assert.deepEqual(fileData({ path: 'package-lock.json', line: 48 }), { path: 'package-lock.json', line: 48 });
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  app.stdin.write('t');
  await until(() => app.copied.length === 1, 'the copy');
  assert.deepEqual(contextIn(app.copied[0]), { kind: 'file', data: { path: 'package-lock.json', line: 48 } });
  assert.match(app.lastFrame(), /Copied for Splice/);
  assert.match(readActivity().at(-1).text, /Audited shop: 2 critical · 4 high · 1 medium/);
  app.stdin.write(KEYS.esc);
  app.unmount();
});

test('/take of a context Bilge has no use for says whose it is', async () => {
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  app.stdin.write('/take family:v1:commit:eyJoYXNoIjoiYWJjIn0');
  await until(shows(app, '/take family:v1:commit'), 'the prompt with it');
  app.stdin.write(KEYS.enter);
  await until(shows(app, "That's commit abc, for Splice or Sonar or Keel"), 'the answer');
  app.unmount();
});

/** A project folder naming dev and prod in .fleet/project.json, under the temporary home. */
function projectWithEnvironments() {
  const dir = join(process.env.BILGE_HOME, 'shop');
  mkdirSync(join(dir, '.fleet'), { recursive: true });
  writeFileSync(join(dir, '.fleet', 'project.json'), JSON.stringify({ default: 'dev', environments: { dev: {}, prod: { prod: true } } }));
  return dir;
}

test("/env says the project's environment and switches every app's; on production a fix asks once more", async () => {
  const dir = projectWithEnvironments();
  const app = start({ cwd: dir });
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  assert.match(app.lastFrame(), /dev {2}2 critical/);
  await type(app.stdin, '/env');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Environment: dev. /env prod switches every app.'), 'which one');
  await type(app.stdin, '/env prod');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'prod (production)'), 'the top line saying so');
  assert.equal(currentEnvironment(dir).name, 'prod', "chosen in the family's folder, for the others");
  assert.ok(readActivity().some((e) => /Switched shop to prod \(production\)/.test(e.text)), 'the switch in the activity log');
  await type(app.stdin, '/fix lodash');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Move lodash from 4.17.20 to 4.17.21?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'prod is production. Move lodash to 4.17.21?'), 'the production question');
  app.stdin.write('2');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!app.provider.state.calls.some((c) => c[0] === 'run'), 'no means nothing runs');
  await type(app.stdin, '/env nowhere');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'No environment nowhere: dev, prod.'), 'the error');
  app.unmount();
});

test('while Fleet records a runbook, every slash command and /take line the prompt runs goes in it', async () => {
  mkdirSync(process.env.FAMILY_HOME, { recursive: true });
  writeFileSync(join(process.env.FAMILY_HOME, 'recording.json'), JSON.stringify({ project: '/tmp/shop', since: 1 }));
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  const context = 'family:v1:commit:eyJoYXNoIjoiYWJjIn0';
  await type(app.stdin, '/audit');
  app.stdin.write(KEYS.enter);
  await until(() => recordedLines().length === 1, '/audit recorded');
  await until(() => !app.lastFrame().includes('Asking OSV'), 'the audit done');
  await type(app.stdin, `/take ${context}`);
  app.stdin.write(KEYS.enter);
  await until(() => recordedLines().length === 2, '/take recorded');
  // A context pasted alone is /take's, and recorded as one.
  app.stdin.write(context);
  await until(shows(app, context), 'the prompt with it');
  app.stdin.write(KEYS.enter);
  await until(() => recordedLines().length === 3, 'the pasted one recorded');
  assert.deepEqual(recordedLines().map((l) => [l.app, l.line]), [['bilge', '/audit'], ['bilge', `/take ${context}`], ['bilge', `/take ${context}`]]);
  app.unmount();
});
