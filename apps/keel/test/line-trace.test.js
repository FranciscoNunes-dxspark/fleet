import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceChange, whereNow } from '../client/src/line/trace.js';

const pr = (over = {}) => ({ id: 7, title: 'Refunds', repoId: 'r', repoName: 'shop', projectId: 'p', targetBranch: 'refs/heads/main', status: 'completed', createdAt: '2026-10-01T10:00:00Z', closedAt: '2026-10-03T10:00:00Z', ...over });
const pipelines = [{ key: 'k', repoId: 'r', branch: 'main', definition: { name: 'shop-CI' }, recent: [
  { id: 1, result: 'failed', finishedAt: '2026-10-02T10:00:00Z', buildNumber: '1.1' },
  { id: 2, result: 'succeeded', finishedAt: '2026-10-03T11:00:00Z', buildNumber: '1.2' },
] }];
const target = (over = {}) => ({ key: 't', name: 'Shop (production)', repo: { id: 'r' }, branch: 'main', commits: [], lastDeploy: { label: 'R-9', at: '2026-10-04T09:00:00Z' }, ...over });
const codes = (steps) => steps.map((s) => `${s.stage}:${s.code}:${s.state}`);

test('a work item all the way to production: built by the first run after the merge, deployed after it, and the app now', () => {
  const steps = traceChange({
    workItem: { createdAt: '2026-09-30T00:00:00Z', activatedAt: '2026-10-01T00:00:00Z', stateCategory: 'Resolved' },
    prs: [pr()], pipelines, targets: [target()], monitors: [{ targetKey: 't', name: 'Shop', state: 'degraded' }],
  });
  assert.deepEqual(codes(steps), [
    'planned:created:done', 'building:started:done', 'review:pr-reviewed:done', 'merged:merged:done',
    'deploying:built:done', 'deploying:deployed:done', 'live:monitor-degraded:bad',
  ]);
  assert.equal(steps.find((s) => s.code === 'built').label, '1.2');
  assert.equal(whereNow(steps), 'live');
});

test('merged but still among the changes a target waits to ship: waiting, and that is where it is now', () => {
  const steps = traceChange({ prs: [pr()], pipelines, targets: [target({ commits: [{ prId: 7 }], lastDeploy: { label: 'R-9', at: '2026-10-05T00:00:00Z' } })] });
  assert.ok(codes(steps).includes('merged:waiting:now'));
  assert.equal(whereNow(steps), 'merged');
});

test('an open pull request, an abandoned one, and a work item with none', () => {
  assert.deepEqual(codes(traceChange({ prs: [pr({ status: 'active', closedAt: null })] })), ['review:pr-open:now', 'merged:not-merged:todo']);
  assert.deepEqual(codes(traceChange({ prs: [pr({ status: 'abandoned' })] })), ['review:pr-abandoned:bad']);
  assert.deepEqual(codes(traceChange({ workItem: { createdAt: '2026-10-01T00:00:00Z', stateCategory: 'Proposed' } })), ['planned:created:done', 'building:not-started:todo', 'review:no-prs:todo']);
});

test("when a pipeline's listed runs don't reach back to the merge, it only says it was built since", () => {
  const old = [{ key: 'k', repoId: 'r', branch: 'main', definition: { name: 'shop-CI' }, recent: [{ id: 3, result: 'succeeded', finishedAt: '2026-10-20T10:00:00Z', buildNumber: '1.9' }] }];
  const steps = traceChange({ prs: [pr()], pipelines: old, targets: [] });
  assert.ok(steps.some((s) => s.code === 'built-since' && s.pipeline === 'shop-CI'));
  assert.ok(!steps.some((s) => s.code === 'built'));
});

test('with a Development branch, a pull request into it is waiting while the production branch lacks it, then live', () => {
  const dev = (commits) => target({ devBranch: 'develop', branch: 'main', commits, lastDeploy: { label: 'R-1', at: '2026-09-01T00:00:00Z' } });
  const into = pr({ targetBranch: 'refs/heads/develop' });
  const waiting = traceChange({ prs: [into], targets: [dev([{ prId: 7 }])] });
  assert.ok(codes(waiting).includes('merged:waiting:now'));
  assert.equal(whereNow(waiting), 'merged');
  // Off the waiting list means on main: live, whatever the last deploy's date says.
  const live = traceChange({ prs: [into], targets: [dev([])], monitors: [{ targetKey: 't', name: 'Shop', state: 'up' }] });
  assert.ok(codes(live).includes('deploying:on-production-branch:done'));
  assert.ok(codes(live).includes('live:monitor-up:done'));
  assert.equal(whereNow(live), 'live');
});
