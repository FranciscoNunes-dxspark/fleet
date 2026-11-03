import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESK_QUEUES, buildTimeline, deskQueues, monitorIdOf, serviceTiles } from '../client/src/line/views.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const hoursAgo = (n) => new Date(NOW - n * 36e5).toISOString();

const item = (key, kind, severity = 'medium') => ({ key, kind, severity, reasons: [] });

test('the Desk has eight queues, numbered for the keys 1–8, Act now first and Everything last', () => {
  assert.equal(DESK_QUEUES.length, 8);
  assert.equal(DESK_QUEUES[0].id, 'now');
  assert.equal(DESK_QUEUES.at(-1).id, 'all');
});

test('each queue keeps the Inbox order; Broken holds production and pipelines together', () => {
  const items = [
    item('a', 'review', 'high'), item('b', 'production', 'high'), item('c', 'pipeline'),
    item('d', 'pr', 'low'), item('e', 'approval', 'high'), item('f', 'team', 'low'),
  ];
  const q = Object.fromEntries(deskQueues(items).map((x) => [x.id, x]));
  assert.deepEqual(q.now.items.map((i) => i.key), ['a', 'b', 'e']);
  assert.deepEqual(q.broken.items.map((i) => i.key), ['b', 'c']);
  assert.equal(q.broken.high, 1);
  assert.equal(q.all.count, 6);
  assert.equal(q.work.count, 0);
});

test('a production entry names its monitor; other kinds name none', () => {
  assert.equal(monitorIdOf({ kind: 'production', key: 'prod:m-1:failures,down' }), 'm-1');
  assert.equal(monitorIdOf({ kind: 'pr', key: 'pr:1' }), null);
});

test('service tiles: down first, the last day of checks, the latest deploy and what waits to ship', () => {
  const tiles = serviceTiles({
    production: { monitors: [
      { id: 'a', name: 'Alpha', state: 'up', last: { ms: 120.6 }, uptime24h: 1, targetKey: 't1',
        history: [{ at: hoursAgo(30), ok: true, ms: 1 }, { at: hoursAgo(2), ok: false, ms: 900 }],
        markers: [{ label: 'Release-9', at: hoursAgo(3), by: 'Ana' }] },
      { id: 'b', name: 'Beta', state: 'down' },
    ] },
    pending: { targets: [{ key: 't1', waiting: 4, oldestAt: hoursAgo(50), lastDeploy: { label: 'Release-8', at: hoursAgo(40) } }] },
  }, NOW);
  assert.deepEqual(tiles.map((x) => x.id), ['b', 'a']);
  const a = tiles[1];
  assert.equal(a.latency, 121);
  assert.deepEqual(a.checks, [{ ok: false, ms: 900 }]);
  assert.equal(a.lastDeploy.label, 'Release-9');
  assert.equal(a.waiting, 4);
});

test('the timeline: the last day only, newest first, each deploy once, merges but not abandoned pull requests', () => {
  const events = buildTimeline({
    pipelines: [{ key: 'p', definition: { name: 'ci' }, recent: [
      { id: 1, result: 'failed', finishedAt: hoursAgo(1), buildNumber: '1.1' },
      { id: 2, result: 'succeeded', finishedAt: hoursAgo(30), buildNumber: '1.0' },
    ] }],
    production: { monitors: [{ id: 'm', name: 'Shop', targetKey: 't', downSince: hoursAgo(0.5), markers: [{ label: 'R-2', at: hoursAgo(5) }] }] },
    pending: { targets: [{ key: 't', name: 'Shop release', lastDeploy: { label: 'R-2', at: hoursAgo(5) } }] },
    approvals: [{ key: 'x', pipeline: 'Shop release', stage: 'Prod', createdOn: hoursAgo(2), canDecide: true }],
    closed: { prs: [
      { key: 'k1', id: 1, title: 'Merged one', status: 'completed', closedAt: hoursAgo(3) },
      { key: 'k2', id: 2, title: 'Dropped', status: 'abandoned', closedAt: hoursAgo(3) },
    ] },
  }, NOW);
  assert.deepEqual(events.map((e) => e.code), ['down', 'run', 'approval', 'merged', 'deploy']);
  assert.equal(events.find((e) => e.code === 'run').tone, 'bad');
  assert.equal(events.find((e) => e.code === 'approval').mine, true);
  assert.equal(events.filter((e) => e.code === 'deploy').length, 1);
});

test('a service tile carries the database figures only when the monitor has them', () => {
  const m = (ai) => ({ id: 'a', name: 'A', state: 'up', ai });
  const [withDb] = serviceTiles({ production: { monitors: [m({ db: { p95: 40, failRate: 0.02, calls: 90 } })] } });
  assert.deepEqual(withDb.db, { p95: 40, failRate: 0.02, calls: 90 });
  const [without] = serviceTiles({ production: { monitors: [m({})] } });
  assert.equal(without.db, null);
});
