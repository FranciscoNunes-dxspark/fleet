import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyThroughput, forecast, paceScale, remainingUnder, seededRandom, MIN_FINISHED } from '../client/src/forecast.js';

const D = 864e5;
const NOW = Date.parse('2026-10-17T12:00:00Z');
const at = (daysAgo) => new Date(NOW - daysAgo * D).toISOString();
const wi = (id, f) => ({ id, type: 'User Story', title: `Item ${id}`, stateCategory: 'Completed', assignedTo: { uniqueName: 'ana@x' }, ...f });

test('forecast: the pace counts finished backlog items per day, not tasks, features or epics', () => {
  const pace = dailyThroughput([
    wi(1, { closedAt: at(0) }), // today
    wi(2, { closedAt: at(1), assignedTo: { uniqueName: 'Bo@x' } }),
    wi(3, { type: 'Bug', closedAt: at(1), assignedTo: { uniqueName: 'bo@x' } }),
    wi(4, { type: 'Task', closedAt: at(1) }),
    wi(5, { type: 'Feature', closedAt: at(2) }),
    wi(6, { stateCategory: 'InProgress', closedAt: at(1) }),
    wi(7, { closedAt: at(40) }), // before the window
    wi(2, { closedAt: at(1) }), // the same item twice
    wi(8, { closedAt: null, stateChangedAt: at(3), assignedTo: null }),
  ], { days: 30, now: NOW });
  assert.equal(pace.daily.length, 30);
  assert.deepEqual(pace.daily.slice(-4), [1, 0, 2, 1]);
  assert.equal(pace.finished, 4);
  assert.equal(pace.people, 2); // Ana and Bo, whatever the case of their address
  assert.equal(pace.since, '2026-09-18');
});

test('forecast: a steady pace gives the same date at every odds', () => {
  const f = forecast({ remaining: 10, daily: new Array(30).fill(2), now: NOW, runs: 500 });
  assert.equal(f.ok, true);
  assert.deepEqual(f.odds.map((o) => o.days), [5, 5, 5]);
  assert.equal(f.odds[0].date, '2026-10-22');
  assert.equal(f.historyDays, 30);
  assert.equal(f.finished, 60);
});

test('forecast: an uneven pace spreads the dates, later for higher odds, the same for the same seed', () => {
  const daily = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? 3 : 0)); // 1 a day on average, in bursts
  const a = forecast({ remaining: 20, daily, now: NOW, seed: 7 });
  const b = forecast({ remaining: 20, daily, now: NOW, seed: 7 });
  assert.deepEqual(a, b);
  const [p50, p85, p95] = a.odds.map((o) => o.days);
  assert.ok(p50 <= p85 && p85 <= p95, `${p50} ${p85} ${p95}`);
  assert.ok(p50 >= 15 && p50 <= 25, `about 20 days at even odds, got ${p50}`);
  assert.ok(p95 > p50);
});

test('forecast: what-ifs move the dates: less work sooner, more pace sooner, a share of the team later', () => {
  const daily = Array.from({ length: 60 }, (_, i) => (i % 2 ? 2 : 0));
  const p85 = (opts) => forecast({ daily, now: NOW, ...opts }).odds[1].days;
  const base = p85({ remaining: 30 });
  assert.ok(p85({ remaining: 15 }) < base);
  assert.ok(p85({ remaining: 30, scale: paceScale({ added: 2, people: 2 }) }) < base);
  assert.ok(p85({ remaining: 30, scale: paceScale({ share: 0.5, people: 2 }) }) > base);
});

test('forecast: says plainly when it can\'t', () => {
  assert.equal(forecast({ remaining: 0, daily: new Array(30).fill(1) }).reason, 'nothing-left');
  assert.equal(forecast({ remaining: 5, daily: new Array(10).fill(1) }).reason, 'too-little-history');
  const few = new Array(30).fill(0);
  few[3] = MIN_FINISHED - 1;
  assert.equal(forecast({ remaining: 5, daily: few }).reason, 'too-little-history');
  assert.equal(forecast({ remaining: 5, daily: new Array(30).fill(1), scale: 0 }).reason, 'too-slow');
  // One item in 60 days, with thousands left: some runs never finish.
  const slow = new Array(60).fill(0);
  slow[0] = 5;
  assert.equal(forecast({ remaining: 5000, daily: slow, runs: 50 }).reason, 'too-slow');
});

test('forecast: the work left under an epic counts as its roll-up does', () => {
  const n = (item, children = []) => ({ item, children });
  const epic = n({ id: 1, type: 'Epic' }, [
    n({ id: 2, type: 'Feature' }, [
      n({ id: 3, type: 'User Story', stateCategory: 'InProgress' }, [n({ id: 4, type: 'Task', stateCategory: 'Proposed' })]),
      n({ id: 5, type: 'Bug', stateCategory: 'Completed' }),
      n({ id: 6, type: 'Task', stateCategory: 'Proposed' }), // straight on a feature: counts
    ]),
    n({ id: 7, type: 'Product Backlog Item', stateCategory: 'Proposed' }),
  ]);
  assert.deepEqual(remainingUnder(epic).map((w) => w.id).sort(), [3, 6, 7]);
});

test('forecast: the random generator repeats for a seed and stays in [0, 1)', () => {
  const a = seededRandom(42);
  const b = seededRandom(42);
  const xs = Array.from({ length: 100 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 100 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});
