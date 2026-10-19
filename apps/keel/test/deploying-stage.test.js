import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentStage } from '../server/domain/pipelines.js';
import { deployUnderWay, evaluateMonitor, runningDeploy } from '../server/domain/production.js';

const MIN = 60_000;
const now = Date.parse('2026-10-19T12:00:00Z');
const ago = (m) => new Date(now - m * MIN).toISOString();
const mv = { type: 'Task', task: { id: '2003ad3a-104a-451a-9238-60474ab294e6', name: 'ManualValidation' } };

// A release pipeline like build 18490: CHECK (Manual validation), then a stage per site.
const timeline = (phase) => [
  { id: 'check', parentId: null, type: 'Stage', name: 'CHECK', state: phase === 'waiting' ? 'inProgress' : 'completed', result: phase === 'waiting' ? null : 'succeeded', startedAt: ago(180) },
  { id: 'job', parentId: 'check', type: 'Job', name: 'Wait for external validation', state: phase === 'waiting' ? 'inProgress' : 'completed', startedAt: ago(180) },
  { id: 'mv', parentId: 'job', ...mv, name: 'ManualValidation', state: phase === 'waiting' ? 'inProgress' : 'completed', result: phase === 'waiting' ? null : 'succeeded', startedAt: ago(180) },
  { id: 'europe', parentId: null, type: 'Stage', name: 'AzureEUROPE', state: phase === 'deploying' ? 'inProgress' : 'pending', startedAt: phase === 'deploying' ? ago(5) : null },
  { id: 'deploy', parentId: 'europe', type: 'Job', name: 'Deploy', state: phase === 'deploying' ? 'inProgress' : 'pending', startedAt: phase === 'deploying' ? ago(5) : null },
];

test('the stage a run is on: waiting at a Manual validation, or deploying since the stage began', () => {
  assert.deepEqual(currentStage(timeline('waiting')), { name: 'CHECK', startedAt: ago(180), waiting: true });
  assert.deepEqual(currentStage(timeline('deploying')), { name: 'AzureEUROPE', startedAt: ago(5), waiting: false });
  assert.equal(currentStage([]), null);
  // Waiting at a stage's checks (an environment approval): the stage hasn't started.
  assert.equal(currentStage([{ id: 's', type: 'Stage', name: 'Prod', state: 'inProgress', startedAt: null }, { id: 'c', parentId: 's', type: 'Checkpoint', state: 'inProgress' }]).waiting, true);
});

test('a release run that waited hours for its validation is still "deploying" while its stage runs', () => {
  const link = { type: 'pipeline', projectId: 'p1', definitionId: 9 };
  const run = (phase) => ({
    id: 18490, projectId: 'p1', definition: { id: 9 }, buildNumber: '20261019.3', status: 'inProgress', reason: 'manual', sourceBranch: 'master',
    startedAt: ago(180), queuedAt: ago(181), stage: currentStage(timeline(phase)),
  });
  const down = { url: 'https://x', latencyWarnMs: 1000, ai: null, aiError: null, link, last: { ok: false, error: 'HTTP 503', at: ago(0) }, consecutiveFailures: 4, downSince: ago(4) };
  const sources = (phase) => ({ pipelines: [{ projectId: 'p1', definition: { id: 9 }, branch: 'master' }], builds: [run(phase)] });

  // Deploying (its stage began 5 minutes ago, the run 3 hours ago): the outage is expected.
  const deploying = runningDeploy({ link }, sources('deploying'), now);
  assert.equal(deploying.startedAt, ago(5));
  assert.equal(evaluateMonitor(down, [], now, deploying).state, 'deploying');

  // Waiting for someone to validate: nothing is deploying, so a site that's down is down.
  const waiting = runningDeploy({ link }, sources('waiting'), now);
  assert.equal(waiting, null);
  assert.equal(evaluateMonitor(down, [], now, waiting).state, 'down');

  // Waiting to ship says it's waiting for approval.
  const target = { type: 'pipeline', projectId: 'p1', definitionId: 9, branch: 'master' };
  assert.equal(deployUnderWay(target, { builds: [run('waiting')] }, { now }).state, 'approval');
  assert.equal(deployUnderWay(target, { builds: [run('deploying')] }, { now }).state, 'deploying');
});
