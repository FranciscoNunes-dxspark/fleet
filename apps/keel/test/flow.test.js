import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlow, buildSprintScope } from '../server/domain/flow.js';

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.parse('2026-10-17T12:00:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const wi = (id, f) => ({ id, type: 'User Story', title: `Item ${id}`, state: 'Closed', stateCategory: 'Completed', createdAt: at(60 * D), ...f });

test('flow: cycle time from Activated Date, throughput per week, aging work in progress', () => {
  const finished = [
    wi(1, { activatedAt: at(5 * D), closedAt: at(4 * D) }), // 1 day
    wi(2, { activatedAt: at(10 * D), closedAt: at(7 * D) }), // 3 days
    wi(3, { activatedAt: at(20 * D), closedAt: at(10 * D) }), // 10 days
    wi(4, { activatedAt: null, createdAt: at(12 * D), closedAt: at(2 * D) }), // no Activated Date: counts from creation
    wi(5, { activatedAt: at(50 * D), closedAt: at(40 * D) }), // outside 30 days
    wi(6, { type: 'Task', activatedAt: at(3 * D), closedAt: at(2 * D) }), // tasks don't count
    wi(1, { activatedAt: at(5 * D), closedAt: at(4 * D) }), // the same item twice
  ];
  const open = [
    wi(10, { state: 'Active', stateCategory: 'InProgress', activatedAt: at(15 * D) }),
    wi(11, { state: 'Resolved', stateCategory: 'Resolved', activatedAt: at(2 * D) }),
    wi(12, { state: 'Active', stateCategory: 'InProgress', activatedAt: null, stateChangedAt: at(4 * D) }),
    wi(13, { state: 'New', stateCategory: 'Proposed' }),
  ];
  const f = buildFlow({ finished, open, days: 30, now: NOW });
  assert.equal(f.totals.finished, 4);
  assert.equal(f.totals.estimated, 1);
  assert.equal(f.totals.medianCycleHours, (3 * 24 + 10 * 24) / 2);
  assert.equal(f.totals.p85CycleHours, 10 * 24);
  assert.deepEqual(f.distribution.map((b) => b.count), [0, 1, 1, 2, 0, 0]);
  assert.equal(f.weekly.reduce((n, w) => n + w.finished, 0), 4);
  assert.deepEqual(f.aging.map((a) => a.id), [10, 12, 11]);
  assert.deepEqual(f.aging.map((a) => [a.overMedian, a.overP85]), [[true, true], [false, false], [false, false]]);
  assert.deepEqual(f.states, ['Active', 'Resolved']);
  assert.equal(f.totals.wipOverP85, 1);
});

test('sprint scope: planned, added, taken out and carried over', () => {
  const iteration = { name: 'Sprint 42', path: 'P\\Sprint 42', startDate: at(6 * D), finishDate: at(-7 * D) };
  const items = [
    wi(1, { storyPoints: 3, stateCategory: 'Completed' }),
    wi(2, { storyPoints: 5, stateCategory: 'InProgress' }),
    wi(3, { storyPoints: 2, stateCategory: 'Proposed' }), // added after planning
    wi(9, { type: 'Task', stateCategory: 'Proposed' }),
  ];
  const s = buildSprintScope({
    project: { id: 'p', name: 'P' },
    team: { id: 't', name: 'T' },
    iteration,
    previous: { name: 'Sprint 41', path: 'P\\Sprint 41' },
    startIds: [1, 2, 4],
    prevOpenIds: [2, 4, 7],
    items,
    removed: [wi(4, { storyPoints: 8, stateCategory: 'Proposed' })],
    now: NOW,
  });
  assert.deepEqual(s.committed, { count: 3, points: 16, unestimated: 0 });
  assert.deepEqual(s.current, { count: 3, points: 10, unestimated: 0 });
  assert.deepEqual(s.completed, { count: 1, points: 3, unestimated: 0 });
  assert.deepEqual(s.added.map((w) => w.id), [3]);
  assert.deepEqual(s.removed.map((w) => w.id), [4]);
  assert.deepEqual(s.carriedOver.map((w) => w.id), [2, 4]);
  assert.deepEqual([s.iteration.day, s.iteration.days], [7, 14]);
});
