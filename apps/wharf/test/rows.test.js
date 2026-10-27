import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STANDALONE, containerRows, findContainer, imageName, isTrouble, logLine, logTone, shortBytes, shortCpu, stateLabel, stateTone, targetsOf } from '../src/rows.js';
import { demoContainers } from '../src/demo.js';
import { COMMANDS, findCommand, suggestionsFor } from '../src/commands.js';
import { moodFor, moodLine, petPixels, petRows, PALETTE } from '../src/pet.js';

const boxes = demoContainers();

test('rows: a heading per compose project, standalone last, running first within each', () => {
  const rows = containerRows(boxes);
  assert.deepEqual(rows.filter((r) => r.heading).map((r) => r.heading), ['shop', STANDALONE]);
  const shop = rows.slice(1, 5).map((r) => r.c.service);
  assert.deepEqual(shop, ['api', 'db', 'web', 'worker']);
  assert.equal(rows.at(-1).c.name, 'old-experiment');
  assert.ok(containerRows(boxes, { onlyRunning: true }).every((r) => r.heading || r.c.state === 'running'));
  assert.deepEqual(containerRows(boxes, { query: 'REDIS' }).map((r) => r.heading ?? r.c.name), [STANDALONE, 'redis-cache']);
});

test('a name, an id start, project/service or a unique prefix finds a container; ambiguous ones find none', () => {
  assert.equal(findContainer(boxes, 'redis-cache').id, 'e5f6a1b2c3d4');
  assert.equal(findContainer(boxes, 'e5f6').name, 'redis-cache');
  assert.equal(findContainer(boxes, 'shop/db').name, 'shop-db-1');
  assert.equal(findContainer(boxes, 'shop-'), null);
  assert.equal(findContainer(boxes, 'nothing'), null);
  assert.equal(findContainer(boxes, ''), null);
});

test('a target is all, a compose project, or one container', () => {
  assert.equal(targetsOf(boxes, 'all').length, boxes.length);
  assert.deepEqual(targetsOf(boxes, 'shop').map((c) => c.service), ['web', 'api', 'db', 'worker']);
  assert.deepEqual(targetsOf(boxes, 'mailpit').map((c) => c.name), ['mailpit']);
  assert.deepEqual(targetsOf(boxes, 'zzz'), []);
});

test('states, their colours, and the short numbers in a row', () => {
  const by = Object.fromEntries(boxes.map((c) => [c.name, c]));
  assert.deepEqual([stateLabel(by['shop-web-1']), stateTone(by['shop-web-1'])], ['running', 'add']);
  assert.deepEqual([stateLabel(by['shop-worker-1']), stateTone(by['shop-worker-1'])], ['exited 1', 'del']);
  assert.deepEqual([stateLabel(by.mailpit), stateTone(by.mailpit)], ['unhealthy', 'del']);
  assert.deepEqual([stateLabel(by['old-experiment']), stateTone(by['old-experiment'])], ['exited', 'dim']);
  assert.deepEqual([shortBytes(512), shortBytes(1536), shortBytes(324 * 1024 * 1024), shortBytes(null)], ['512B', '1.5K', '324M', '']);
  assert.deepEqual([shortCpu(0.34), shortCpu(12.4), shortCpu(null)], ['0.3%', '12%', '']);
  assert.equal(imageName({ repo: 'redis', tag: '7' }), 'redis:7');
  assert.equal(imageName({ repo: null, tag: null, id: 'abc' }), '<none> abc');
});

test('log lines: the long timestamp is cut to the time, and trouble and warnings are coloured', () => {
  assert.equal(logLine('2026-10-27T09:00:07.123456789Z INFO started'), '09:00:07 INFO started');
  assert.equal(logLine('plain line'), 'plain line');
  assert.ok(isTrouble('ERROR: boom') && isTrouble('Unhandled exception') && !isTrouble('terrorists'));
  assert.deepEqual([logTone('level=error x'), logTone('WARN slow'), logTone('INFO fine')], ['del', 'warn', undefined]);
});

test('slash commands: names, prefixes and completion from what Docker has', () => {
  assert.equal(findCommand('rest').name, 'restart');
  assert.equal(findCommand('re'), null);
  assert.equal(findCommand('LOGS').name, 'logs');
  assert.equal(new Set(COMMANDS.map((c) => c.name)).size, COMMANDS.length);
  const data = { containers: boxes, images: [{ repo: 'redis', tag: '7', id: 'x' }] };
  assert.deepEqual(suggestionsFor('/stop shop', { data }).map((s) => s.label).slice(0, 1), ['shop']);
  assert.ok(suggestionsFor('/rmi re', { data }).some((s) => s.label === 'redis:7'));
  assert.deepEqual(suggestionsFor('plain'), []);
  const first = suggestionsFor('/pr')[0];
  assert.equal(first.label, '/prune');
  assert.equal(first.run, true);
});

test("Bark's drawing: every row is as wide as the first, every letter has a colour, and each mood is the base with some rows swapped", () => {
  const base = petPixels('idle');
  assert.equal(base.length, 10);
  for (const mood of ['idle', 'look', 'sleep', 'happy', 'worried', 'wave']) {
    const px = petPixels(mood);
    assert.ok(px.every((row) => row.length === base[0].length), mood);
    assert.ok(px.every((row) => [...row].every((ch) => ch === '.' || PALETTE[ch])), mood);
    assert.equal(petRows(mood).length, 5);
  }
  assert.notDeepEqual(petPixels('sleep'), base);
});

test('mood follows the containers: unwell ones worry it, none running lets it sleep', () => {
  const data = { containers: boxes };
  assert.equal(moodFor({ data }), 'worried');
  assert.equal(moodFor({ data: { containers: boxes.filter((c) => c.state === 'running' && !c.health) } }), 'wave');
  assert.equal(moodFor({ data: { containers: boxes.filter((c) => c.state === 'exited' && !c.exitCode) } }), 'sleep');
  assert.equal(moodFor({ data: null }), 'idle');
  assert.match(moodLine('worried', data), /shop-worker-1.*not well/);
});
