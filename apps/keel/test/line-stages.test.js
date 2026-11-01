import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, buildLine, stageTone, trackTones } from '../client/src/line/stages.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 864e5).toISOString();
const stage = (line, id) => line.find((s) => s.id === id);

const wi = (over = {}) => ({
  id: 1, type: 'User Story', title: 'Story', projectName: 'Commerce', stateCategory: 'Proposed', priority: 2,
  createdAt: daysAgo(1), changedAt: daysAgo(1), ...over,
});
const pr = (over = {}) => ({
  key: 'r1:1', id: 1, title: 'PR', projectId: 'p', repoId: 'r1', repoName: 'web', status: 'active',
  createdAt: daysAgo(1), reviewState: 'in-review', hasConflicts: false, needsMyReview: false, ...over,
});

test('every stage is there, in the order change moves, even with nothing loaded', () => {
  const line = buildLine({}, NOW);
  assert.deepEqual(line.map((s) => s.id), STAGES);
  assert.ok(line.every((s) => s.count === 0 && s.tone === null));
});

test('work items go to Planned or Building by state category, never by state name', () => {
  const line = buildLine({ workitems: { items: [
    wi({ id: 1, state: 'Doing', stateCategory: 'Proposed' }),
    wi({ id: 2, state: 'New', stateCategory: 'InProgress', activatedAt: daysAgo(2) }),
    wi({ id: 3, stateCategory: 'Resolved' }),
    wi({ id: 4, stateCategory: 'Completed' }),
    wi({ id: 5, type: 'Task', stateCategory: 'InProgress' }),
  ] } }, NOW);
  assert.deepEqual(stage(line, 'planned').cards.map((c) => c.open.id), [1]);
  assert.deepEqual(stage(line, 'building').cards.map((c) => c.open.id).sort(), [2, 3]);
});

test('a P1 left unstarted, a blocked item and a quiet one are stuck, most stuck first', () => {
  const line = buildLine({ workitems: { items: [
    wi({ id: 1, priority: 1, createdAt: daysAgo(3) }),
    wi({ id: 2, priority: 1, createdAt: daysAgo(1) }),
    wi({ id: 3, stateCategory: 'InProgress', changedAt: daysAgo(6) }),
    wi({ id: 4, stateCategory: 'InProgress', blocked: true }),
  ] } }, NOW);
  const planned = stage(line, 'planned').cards;
  assert.equal(planned[0].open.id, 1);
  assert.deepEqual(planned[0].reason, { code: 'p1-waiting', days: 3 });
  assert.equal(planned[1].stuck, null);
  assert.deepEqual(stage(line, 'building').cards.map((c) => [c.open.id, c.stuck]), [[4, 'bad'], [3, 'warn']]);
});

test('pull requests: conflicts and rejections are stuck, old ones go amber, reviews waiting on you are yours', () => {
  const line = buildLine({ prs: { prs: [
    pr({ key: 'a', id: 1 }),
    pr({ key: 'b', id: 2, hasConflicts: true }),
    pr({ key: 'c', id: 3, createdAt: daysAgo(6) }),
    pr({ key: 'd', id: 4, needsMyReview: true }),
    pr({ key: 'e', id: 5, status: 'completed' }),
  ] } }, NOW);
  const cards = stage(line, 'review').cards;
  assert.deepEqual(cards.map((c) => c.open.id), [2, 3, 4, 1]);
  assert.equal(cards.find((c) => c.open.id === 4).mine, true);
});

test('Merged holds only targets with changes waiting; Deploying holds approvals, deploys under way and red pipelines', () => {
  const line = buildLine({
    pending: { targets: [
      { key: 't1', name: 'Storefront', waiting: 8, oldestAt: daysAgo(8), deploy: { state: 'running', label: 'Release-9', startedAt: daysAgo(0.01) } },
      { key: 't2', name: 'Identity', waiting: 0, deploy: { state: 'approval', label: 'Release-3' } },
    ] },
    approvals: [{ key: 'a1', pipeline: 'Storefront release', stage: 'Production', createdOn: daysAgo(0.2), canDecide: true }],
    pipelines: [
      { key: 'p1', definition: { name: 'ci' }, health: 'failing', failStreak: 3, lastGreenAt: daysAgo(2), running: [], recent: [] },
      { key: 'p2', definition: { name: 'ok' }, health: 'healthy', running: [] },
    ],
  }, NOW);
  const merged = stage(line, 'merged').cards;
  assert.equal(merged.length, 1);
  assert.equal(merged[0].stuck, 'bad');
  assert.deepEqual(stage(line, 'deploying').cards.map((c) => c.kind), ['pipeline', 'approval', 'deploy']);
  assert.equal(stage(line, 'deploying').cards.find((c) => c.kind === 'approval').mine, true);
});

test('a stage goes amber from a quarter stuck and red from half; production on any one app', () => {
  assert.equal(stageTone('review', 10, 0, 2), null);
  assert.equal(stageTone('review', 10, 0, 5), 'warn');
  assert.equal(stageTone('review', 10, 5, 0), 'bad');
  assert.equal(stageTone('live', 10, 0, 1), 'warn');
  assert.equal(stageTone('live', 10, 1, 0), 'bad');
  assert.equal(stageTone('planned', 0, 0, 0), null);
});

test('each track takes the tone of the stage it leads into, and an empty stage leaves it idle', () => {
  const stages = [
    { count: 3, tone: 'bad' }, { count: 2, tone: null }, { count: 0, tone: null }, { count: 4, tone: 'warn' },
  ];
  assert.deepEqual(trackTones(stages), ['ok', 'idle', 'warn']);
});

test("a project's own limits win over the defaults, which win over Keel's", () => {
  const prs = { prs: [pr({ key: 'a', id: 1, projectId: 'p1', createdAt: daysAgo(4) }), pr({ key: 'b', id: 2, projectId: 'p2', createdAt: daysAgo(4) })] };
  const line = buildLine({ prs }, NOW, { limits: { default: { stalePrDays: 3 }, projects: { p2: { stalePrDays: 10, shipBadDays: null } } } });
  const byId = Object.fromEntries(stage(line, 'review').cards.map((c) => [c.open.id, c.stuck]));
  assert.deepEqual(byId, { 1: 'warn', 2: null });
});

test("a project's backlog level decides which work items are on the line", () => {
  const items = [
    wi({ id: 1, type: 'Product Backlog Item', projectId: 'p' }), wi({ id: 2, type: 'Bug', projectId: 'p' }),
    wi({ id: 3, type: 'Issue', projectId: 'p' }), wi({ id: 4, type: 'Task', projectId: 'q' }), wi({ id: 5, type: 'Issue', projectId: 'q' }),
  ];
  const line = buildLine({ workitems: { items } }, NOW, { levels: { p: ['Product Backlog Item', 'Bug'] } });
  // p by its level; q (no level known) by the fallback, which only leaves out tasks and portfolio items.
  assert.deepEqual(stage(line, 'planned').cards.map((c) => c.open.id).sort(), [1, 2, 5]);
});

test('approval and red pipeline cards carry what acting on them needs', () => {
  const line = buildLine({
    approvals: [{ key: 'k', kind: 'release', id: 9, pipeline: 'Shop', stage: 'Prod', createdOn: daysAgo(0.1), canDecide: true }],
    pipelines: [{ key: 'p', projectId: 'pp', definition: { id: 4, name: 'ci' }, branch: 'main', health: 'failing', failStreak: 2, running: [], recent: [] }],
  }, NOW);
  const cards = stage(line, 'deploying').cards;
  assert.deepEqual(cards.find((c) => c.kind === 'approval').approval, { kind: 'release', id: 9, org: undefined, canDecide: true });
  assert.deepEqual(cards.find((c) => c.kind === 'pipeline').rerun, { projectId: 'pp', definitionId: 4, branch: 'main' });
});
