import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movedSince, previousWorkingDay, slideCounts, standupSinceMs, standupSlides, teamBlockers } from '../client/src/line/standup.js';
import { standupMessage } from '../server/domain/messages.js';
import { standupDue } from '../server/channels.js';
import { createMultiService } from '../server/multiorg.js';
import { translator } from '../server/i18n.js';

const DAY = 86_400_000;
const ana = { id: 'a', displayName: 'Ana', uniqueName: 'ana@x.com' };
const bo = { id: 'b', displayName: 'Bo', uniqueName: 'bo@x.com' };
const cy = { id: 'c', displayName: 'Cy', uniqueName: 'cy@x.com' };
const NOW = Date.parse('2026-11-04T09:00:00Z'); // a Wednesday
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const card = (over) => ({ key: Math.random().toString(36), kind: 'workitem', title: 'x', age: DAY, stuck: null, ...over });
const stages = [
  { id: 'planned', cards: [card({ key: 'w1', person: bo, stage: 'planned' })] },
  { id: 'building', cards: [card({ key: 'w2', person: ana, stuck: 'warn', age: 2 * DAY }), card({ key: 'w3', person: ana, stuck: 'bad', age: DAY }), card({ key: 'w4', person: null, stuck: 'bad', age: 9 * DAY })] },
  { id: 'review', cards: [card({ key: 'p1', kind: 'pr', person: bo, waitingOn: [ana] }), card({ key: 'p2', kind: 'pr', person: cy, stuck: 'warn', age: 4 * DAY })] },
  { id: 'merged', cards: [] },
  { id: 'deploying', cards: [card({ key: 'pipe', kind: 'pipeline', person: null, stuck: 'bad', age: 3 * DAY })] },
  { id: 'live', cards: [] },
];
const raw = {
  finished: [{ key: 'wi:9', person: ana, at: iso(3 * 3600e3) }, { key: 'wi:8', person: ana, at: iso(3 * DAY) }],
  changed: [{ key: 'wi:7', person: bo, at: iso(3600e3), state: 'Active' }],
  opened: [{ key: 'pr:5', person: bo, at: iso(2 * 3600e3) }],
  merged: [{ key: 'pr:4', person: cy, at: iso(5 * 3600e3), reviewers: [{ person: ana, vote: 10 }, { person: cy, vote: 10 }, { person: bo, vote: 0 }] }],
};

test('the previous working day: yesterday, Friday on a Monday and at weekends', () => {
  const day = (s) => previousWorkingDay(new Date(s));
  assert.equal(day('2026-11-04T10:00:00').toDateString(), new Date('2026-11-03T00:00:00').toDateString()); // Wednesday -> Tuesday
  assert.equal(day('2026-11-02T10:00:00').toDateString(), new Date('2026-10-30T00:00:00').toDateString()); // Monday -> Friday
  assert.equal(day('2026-11-08T10:00:00').toDateString(), new Date('2026-11-06T00:00:00').toDateString()); // Sunday -> Friday
  assert.equal(day('2026-11-04T10:00:00').getHours(), 0);
  assert.equal(standupSinceMs(NOW, 3), NOW - DAY);
  assert.equal(standupSinceMs(NOW, 1), NOW - 3 * DAY);
});

test('what moved: only since then, reviews are other people\'s completed pull requests someone voted on', () => {
  const moved = movedSince(raw, NOW - DAY);
  assert.deepEqual(moved.get('ana@x.com').finished.map((x) => x.key), ['wi:9']);
  assert.deepEqual(moved.get('ana@x.com').reviewed.map((x) => x.key), ['pr:4']);
  assert.deepEqual(moved.get('cy@x.com').merged.map((x) => x.key), ['pr:4']);
  assert.equal(moved.get('cy@x.com').reviewed.length, 0, 'not your own pull request');
  assert.equal(moved.get('bo@x.com').reviewed.length, 0, 'no vote, no review');
  assert.equal(moved.get('bo@x.com').changed.length, 1);
});

test('slides: one per person by name, with what they hold, stuck worst first, and reviews owed', () => {
  const slides = standupSlides({ stages, raw, since: NOW - DAY });
  assert.deepEqual(slides.map((s) => s.person.displayName), ['Ana', 'Bo', 'Cy']);
  const [a, b] = slides;
  assert.deepEqual(a.stuck.map((c) => c.key), ['w3', 'w2']);
  assert.deepEqual(a.reviews.map((c) => c.key), ['p1']);
  assert.deepEqual(slideCounts(a), { finished: 1, changed: 0, opened: 0, merged: 0, reviewed: 1, holding: 2, stuck: 2, reviews: 1 });
  assert.equal(b.holding.planned.length, 1);
  assert.equal(b.holding.review.length, 1);
  assert.equal(slides.some((s) => !s.person), false, 'work nobody holds has no slide');
});

test('slides for a team: everyone in it, quiet ones too, and nobody else', () => {
  const dee = { id: 'd', displayName: 'Dee', uniqueName: 'dee@x.com' };
  const slides = standupSlides({ stages, raw, since: NOW - DAY, members: [dee, ana] });
  assert.deepEqual(slides.map((s) => s.person.displayName), ['Ana', 'Dee']);
  assert.equal(slides[1].quiet, true);
  assert.equal(slides[0].quiet, false);
});

test('blockers: everything stuck, worst and oldest first; a team keeps its own work and everyone\'s pipelines', () => {
  assert.deepEqual(teamBlockers(stages).map((c) => c.key), ['w4', 'pipe', 'w3', 'p2', 'w2']);
  assert.deepEqual(teamBlockers(stages, [ana]).map((c) => c.key), ['w4', 'pipe', 'w3', 'w2']);
  assert.equal(teamBlockers(stages)[1].stageId, 'deploying');
});

test('the standup post: a line per person, then the blockers, in the channel\'s language', () => {
  const slides = standupSlides({ stages, raw, since: NOW - DAY });
  const msg = standupMessage(slides, teamBlockers(stages), translator('en'), { since: NOW - DAY, timeZone: 'UTC', keelUrl: 'https://keel.example.com' });
  assert.equal(msg.title, 'Standup: since Tuesday');
  assert.match(msg.sections[0].lines[0], /^Ana: Finished 1 · Reviewed 1 · On the Line 2 · 2 stuck · Reviews owed 1$/);
  assert.equal(msg.sections[1].heading, 'Blockers');
  assert.equal(msg.tone, 'warn');
  assert.deepEqual(msg.links, [{ label: 'Start standup', url: 'https://keel.example.com/standup' }]);
  const pt = standupMessage(slides, [], translator('pt'), { since: NOW - DAY, timeZone: 'UTC' });
  assert.equal(pt.title, 'Reunião diária: desde terça-feira');
  assert.match(pt.sections[0].lines[0], /^Ana: Concluído 1 · Revisto 1 · Na Linha 2/);
  const empty = standupMessage([], [], translator('en'), { since: NOW - DAY });
  assert.deepEqual(empty.sections, [{ lines: ['Nothing on the Line, and nothing moved.'] }]);
});

test('the standup post is due once on weekdays, from its hour', () => {
  const c = { standup: { enabled: true, hour: 9 }, timeZone: 'UTC' };
  assert.equal(standupDue(c, null, Date.parse('2026-11-04T09:05:00Z')), '2026-11-04');
  assert.equal(standupDue(c, '2026-11-04', Date.parse('2026-11-04T10:00:00Z')), null);
  assert.equal(standupDue(c, null, Date.parse('2026-11-04T08:59:00Z')), null);
  assert.equal(standupDue(c, null, Date.parse('2026-11-07T10:00:00Z')), null, 'Saturday');
  assert.equal(standupDue({ ...c, standup: { enabled: false, hour: 9 } }, null, Date.parse('2026-11-04T10:00:00Z')), null);
});

test('several organizations: what moved keeps each one\'s keys and work item links apart', async () => {
  const part = (id) => ({
    standupData: async () => ({
      since: iso(DAY),
      finished: [{ key: `wi:${id}`, id, person: ana, at: iso(1), open: { type: 'workitem', id } }],
      changed: [],
      opened: [{ key: 'pr:p/r/1', id: 1, person: bo, at: iso(1), open: { type: 'pr', projectId: 'p', repoId: 'r', id: 1 } }],
      merged: [],
    }),
  });
  const multi = createMultiService([
    { org: { key: 'one', primary: true }, service: part(7) },
    { org: { key: 'two' }, service: part(7) },
  ]);
  const out = await multi.standupData({ since: NOW - DAY });
  assert.deepEqual(out.finished.map((x) => [x.key, x.open.org]), [['one/wi:7', 'one'], ['two/wi:7', 'two']]);
  assert.equal(new Set(out.opened.map((x) => x.key)).size, 2);
  assert.equal(out.opened[0].open.org, undefined);
});
