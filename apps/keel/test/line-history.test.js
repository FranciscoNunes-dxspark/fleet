import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEEP_DAYS, record, redFor, summarize, turnedRed } from '../server/domain/linehistory.js';

const at = (day) => Date.parse(`${day}T12:00:00Z`);
const look = (day, tones) => summarize(Object.entries(tones).map(([id, tone]) => ({ id, count: 4, stuck: { warn: 0, bad: tone === 'bad' ? 2 : 0 }, tone })), at(day));

test('a day keeps its latest look, and old days fall off', () => {
  let entries = record([], look('2026-01-01', { review: null }));
  entries = record(entries, look('2026-01-02', { review: null }));
  entries = record(entries, look('2026-01-02', { review: 'bad' }));
  assert.deepEqual(entries.map((e) => [e.day, e.stages.review.tone]), [['2026-01-01', null], ['2026-01-02', 'bad']]);
  const later = record(entries, look('2026-06-01', { review: null }));
  assert.ok(KEEP_DAYS < 150);
  assert.deepEqual(later.map((e) => e.day), ['2026-06-01']);
});

test('red for counts the days in a row up to today, and a gap ends the run', () => {
  const days = ['2026-01-01', '2026-01-03', '2026-01-04', '2026-01-05'].map((d) => look(d, { review: 'bad', live: null }));
  assert.equal(redFor(days, 'review'), 3);
  assert.equal(redFor(days, 'live'), 0);
});

test('turned red: only the stages that are red now and were not at the last look', () => {
  assert.deepEqual(turnedRed(null, look('2026-01-02', { review: 'bad' })), []);
  assert.deepEqual(turnedRed(look('2026-01-01', { review: 'warn', merged: 'bad' }), look('2026-01-02', { review: 'bad', merged: 'bad' })), ['review']);
});
