import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bands, buildDelivery, weekOf } from '../server/domain/delivery.js';
import { buildSummary, weekRange } from '../server/domain/summary.js';
import { targetKeyOf } from '../server/domain/production.js';

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.parse('2026-10-17T12:00:00Z'); // a Saturday
const at = (msAgo) => new Date(NOW - msAgo).toISOString();

test('delivery: DORA measures from deploy history', () => {
  const targets = [
    {
      key: 'release:p:1:Production',
      name: 'Shop',
      projectName: 'Commerce',
      // Newest first: a failure recovered 6h later by the next good deploy.
      deploys: [
        { id: 4, at: at(1 * D), status: 'succeeded', leadTimes: [10, 30] },
        { id: 3, at: at(1 * D + 6 * H), status: 'failed' },
        { id: 2, at: at(5 * D), status: 'succeeded', leadTimes: [20] },
        { id: 1, at: at(40 * D), status: 'succeeded', leadTimes: [999] }, // outside 30 days
      ],
    },
    { key: 'pipeline:p:9', name: 'API', projectName: 'Platform', deploys: [{ id: 7, at: at(2 * D), status: 'partiallySucceeded' }] },
  ];
  const d = buildDelivery({ targets, days: 30, now: NOW });
  assert.equal(d.totals.deploys, 2);
  assert.equal(d.totals.failed, 2);
  assert.equal(d.totals.failureRate, 0.5);
  assert.equal(d.totals.medianLeadTimeHours, 20);
  assert.equal(d.totals.medianRecoveryHours, 6);
  assert.ok(Math.abs(d.totals.deploysPerWeek - 2 * 7 / 30) < 1e-9);
  assert.deepEqual(d.bands, { frequency: 'medium', leadTime: 'elite', failureRate: 'low', recovery: 'high' }); // 2 deploys in 30 days is less than weekly

  const shop = d.targets.find((x) => x.name === 'Shop');
  assert.deepEqual([shop.deploys, shop.failed, shop.unrecovered, shop.lastDeploy.id], [2, 1, 0, 4]);
  const api = d.targets.find((x) => x.name === 'API');
  assert.equal(api.unrecovered, 1, 'a failure with no good deploy after it is still failing');
  assert.equal(d.weekly.reduce((n, w) => n + w.deploys, 0), 2);
  assert.equal(d.weekly.reduce((n, w) => n + w.failed, 0), 2);
});

test('delivery: no environments, bands and keys', () => {
  const empty = buildDelivery({ targets: [], days: 30, now: NOW });
  assert.equal(empty.totals.deploysPerWeek, null);
  assert.deepEqual(empty.bands, { frequency: null, leadTime: null, failureRate: null, recovery: null });
  assert.equal(bands.frequency(2), 'elite');
  assert.equal(bands.frequency(1 / 60), 'low');
  assert.equal(bands.leadTime(24 * 40), 'low');
  assert.equal(bands.failureRate(0.05), 'elite');
  assert.equal(bands.recovery(0.5), 'elite');
  assert.equal(weekOf(NOW), '2026-10-12');
  assert.equal(targetKeyOf({ type: 'release', projectId: 'p', definitionId: 3, stage: 'Prod' }), 'release:p:3:Prod');
  assert.equal(targetKeyOf({ type: 'pipeline', projectId: 'p', definitionId: 9 }), 'pipeline:p:9');
  assert.equal(targetKeyOf(null), null);
});

test('summary: one week of finished work, merges and deploys', () => {
  const range = weekRange('2026-10-14', NOW); // any day picks its week
  assert.equal(range.week, '2026-10-12');
  assert.equal(weekRange('nonsense', NOW).week, '2026-10-12');

  const w = (id, type, closedAt, extra = {}) => ({ id, type, title: `Item ${id}`, state: 'Done', stateCategory: 'Completed', projectName: 'Commerce', closedAt, assignedTo: { displayName: 'Ana' }, ...extra });
  const s = buildSummary({
    ...range,
    now: NOW,
    finished: [
      w(1, 'User Story', '2026-10-13T09:00:00Z'),
      w(2, 'Bug', '2026-10-15T09:00:00Z'),
      w(3, 'Task', '2026-10-15T09:00:00Z'), // tasks aren't news
      w(4, 'User Story', '2026-10-09T09:00:00Z'), // the week before
      w(5, 'Feature', null, { stateChangedAt: '2026-10-16T09:00:00Z' }), // no Closed Date: when it entered Done
    ],
    merged: [
      { status: 'completed', closedAt: '2026-10-13T10:00:00Z', projectName: 'Commerce', repoName: 'web' },
      { status: 'completed', closedAt: '2026-10-14T10:00:00Z', projectName: 'Commerce', repoName: 'web' },
      { status: 'abandoned', closedAt: '2026-10-14T10:00:00Z', projectName: 'Commerce', repoName: 'web' },
    ],
    deploys: [
      { target: 'Shop', label: 'Release-9', at: '2026-10-16T10:00:00Z', status: 'succeeded' },
      { target: 'Shop', label: 'Release-8', at: '2026-10-15T10:00:00Z', status: 'failed' },
      { target: 'Shop', label: 'Release-7', at: '2026-10-01T10:00:00Z', status: 'succeeded' },
    ],
    blocked: [w(9, 'Bug', null, { stateCategory: 'InProgress' })],
    inProgress: 4,
  });
  assert.ok(s.current);
  assert.deepEqual(s.totals, { finished: 3, features: 2, bugs: 1, merged: 2, deploys: 1, failedDeploys: 1, blocked: 1, inProgress: 4 });
  assert.deepEqual(s.features.map((x) => x.id), [1, 5]);
  assert.deepEqual(s.bugs.map((x) => x.id), [2]);
  assert.deepEqual(s.mergedByRepo, [{ projectName: 'Commerce', repoName: 'web', count: 2 }]);
  assert.deepEqual(s.deploys.map((x) => x.label), ['Release-9', 'Release-8']);
  assert.equal(s.features[0].assignedTo, 'Ana');
});
