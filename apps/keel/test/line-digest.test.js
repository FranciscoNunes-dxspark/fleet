import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookAt, sinceLastLook } from '../client/src/line/digest.js';
import { digestCounts, lineDigestMessage } from '../server/domain/messages.js';
import { translator } from '../server/i18n.js';

const card = (key, stage, extra = {}) => ({ key, stage, title: key, age: 864e5, ...extra });
const line = (cards) => ['planned', 'building', 'review', 'merged', 'deploying', 'live'].map((id) => {
  const list = cards.filter((c) => c.stage === id);
  return { id, cards: list, count: list.length, stuck: { bad: list.filter((c) => c.stuck === 'bad').length, warn: list.filter((c) => c.stuck === 'warn').length }, tone: list.some((c) => c.stuck === 'bad') ? 'bad' : null };
});

test('no look before: nothing to tell', () => {
  assert.equal(sinceLastLook(null, line([card('a', 'planned')])), null);
});

test('moved on, left, new and newly stuck since the last look', () => {
  const before = lookAt(line([card('a', 'planned'), card('b', 'review'), card('c', 'building'), card('d', 'building', { stuck: 'warn' })]));
  const diff = sinceLastLook(before, line([card('a', 'building'), card('c', 'building', { stuck: 'bad' }), card('d', 'building', { stuck: 'bad' }), card('e', 'planned')]));
  assert.deepEqual(diff.movedOn.map((m) => [m.card.key, m.from]), [['a', 'planned']]);
  assert.deepEqual(diff.left.map((l) => l.key), ['b']);
  assert.deepEqual(diff.arrived.map((c) => c.key), ['e']);
  assert.deepEqual(diff.newlyStuck.map((c) => c.key), ['c']);
});

test("the channels' digest: every stage with its change since the last one, and the longest stuck", () => {
  const stages = line([card('a', 'review', { stuck: 'bad', reason: { code: 'conflicts' } }), card('b', 'review'), card('c', 'planned')]);
  const msg = lineDigestMessage(stages, { review: { count: 1, stuck: 0 }, planned: { count: 1, stuck: 0 } }, translator('en'), { keelUrl: 'https://keel.example.com' });
  assert.equal(msg.title, 'The Line today: In review is jammed');
  assert.equal(msg.tone, 'bad');
  assert.ok(msg.sections[0].lines.some((l) => l.includes('In review: 2 (+1) · 1 stuck (+1)')));
  assert.deepEqual(msg.sections[1].lines, ['a (In review): Merge conflicts']);
  assert.deepEqual(digestCounts(stages).review, { count: 2, stuck: 1 });
  const pt = lineDigestMessage(stages, null, translator('pt'));
  assert.match(pt.title, /^A Linha hoje: Em revisão está encravado$/);
});

test('the daily digest is due on weekdays from its hour, once a day', async () => {
  const { dailyDue } = await import('../server/channels.js');
  const c = { daily: { enabled: true, hour: 9 }, timeZone: 'UTC' };
  const monday9 = Date.parse('2026-11-02T09:05:00Z');
  assert.equal(dailyDue(c, null, monday9), '2026-11-02');
  assert.equal(dailyDue(c, '2026-11-02', monday9), null);
  assert.equal(dailyDue(c, null, Date.parse('2026-11-02T08:59:00Z')), null);
  assert.equal(dailyDue(c, null, Date.parse('2026-11-01T10:00:00Z')), null); // a Sunday
  assert.equal(dailyDue({ ...c, daily: { enabled: false, hour: 9 } }, null, monday9), null);
});
