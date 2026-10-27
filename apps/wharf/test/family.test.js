// Wharf in the family (family.js): the log line it hands the others and takes from them, its mood and the activity it adds.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { APP_NAMES, FAMILY, PET_NAMES, ROLES, TAKEN_BY, decodeContext, encodeContext, readActivity, readMoods, writeMood } from '@fleet/kit/family.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';
import { hasLine, latestTrouble, loglineData, matchIn, needleOf } from '../src/share.js';
import { familyMood, reactionTo } from '../src/moods.js';
import { demoContainers } from '../src/demo.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);
const LOG = ['2026-10-27T09:00:00.123456789Z INFO started', '2026-10-27T09:00:07.5Z ERROR api: upstream timed out after 30s', '2026-10-27T09:00:09Z INFO ok'].join('\n');

test('Wharf is in the family, takes log lines, and has its names', () => {
  assert.ok(FAMILY.includes('wharf'));
  assert.deepEqual([APP_NAMES.wharf, PET_NAMES.wharf, ROLES.wharf, TAKEN_BY.logline.includes('wharf')], ['Wharf', 'Bark', 'containers', true]);
});

test('a log line becomes a logline context, with its time, and is found again in a log', () => {
  const line = latestTrouble(LOG);
  assert.equal(line, '2026-10-27T09:00:07.5Z ERROR api: upstream timed out after 30s');
  assert.equal(latestTrouble('all fine\n'), null);
  const data = loglineData({ process: 'shop-api-1', line, project: '/srv/shop' });
  assert.deepEqual(data, { process: 'shop-api-1', text: 'ERROR api: upstream timed out after 30s', time: '2026-10-27T09:00:07.5Z', project: '/srv/shop' });
  assert.ok(hasLine(LOG, needleOf(data)));
  assert.ok(hasLine('09:00:07 error   API:  upstream timed out after 30s', needleOf(data)));
  assert.ok(!hasLine(LOG, needleOf({ text: 'something else' })));
  assert.ok(!hasLine(LOG, ''));
});

test("Bark's mood: unwell containers and crash-looping pods worry it, a quiet crew makes it happy", () => {
  const boxes = demoContainers();
  assert.deepEqual(familyMood({ mood: 'wave', data: { containers: boxes } }), { mood: 'worried', reason: 'shop-worker-1 exited with an error' });
  const fine = boxes.filter((c) => c.state === 'running' && !c.health);
  assert.deepEqual(familyMood({ mood: 'wave', data: { containers: fine } }), { mood: 'happy', reason: 'all 3 running' });
  assert.match(familyMood({ mood: 'wave', data: { containers: fine }, kubeData: { pods: [{ name: 'api-1', status: 'CrashLoopBackOff' }] } }).reason, /api-1: CrashLoopBackOff/);
  assert.equal(familyMood({ mood: 'look', data: { containers: fine }, busy: { label: 'Pulling' } }).mood, 'busy');
  const said = reactionTo([{ app: 'sonar', mood: 'worried', reason: '12 new exceptions', at: 5 }, { app: 'hail', mood: 'neutral', at: 4 }]);
  assert.deepEqual([said.key, said.mood], ['sonar:5', 'worried']);
  assert.match(said.text, /Sonar is worried \(12 new exceptions\)/);
  assert.equal(reactionTo([{ app: 'sonar', mood: 'worried', at: 5 }], new Set(['sonar:5'])), null);
});

test('t in a log copies its newest trouble line for Sonar, Hail and Bosun', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'request 1059 handled'), 'the log');
  app.stdin.write('t');
  await until(() => app.copied.length === 1, 'the clipboard');
  assert.match(app.copied[0], /^\/take family:v1:logline:/);
  const context = decodeContext(app.copied[0].replace('/take ', ''));
  assert.equal(context.kind, 'logline');
  assert.equal(context.data.process, 'shop-api-1');
  assert.equal(context.data.text, 'ERROR shop-api-1: upstream timed out after 30s');
  assert.equal(context.data.project, '/srv/shop');
  app.stdin.write(KEYS.esc);
  await until(shows(app, 'Copied for Sonar or Hail or Bosun'), 'the note');
  app.unmount();
});

test("/take finds a sibling's log line in the running containers and opens that log with it searched", async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  const line = encodeContext('logline', { process: 'somewhere', text: 'ERROR redis-cache: upstream timed out after 30s' });
  await type(app.stdin, `/take ${line}`);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'redis-cache · log'), 'the log it is in');
  await until(shows(app, '/error redis-cache: upstream timed out after 30s 6/6'), 'the search on it');
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('/error redis-cache'), 'the search cleared');
  app.stdin.write(KEYS.esc);
  await until(shows(app, 'Standalone'), 'the list again');
  await type(app.stdin, `/take ${encodeContext('logline', { process: 'x', text: 'never logged anywhere' })}`);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Not in the last 1000 lines'), 'the miss said');
  await type(app.stdin, `/take ${encodeContext('exception', { app: 'a', message: 'boom', type: 'Error' })}`);
  app.stdin.write(KEYS.enter);
  await until(shows(app, "That's exception"), 'what is not Wharf\'s said');
  app.unmount();
});

test("what Wharf changes goes in the family's activity log, and its mood is written for the others", async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  app.stdin.write('s');
  await until(() => readActivity().some((e) => e.app === 'wharf'), 'the activity');
  const entry = readActivity()[0];
  assert.deepEqual([entry.app, entry.kind, entry.text], ['wharf', 'change', 'Stopped shop-api-1']);
  assert.match(entry.project.replace(/\\/g, '/'), /srv\/shop$/);
  await until(() => readMoods('splice').some((m) => m.app === 'wharf'), 'the mood');
  assert.equal(readMoods('splice').find((m) => m.app === 'wharf').mood, 'worried');
  app.unmount();
});

test("a sibling's worried mood is remarked on by Bark, once, until esc", async () => {
  writeMood('sonar', { mood: 'worried', reason: '12 new exceptions' });
  const app = start({ moodEvery: 60_000 });
  await until(shows(app, 'Sonar is worried (12 new exceptions)'), "Bark's remark");
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Sonar is worried'), 'the remark put away');
  app.unmount();
});

test('a shared line has nothing secret in it and carries the request it names', () => {
  const log = ['t1 INFO GET /orders x-request-id: 7f3a9c21-aa', 't2 INFO calling postgres://app:hunter2@db/shop', 't3 ERROR failed token=s3cr3t'].join('\n');
  const data = loglineData({ process: 'api', line: 't3 ERROR failed token=s3cr3t', log });
  assert.equal(data.requestId, '7f3a9c21-aa');
  assert.ok(!JSON.stringify(data).includes('s3cr3t'));
  assert.ok(!JSON.stringify(loglineData({ process: 'api', line: 't2 INFO calling postgres://app:hunter2@db/shop', log })).includes('hunter2'));
  assert.equal(loglineData({ process: 'api', line: 't3 ERROR failed', log: 't3 ERROR failed' }).requestId, undefined);
  // The shared text has the secret blanked, so the log's own line doesn't match it: the request finds it instead.
  assert.equal(matchIn(log, { text: 'failed token=***', requestId: '7f3a9c21-aa' }), '7f3a9c21-aa');
  assert.equal(matchIn(log, { text: 'ERROR failed' }), 'error failed');
  assert.equal(matchIn(log, { text: 'not in the log', requestId: '7F3A9C21-AA' }), '7F3A9C21-AA');
  assert.equal(matchIn(log, { text: 'not in the log' }), null);
});

test('/take finds a line by the request it names when its text is not in any log', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  await type(app.stdin, `/take ${encodeContext('logline', { process: 'api', text: 'a different wording entirely', requestId: '1042' })}`);
  app.stdin.write(KEYS.enter);
  await until(shows(app, '/1042 1/1'), 'the request found');
  app.unmount();
});
