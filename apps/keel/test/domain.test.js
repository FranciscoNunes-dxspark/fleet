import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichPR, median } from '../server/domain/prs.js';
import { buildAttention } from '../server/domain/attention.js';
import { pipelineHealth } from '../server/domain/pipelines.js';
import { buildInsights } from '../server/domain/insights.js';
import { buildChangelog } from '../server/domain/changelog.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const H = 3_600_000;
const me = { id: 'me', displayName: 'Me', uniqueName: 'me@x.com' };
const dev = { id: 'd1', displayName: 'Dev', uniqueName: 'dev@x.com' };
const ago = (h) => new Date(NOW - h * H).toISOString();

const pr = (over = {}) => ({
  key: 'p/r/1', id: 1, title: 'PR', projectId: 'p', projectName: 'P', repoId: 'r', repoName: 'repo',
  author: dev, createdAt: ago(2), closedAt: null, status: 'active', isDraft: false, mergeStatus: 'succeeded',
  sourceBranch: 'feature/x', targetBranch: 'main', reviewers: [], labels: [], autoComplete: false, webUrl: '', ...over,
});
const rv = (who, vote = 0, isRequired = false) => ({ ...who, vote, isRequired, isContainer: false });

test('enrichPR flags a PR waiting on my vote', () => {
  const p = enrichPR(pr({ reviewers: [rv(me, 0), rv(dev, 10)] }), me, NOW);
  assert.equal(p.needsMyReview, true);
  assert.equal(p.approvals, 1);
  // One optional approval and no required reviewer pending counts as approved.
  assert.equal(p.reviewState, 'approved');
});

test('enrichPR: approved when no required reviewer is pending', () => {
  const p = enrichPR(pr({ reviewers: [rv(me, 10, true)] }), me, NOW);
  assert.equal(p.reviewState, 'approved');
  assert.equal(p.readyToMerge, true);
  const blocked = enrichPR(pr({ reviewers: [rv(me, 10), rv(dev, 0, true)] }), me, NOW);
  assert.equal(blocked.reviewState, 'in-review');
});

test('enrichPR: rejection and drafts', () => {
  assert.equal(enrichPR(pr({ reviewers: [rv(me, -10)] }), me, NOW).reviewState, 'rejected');
  const draft = enrichPR(pr({ isDraft: true, reviewers: [rv(me, 0)] }), me, NOW);
  assert.equal(draft.reviewState, 'draft');
  assert.equal(draft.needsMyReview, false);
});

test('a pull request goes publish, approval, complete; each step says what it waits on', () => {
  const flow = (over) => enrichPR(pr(over), me, NOW).flow;
  assert.deepEqual(flow({ isDraft: true, reviewers: [rv(dev, 0)] }), { step: 'publish', waiting: null });
  assert.deepEqual(flow({}), { step: 'approval', waiting: { kind: 'no-reviewers' } });
  assert.deepEqual(flow({ reviewers: [rv(dev, 0)] }), { step: 'approval', waiting: { kind: 'approval' } });
  assert.deepEqual(flow({ reviewers: [rv(me, 10), rv(dev, 0, true)] }), { step: 'approval', waiting: { kind: 'required', names: ['Dev'] } });
  assert.deepEqual(flow({ reviewers: [rv(me, 10), rv(dev, -5)] }), { step: 'approval', waiting: { kind: 'waiting-author', names: ['Dev'] } });
  assert.deepEqual(flow({ reviewers: [rv(dev, -10)] }), { step: 'approval', waiting: { kind: 'rejected', names: ['Dev'] } });
  // Approved: on to completing, which conflicts, blocking policies and auto-complete speak to.
  assert.deepEqual(flow({ reviewers: [rv(dev, 10)] }), { step: 'complete', waiting: null });
  assert.deepEqual(flow({ reviewers: [rv(dev, 10)], mergeStatus: 'conflicts' }), { step: 'complete', waiting: { kind: 'conflicts' } });
  const policies = [{ name: 'Build', status: 'running', isBlocking: true }, { name: 'Lint', status: 'rejected', isBlocking: false }];
  assert.deepEqual(flow({ reviewers: [rv(dev, 10)], policies }), { step: 'complete', waiting: { kind: 'policies', names: ['Build'] } });
  assert.deepEqual(flow({ reviewers: [rv(dev, 10)], autoComplete: true }), { step: 'complete', waiting: { kind: 'auto' } });
  assert.equal(flow({ status: 'completed' }).step, 'done');
  assert.equal(flow({ status: 'abandoned' }).step, 'closed');
});

test("on GitHub: a branch that needs no review skips approval, and your own pull request waits on someone else's", () => {
  const flow = (over, who = me) => enrichPR(pr(over), who, NOW).flow;
  // No review required: straight to merging, unless someone asked for changes.
  assert.deepEqual(flow({ reviewRequired: false }), { step: 'complete', approval: 'not-required', waiting: null });
  assert.deepEqual(flow({ reviewRequired: false, reviewers: [rv(dev, -5)] }), { step: 'approval', waiting: { kind: 'waiting-author', names: ['Dev'] } });
  // Required, and yours: GitHub won't take your approval.
  assert.deepEqual(flow({ reviewRequired: true, author: me }), { step: 'approval', own: true, waiting: { kind: 'no-reviewers' } });
  assert.deepEqual(flow({ reviewRequired: true, author: me, reviewers: [rv(dev, 0)] }), { step: 'approval', own: true, waiting: { kind: 'approval' } });
  assert.equal(flow({ reviewRequired: true, reviewers: [rv(dev, 0)] }).own, undefined, "someone else's: no note");
  // Azure DevOps pull requests carry no reviewRequired, and never skip approval.
  assert.equal(flow({}).step, 'approval');
});

test('attention escalates my review after the threshold and flags missing reviewers', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const prs = [
    enrichPR(pr({ key: 'a', reviewers: [rv(me, 0)], createdAt: ago(12) }), me, NOW),
    enrichPR(pr({ key: 'b', reviewers: [], createdAt: ago(1) }), me, NOW),
  ];
  const { items, summary } = buildAttention({ prs, items: [], pipelines: [], workload: [], settings, now: NOW });
  assert.equal(summary.myReviews, 1);
  const a = items.find((i) => i.key === 'pr:a');
  assert.equal(a.severity, 'high');
  assert.equal(a.kind, 'review');
  assert.ok(items.find((i) => i.key === 'pr:b').reasons.some((r) => r.code === 'no-reviewers'));
});

test('attention honours snoozes', () => {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), snoozed: { 'pr:b': new Date(NOW + 24 * H).toISOString() } };
  const prs = [enrichPR(pr({ key: 'b' }), me, NOW)];
  const res = buildAttention({ prs, items: [], pipelines: [], workload: [], settings, now: NOW });
  assert.equal(res.items.length, 0);
  assert.equal(res.snoozedCount, 1);
});

test('attention flags blocked items and unowned P1 bugs', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const base = { projectName: 'P', state: 'New', stateCategory: 'Proposed', tags: [], blocked: false, changedAt: ago(1), iterationPath: 'P', webUrl: '' };
  const items = [
    { ...base, id: 1, type: 'Bug', title: 'Crash', priority: 1, assignedTo: null },
    { ...base, id: 2, type: 'User Story', title: 'Story', priority: 2, assignedTo: dev, tags: ['Blocked'] },
  ];
  const res = buildAttention({ prs: [], items, pipelines: [], workload: [], settings, now: NOW });
  assert.deepEqual(res.items.map((i) => i.reasons[0].code).sort(), ['blocked', 'p1-unassigned']);
});

test('pipeline health ignores PR builds and judges the default branch', () => {
  const b = (id, result, branch, hoursAgo, reason = 'individualCI') => ({
    id, projectId: 'p', projectName: 'P', definition: { id: 7, name: 'ci' }, status: 'completed', result, reason,
    sourceBranch: branch, repoId: 'r', repoName: 'repo', startedAt: ago(hoursAgo + 0.2), finishedAt: ago(hoursAgo), webUrl: '',
  });
  const rows = pipelineHealth([
    b(1, 'succeeded', 'refs/pull/9/merge', 1, 'pullRequest'),
    b(2, 'failed', 'main', 2),
    b(3, 'failed', 'main', 3),
    b(4, 'succeeded', 'main', 4),
  ], [{ id: 'r', defaultBranch: 'main' }]);
  assert.equal(rows[0].health, 'failing');
  assert.equal(rows[0].failStreak, 2);
  assert.equal(rows[0].latest.id, 2);
});

test('insights computes cycle time and review load', () => {
  const closed = [
    pr({ key: '1', status: 'completed', createdAt: ago(30), closedAt: ago(20), reviewers: [rv(me, 10)] }),
    pr({ key: '2', status: 'completed', createdAt: ago(50), closedAt: ago(20), reviewers: [rv(me, 5)] }),
    pr({ key: '3', status: 'abandoned', createdAt: ago(50), closedAt: ago(10) }),
  ];
  const res = buildInsights({ closedPrs: closed, activePrs: [], pipelines: [], days: 14, now: NOW });
  assert.equal(res.totals.merged, 2);
  assert.equal(res.totals.abandoned, 1);
  assert.equal(res.totals.medianCycleHours, 20);
  assert.equal(res.byReviewer[0].count, 2);
  assert.equal(res.byRepo[0].count, 2);
});

test('changelog splits features and fixes and links work items', () => {
  const p = pr({ key: 'k', status: 'completed', closedAt: ago(5), webUrl: 'https://x/pr/1' });
  const out = buildChangelog({
    prs: [p],
    workItemsByPr: new Map([['k', [{ id: 10, type: 'User Story', title: 'Login' }, { id: 11, type: 'Bug', title: 'Crash' }, { id: 12, type: 'Task', title: 'Chore' }]]]),
    from: '2026-10-01', to: '2026-10-15',
  });
  assert.equal(out.features.length, 1);
  assert.equal(out.fixes.length, 1);
  assert.match(out.markdown, /AB#10/);
  assert.match(out.markdown, /\[!1\]\(https:\/\/x\/pr\/1\)/);
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test('a custom "Blocked" state counts as blocked, same as the tag', async () => {
  const { isBlocked } = await import('../server/domain/attention.js');
  const w = { state: 'Blocked', tags: [], blocked: false };
  assert.equal(isBlocked(w, 'Blocked'), true);
  assert.equal(isBlocked({ ...w, state: 'In Progress' }, 'Blocked'), false);
  assert.equal(isBlocked({ ...w, state: 'In Progress', tags: ['blocked'] }, 'Blocked'), true);
});

test('epic tree rolls up backlog progress through features, ignoring tasks', async () => {
  const { buildEpicTree } = await import('../server/domain/epics.js');
  const w = (id, type, stateCategory, extra = {}) => ({ id, type, title: `${type} ${id}`, state: stateCategory, stateCategory, tags: [], storyPoints: null, ...extra });
  const [epic] = buildEpicTree({
    roots: [1],
    links: [{ parent: 1, child: 2 }, { parent: 2, child: 3 }, { parent: 2, child: 4 }, { parent: 3, child: 5 }, { parent: 1, child: 6 }],
    items: [
      w(1, 'Epic', 'InProgress'), w(2, 'Feature', 'InProgress'),
      w(3, 'User Story', 'Completed', { storyPoints: 5 }), w(4, 'Bug', 'InProgress', { storyPoints: 2 }),
      w(5, 'Task', 'Proposed'), w(6, 'User Story', 'Proposed', { storyPoints: 3, state: 'Blocked' }),
    ],
    blockedTag: 'Blocked',
  });
  assert.deepEqual(
    { total: epic.rollup.total, done: epic.rollup.done, inProgress: epic.rollup.inProgress, points: epic.rollup.points, donePoints: epic.rollup.donePoints },
    { total: 3, done: 1, inProgress: 1, points: 10, donePoints: 5 },
  );
  assert.equal(epic.rollup.features, 1);
  assert.equal(epic.rollup.openBugs, 1);
  assert.equal(epic.rollup.blocked, 1);
  assert.equal(epic.children[0].item.type, 'Feature'); // containers sort first
});

test('PR title suggestion uses a single commit, else a readable branch name', async () => {
  const { suggestTitle } = await import('../server/service.js');
  assert.equal(suggestTitle('feature/foo', [{ message: 'Add invoice PDF export\n\nLonger body' }]), 'Add invoice PDF export');
  assert.equal(suggestTitle('feature/12345-add-login-throttling', [{ message: 'a' }, { message: 'b' }]), 'Add login throttling');
  assert.equal(suggestTitle('bugfix/coupon_double_apply', []), 'Coupon double apply');
  assert.equal(suggestTitle('feature/pbi/47293', []), 'feature/pbi/47293');
});

test('tasks directly under an epic or feature are shown and counted; tasks under a story are not', async () => {
  const { buildEpicTree } = await import('../server/domain/epics.js');
  const w = (id, type, stateCategory) => ({ id, type, title: type + ' ' + id, state: stateCategory, stateCategory, tags: [] });
  const [epic] = buildEpicTree({
    roots: [1],
    links: [{ parent: 1, child: 2 }, { parent: 1, child: 3 }, { parent: 1, child: 4 }, { parent: 4, child: 5 }],
    items: [w(1, 'Epic', 'InProgress'), w(2, 'Task', 'Completed'), w(3, 'Task', 'InProgress'), w(4, 'Product Backlog Item', 'Proposed'), w(5, 'Task', 'Completed')],
  });
  assert.equal(epic.children.length, 3);
  assert.deepEqual({ total: epic.rollup.total, done: epic.rollup.done, inProgress: epic.rollup.inProgress }, { total: 3, done: 1, inProgress: 1 });
});

test('pipeline home branch comes from automatic runs, not the repo default', async () => {
  const { homeBranch, pipelineHealth } = await import('../server/domain/pipelines.js');
  const run = (id, branch, reason, h, result = 'succeeded') => ({
    id, buildNumber: String(id), projectId: 'p', projectName: 'P', definition: { id: 1, name: 'PreProd Build' }, status: 'completed', result, reason,
    sourceBranch: branch, repoId: 'r', repoName: 'repo', queuedAt: ago(h + 0.2), startedAt: ago(h + 0.2), finishedAt: ago(h), webUrl: '',
  });
  const runs = [run(3, 'preprod', 'individualCI', 1), run(2, 'preprod', 'individualCI', 50), run(1, 'Develop', 'manual', 200)];
  assert.equal(homeBranch(runs, 'Develop'), 'preprod');
  const [row] = pipelineHealth([...runs, run(4, 'refs/pull/7/merge', 'pullRequest', 0.5, 'failed')], [{ id: 'r', defaultBranch: 'Develop' }]);
  assert.equal(row.branch, 'preprod');
  assert.equal(row.latest.id, 3); // health judged on preprod
  assert.equal(row.lastRun.id, 4); // last run is the newest of any kind
  assert.equal(row.health, 'healthy');
});

test('release stages show the latest finished deployment and anything in progress', async () => {
  const { stageSummary, releaseHealth } = await import('../server/domain/releases.js');
  const env = (definitionEnvironmentId, status) => ({ id: definitionEnvironmentId * 100, definitionEnvironmentId, status, at: ago(1) });
  const releases = [
    { id: 3, name: 'R3', envs: [env(1, 'succeeded'), env(2, 'inProgress'), env(3, 'notStarted')] },
    { id: 2, name: 'R2', envs: [env(1, 'succeeded'), env(2, 'rejected'), env(3, 'notStarted')] },
    { id: 1, name: 'R1', envs: [env(1, 'succeeded'), env(2, 'succeeded'), env(3, 'succeeded')] },
  ];
  const stages = stageSummary([{ id: 2, name: 'QA', rank: 2 }, { id: 1, name: 'Dev', rank: 1 }, { id: 3, name: 'Prod', rank: 3 }], releases);
  assert.deepEqual(stages.map((s) => s.name), ['Dev', 'QA', 'Prod']);
  assert.equal(stages[0].latest.releaseName, 'R3');
  assert.equal(stages[1].active.releaseName, 'R3');
  assert.equal(stages[1].latest.releaseName, 'R2');
  assert.equal(stages[2].latest.releaseName, 'R1');
  assert.equal(releaseHealth(stages), 'failing');
});

test('approvals you can act on are high-priority inbox items', async () => {
  const { buildAttention } = await import('../server/domain/attention.js');
  const settings = structuredClone(DEFAULT_SETTINGS);
  const approvals = [
    { key: 'yaml:1', kind: 'yaml', id: '1', projectName: 'P', pipeline: 'web-CI', stage: 'Prod', run: null, createdOn: ago(3), instructions: '', approvers: [], canDecide: true, forMe: false },
    { key: 'release:2', kind: 'release', id: 2, projectName: 'P', pipeline: 'Rel', stage: 'QA', run: null, createdOn: ago(3), instructions: '', approvers: [], canDecide: false, forMe: false },
  ];
  const res = buildAttention({ prs: [], items: [], pipelines: [], workload: [], settings, approvals, now: NOW });
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].severity, 'high');
  assert.equal(res.summary.approvals, 1);
});

test('change detection: baseline first, then only new high items, votes on my PRs and my finished runs', async () => {
  const { diffSnapshots, fingerprint } = await import('../server/domain/changes.js');
  const item = (key, severity = 'high', kind = 'review') => ({ key, kind, severity, title: key, reasons: [{ text: 'why' }], target: { type: 'pr', id: 1 } });
  const myPr = (votes) => ({ key: 'p/r/1', id: 1, title: 'Mine', projectId: 'p', repoId: 'r', status: 'active', reviewers: votes.map(([id, vote]) => ({ id, displayName: id, vote, isContainer: false })) });
  const run = (status, result, mine = true) => ({ id: 9, definition: { name: 'web-CI' }, status, result, buildNumber: '1', sourceBranch: 'main', webUrl: '', mine });
  const a = { attention: [item('old')], myPrs: [myPr([['ana', 0]])], runs: [run('inProgress', null)] };
  assert.deepEqual(diffSnapshots(null, a), []);
  const b = { attention: [item('old'), item('new'), item('meh', 'low', 'pr'), item('fresh-review', 'medium', 'review')], myPrs: [myPr([['ana', 10]])], runs: [run('completed', 'failed')] };
  const notes = diffSnapshots(a, b);
  assert.deepEqual(notes.map((n) => n.category).sort(), ['myPr', 'review', 'review', 'run']);
  assert.match(notes.find((n) => n.category === 'myPr').title, /ana approved/);
  assert.equal(notes.find((n) => n.category === 'run').severity, 'high');
  assert.notEqual(fingerprint(a), fingerprint(b));
  assert.equal(fingerprint(b), fingerprint(structuredClone(b)));
});

test('cards sit in their stored board column, else the first column their state maps to', async () => {
  const { placeOnBoard } = await import('../server/service.js');
  const board = {
    fields: { column: 'K.Column', done: 'K.Done', lane: 'K.Lane' },
    columns: [
      { name: 'New', columnType: 'incoming', stateMappings: { Improvement: 'New', PBI: 'New' } },
      { name: 'Analysis', columnType: 'inProgress', stateMappings: { Improvement: 'New', PBI: 'Approved' } },
      { name: 'Done', columnType: 'outgoing', stateMappings: { Improvement: 'Done', PBI: 'Done' } },
    ],
  };
  const w = (type, state, stateCategory, boardFields = {}) => ({ type, state, stateCategory, boardFields });
  assert.deepEqual(placeOnBoard(board, w('Improvement', 'New', 'Proposed', { 'K.Column': 'Analysis', 'K.Done': true, 'K.Lane': 'Expedite' })), { column: 'Analysis', done: true, lane: 'Expedite' });
  assert.equal(placeOnBoard(board, w('Improvement', 'New', 'Proposed')).column, 'New'); // never moved on the board
  assert.equal(placeOnBoard(board, w('PBI', 'Approved', 'Proposed')).column, 'Analysis');
  assert.equal(placeOnBoard(board, w('PBI', 'Approved', 'Proposed', { 'K.Column': 'Gone' })).column, 'Analysis'); // stale column name
  assert.equal(placeOnBoard(board, w('Other', 'Closed', 'Completed')).column, 'Done');
});

test('stored tokens are encrypted and tamper-evident', async () => {
  const crypto = await import('node:crypto');
  const { encrypt, decrypt } = await import('../server/auth.js');
  const key = crypto.randomBytes(32);
  const blob = encrypt(key, 'my-secret-token');
  assert.ok(!blob.includes('my-secret-token'));
  assert.notEqual(encrypt(key, 'my-secret-token'), blob); // random IV each time
  assert.equal(decrypt(key, blob), 'my-secret-token');
  const tampered = Buffer.from(blob, 'base64url');
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decrypt(key, tampered.toString('base64url')));
  assert.throws(() => decrypt(crypto.randomBytes(32), blob));
});

test('sign-in attempts are limited per IP and reset on success', async () => {
  const { createLimiter } = await import('../server/auth.js');
  const l = createLimiter({ max: 3, windowMs: 1000 });
  const t = 10_000;
  l.fail('a', t); l.fail('a', t + 1); 
  assert.equal(l.blockedFor('a', t + 2), 0);
  l.fail('a', t + 2);
  assert.ok(l.blockedFor('a', t + 3) > 0);
  assert.equal(l.blockedFor('b', t + 3), 0);
  assert.equal(l.blockedFor('a', t + 1500), 0); // window passed
  l.fail('a', t + 1500); l.reset('a');
  assert.equal(l.blockedFor('a', t + 1501), 0);
});

test('production verdicts: down, slow, failing, and a regression after a deploy', async () => {
  const { evaluateMonitor } = await import('../server/domain/production.js');
  const now = Date.parse('2026-10-15T12:00:00Z');
  const at = (h) => new Date(now - h * H).toISOString();
  const base = { url: 'https://x', latencyWarnMs: 1000, consecutiveFailures: 0, ai: null, aiError: null };
  assert.equal(evaluateMonitor({ ...base, last: { ok: true, ms: 200, at: at(0) } }, [], now).state, 'up');
  const down = evaluateMonitor({ ...base, last: { ok: false, error: 'HTTP 503', at: at(0) }, consecutiveFailures: 3, downSince: at(0.5) }, [], now);
  assert.equal(down.state, 'down');
  assert.match(down.issues[0].text, /Down for 30m: HTTP 503/);
  assert.equal(evaluateMonitor({ ...base, last: { ok: true, ms: 2500, at: at(0) } }, [], now).issues[0].code, 'slow');
  // 0.5% failures before the deploy 3h ago, 8% after.
  const series = [];
  for (let h = 9; h >= 0; h -= 0.5) series.push({ at: at(h), total: 100, failed: h > 3 ? 0.5 : 8 });
  const ai = { total: 200, failed: 16, failRate: 0.08, series };
  const r = evaluateMonitor({ ...base, last: { ok: true, ms: 200, at: at(0) }, ai }, [{ at: at(3), label: 'Release-9' }], now);
  assert.deepEqual(r.issues.map((i) => i.code), ['failures', 'deploy-regression']);
  assert.match(r.issues[1].text, /since Release-9 \(3h ago\)/);
  assert.equal(r.state, 'degraded');
});

test('just after a deploy, failed checks do not alert; after 10 minutes they do', async () => {
  const { evaluateMonitor } = await import('../server/domain/production.js');
  const now = Date.parse('2026-10-15T12:00:00Z');
  const min = (m) => new Date(now - m * 60_000).toISOString();
  const down = { url: 'https://x', latencyWarnMs: 1000, ai: null, aiError: null, last: { ok: false, error: 'HTTP 503', at: min(0) }, consecutiveFailures: 4, downSince: min(4) };

  const quiet = evaluateMonitor(down, [{ at: min(6), label: 'Release-12' }], now);
  assert.equal(quiet.state, 'settling');
  assert.deepEqual(quiet.issues.map((i) => [i.code, i.severity]), [['settling', 'low']], 'nothing for the inbox or notifications');
  assert.match(quiet.issues[0].text, /Deployed Release-12 6m ago/);

  // Still down 10 minutes on: an outage, counted from when it began.
  const late = evaluateMonitor({ ...down, downSince: min(11) }, [{ at: min(11), label: 'Release-12' }], now);
  assert.equal(late.state, 'down');
  assert.match(late.issues[0].text, /Down for 11m/);

  // Up after the deploy: just up.
  assert.equal(evaluateMonitor({ ...down, last: { ok: true, ms: 200, at: min(0) }, consecutiveFailures: 0 }, [{ at: min(2), label: 'Release-12' }], now).state, 'up');
});

test('deploy markers come from the linked release stage', async () => {
  const { deployMarkers } = await import('../server/domain/production.js');
  const releases = [{
    projectId: 'p', id: 7,
    releases: [
      { name: 'R3', webUrl: 'u3', stages: [{ name: 'QA', status: 'succeeded', at: ago(2) }, { name: 'Prod', status: 'notStarted', at: ago(2) }] },
      { name: 'R2', webUrl: 'u2', stages: [{ name: 'QA', status: 'succeeded', at: ago(30) }, { name: 'Prod', status: 'succeeded', at: ago(26) }] },
    ],
  }];
  // The week before the test's own now (the real clock would let R2 age out of it).
  const m = deployMarkers({ link: { type: 'release', projectId: 'p', definitionId: 7, stage: 'Prod' } }, { releases }, NOW - 7 * 24 * H);
  assert.deepEqual(m.map((d) => d.label), ['R2']);
});

test('a running deploy shows as deploying instead of down, but not forever', async () => {
  const { evaluateMonitor, runningDeploy } = await import('../server/domain/production.js');
  const now = Date.now();
  const stage = (over) => ({ name: 'Prod', status: 'inProgress', deploying: true, startedAt: new Date(now - 5 * 60_000).toISOString(), ...over });
  const releases = (s) => [{ projectId: 'p', id: 7, releases: [{ name: 'R4', webUrl: 'u4', stages: [s] }] }];
  const link = { type: 'release', projectId: 'p', definitionId: 7, stage: 'Prod' };

  const deploy = runningDeploy({ link }, { releases: releases(stage()) }, now);
  assert.equal(deploy.label, 'R4');
  // Waiting on an approval isn't deploying, and an hour-old deploy no longer hides an outage.
  assert.equal(runningDeploy({ link }, { releases: releases(stage({ deploying: false })) }, now), null);
  assert.equal(runningDeploy({ link }, { releases: releases(stage({ startedAt: new Date(now - 61 * 60_000).toISOString() })) }, now), null);

  const pipeline = { type: 'pipeline', projectId: 'p', definitionId: 3 };
  const builds = [{ projectId: 'p', definition: { id: 3 }, status: 'inProgress', reason: 'individualCI', sourceBranch: 'refs/heads/main', buildNumber: '20261016.2', startedAt: new Date(now - 60_000).toISOString() }];
  assert.equal(runningDeploy({ link: pipeline }, { builds, pipelines: [{ projectId: 'p', definition: { id: 3 }, branch: 'refs/heads/main' }] }, now).label, '20261016.2');

  const failing = { url: 'https://x', latencyWarnMs: 1000, last: { ok: false, error: 'HTTP 503', at: new Date(now).toISOString() }, consecutiveFailures: 5, downSince: new Date(now - 4 * 60_000).toISOString() };
  const v = evaluateMonitor(failing, [], now, deploy);
  assert.equal(v.state, 'deploying');
  assert.deepEqual(v.issues.map((i) => [i.code, i.severity]), [['deploying', 'low']]);
  assert.match(v.issues[0].text, /^Deploying R4, started 5m ago$/);
  assert.equal(evaluateMonitor(failing, [], now, null).state, 'down');
});

test('monitors refuse private and internal addresses', async () => {
  const { assertPublicUrl } = await import('../server/monitoring.js');
  for (const url of ['http://127.0.0.1/health', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data', 'http://192.168.1.10', 'http://[::1]/']) {
    await assert.rejects(assertPublicUrl(url), /private or internal/, url);
  }
  await assert.rejects(assertPublicUrl('ftp://example.com'), /http and https/);
  await assert.rejects(assertPublicUrl('https://user:pass@example.com'), /credentials/);
  const ok = await assertPublicUrl('https://8.8.8.8/');
  assert.equal(ok.hostname, '8.8.8.8');
  // An IPv6 address is checked as an address, not looked up in DNS (which fails for "[...]" on Linux).
  assert.equal((await assertPublicUrl('https://[2606:4700:4700::1111]/')).hostname, '[2606:4700:4700::1111]');
});

test('accounts: passwords, invites, roles and the last-admin rule', async () => {
  process.env.SESSION_SECRET ||= 'test-secret-for-unit-tests-0123456789abcdef';
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { createAccounts, verifyPassword, hashPassword, can } = await import('../server/accounts.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-acc-'));
  const acc = createAccounts(path.join(dir, 'users.json'));

  assert.ok(await verifyPassword('correct horse', await hashPassword('correct horse')));
  assert.ok(!(await verifyPassword('wrong', await hashPassword('correct horse'))));

  assert.equal(acc.needsSetup(), true);
  await assert.rejects(acc.createFirstAdmin({ email: 'lead@x.com', name: 'Lead', password: 'short' }), /10 characters/);
  const admin = await acc.createFirstAdmin({ email: 'Lead@X.com', name: 'Lead', password: 'a-long-password' });
  assert.equal(admin.email, 'lead@x.com');
  assert.equal(acc.needsSetup(), false);
  await assert.rejects(acc.createFirstAdmin({ email: 'x@x.com', password: 'another-long-one' }), /already set up/);

  // Invite a PM; the link works once.
  const { user, token } = acc.invite({ email: 'pm@x.com', name: 'Pat', role: 'pm' });
  assert.equal(user.status, 'invited');
  assert.equal(acc.peekLink(token).role, 'pm');
  await acc.acceptLink(token, { password: 'pm-password-123' });
  assert.throws(() => acc.peekLink(token), /invalid or has expired/);
  const pm = await acc.signIn('PM@x.com', 'pm-password-123');
  assert.equal(pm.role, 'pm');
  await assert.rejects(acc.signIn('pm@x.com', 'nope'), /incorrect/);
  await assert.rejects(acc.signIn('nobody@x.com', 'nope'), /incorrect/); // same message: no account probing

  // Roles: PMs can't act on pull requests; only admins manage users.
  assert.equal(can('pm', 'prs.write'), false);
  assert.equal(can('pm', 'approvals.decide'), true);
  assert.equal(can('developer', 'users.manage'), false);
  assert.equal(can('admin', 'users.manage'), true);

  // Never lose the last admin.
  assert.throws(() => acc.update(admin.id, { role: 'developer' }, admin.id), /at least one active admin/);
  assert.throws(() => acc.remove(admin.id, pm.id), /at least one active admin/);
  acc.update(pm.id, { disabled: true }, admin.id);
  await assert.rejects(acc.signIn('pm@x.com', 'pm-password-123'), /disabled/);

  // Tokens are stored encrypted.
  acc.setToken(admin.id, 'TOKENVALUE123', { id: 'azdo-1', displayName: 'Lead' });
  assert.ok(!fs.readFileSync(path.join(dir, 'users.json'), 'utf8').includes('TOKENVALUE123'));
  assert.equal(acc.tokenOf(admin.id), 'TOKENVALUE123');
  assert.equal(acc.get(admin.id).hasToken, true);
  assert.ok(!('pat' in acc.get(admin.id)) && !('passwordHash' in acc.get(admin.id)));
});

test('data folder: DATA_DIR, then outside Hostinger build folders, else ./data', async () => {
  const path = await import('node:path');
  const { dataDirFor } = await import('../server/config.js');
  const norm = (p) => p.split(path.sep).join('/');
  assert.equal(norm(dataDirFor('/srv/keel', {})), norm(path.join('/srv/keel', 'data')));
  assert.equal(norm(dataDirFor('/home/u1/domains/keel.x.com/hbuilds/versions/42/nodejs', {})), norm(path.join('/home/u1/domains/keel.x.com', 'keel-data')));
  assert.equal(norm(dataDirFor('/home/u1/domains/keel.x.com/hbuilds/current/nodejs', {})), norm(path.join('/home/u1/domains/keel.x.com', 'keel-data')));
  assert.equal(norm(dataDirFor('/srv/keel', { DATA_DIR: '/var/lib/keel' })), norm(path.resolve('/srv/keel', '/var/lib/keel')));
});

test('pipelines without recent runs still get a row, judged on nothing', async () => {
  const { pipelineHealth } = await import('../server/domain/pipelines.js');
  const defs = [
    { id: 7, name: 'api-CI', path: '\\', projectId: 'p1', projectName: 'P1', repoId: 'r1', repoName: 'api', defaultBranch: 'main', paused: false, lastRun: null, webUrl: 'u7' },
    { id: 8, name: 'web-CI', path: '\\', projectId: 'p1', projectName: 'P1', repoId: 'r2', repoName: 'web', defaultBranch: 'main', paused: true, lastRun: null, webUrl: 'u8' },
  ];
  const build = { id: 1, projectId: 'p1', projectName: 'P1', definition: { id: 7, name: 'api-CI', path: '\\' }, repoId: 'r1', repoName: 'api', status: 'completed', result: 'succeeded', reason: 'individualCI', sourceBranch: 'main', queuedAt: '2026-10-15T10:00:00Z', startedAt: '2026-10-15T10:01:00Z', finishedAt: '2026-10-15T10:09:00Z', webUrl: 'b1' };
  const rows = pipelineHealth([build], [{ id: 'r1', defaultBranch: 'main' }, { id: 'r2', defaultBranch: 'main' }], defs);
  assert.deepEqual(rows.map((r) => [r.definition.name, r.health]), [['api-CI', 'healthy'], ['web-CI', 'unknown']]);
  const idle = rows[1];
  assert.equal(idle.branch, 'main');
  assert.equal(idle.paused, true);
  assert.equal(idle.webUrl, 'u8');
  assert.deepEqual([idle.recent.length, idle.running.length, idle.passRate], [0, 0, null]);
});
