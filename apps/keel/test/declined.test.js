import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pipelineHealth, wasDeclined } from '../server/domain/pipelines.js';
import { stageSummary, releaseHealth } from '../server/domain/releases.js';
import { createService } from '../server/service.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';

const H = 3_600_000;
const at = (h) => new Date(Date.now() - h * H).toISOString();
const rec = (type, result, extra = {}) => ({ id: `${type}-${result}`, type, state: 'completed', result, ...extra });

test('declined: failed only because the approval was not given', () => {
  const declined = [rec('Stage', 'failed'), rec('Checkpoint', 'failed'), rec('Checkpoint.Approval', 'failed'), rec('Job', 'skipped'), rec('Task', 'skipped')];
  assert.equal(wasDeclined(declined), true);
  // The approval was given, or there was none: a real failure.
  assert.equal(wasDeclined([rec('Checkpoint.Approval', 'succeeded'), rec('Task', 'failed')]), false);
  assert.equal(wasDeclined([rec('Job', 'failed'), rec('Task', 'failed')]), false);
  // Declined at production, but a step had already failed in an earlier stage: still a failure.
  assert.equal(wasDeclined([...declined, rec('Task', 'failed', { id: 'build-step' })]), false);
  // Still waiting on the approval is not declined.
  assert.equal(wasDeclined([{ ...rec('Checkpoint.Approval', null), state: 'inProgress' }]), false);
});

const run = (id, result, hAgo) => ({
  id, projectId: 'p1', projectName: 'Shop', definition: { id: 5, name: 'web' }, buildNumber: `B${id}`, status: 'completed', result,
  reason: 'individualCI', sourceBranch: 'main', repoId: 'r1', repoName: 'web', queuedAt: at(hAgo + 0.2), startedAt: at(hAgo + 0.1), finishedAt: at(hAgo), webUrl: `u${id}`,
});

test('pipeline health: a declined run is neither a pass nor a failure', () => {
  const repos = [{ id: 'r1', defaultBranch: 'main' }];
  const [ok] = pipelineHealth([run(3, 'declined', 1), run(2, 'succeeded', 5), run(1, 'succeeded', 9)], repos);
  assert.deepEqual([ok.health, ok.failStreak, ok.passRate, ok.latest.result], ['healthy', 0, 1, 'declined']);
  const [bad] = pipelineHealth([run(3, 'declined', 1), run(2, 'failed', 5), run(1, 'succeeded', 9)], repos);
  assert.deepEqual([bad.health, bad.failStreak], ['failing', 1], 'judged on the run before it');
});

test('classic release: a declined stage is skipped for its last deployment and health', () => {
  const stages = stageSummary([{ id: 1, name: 'Production', rank: 1 }], [
    { id: 66, name: 'R-66', envs: [{ definitionEnvironmentId: 1, id: 10, status: 'declined', at: at(1) }] },
    { id: 65, name: 'R-65', envs: [{ definitionEnvironmentId: 1, id: 9, status: 'succeeded', at: at(30) }] },
  ]);
  assert.equal(stages[0].latest.releaseName, 'R-65');
  assert.equal(releaseHealth(stages), 'healthy');
});

test('a run declined at its approval is not failing, and not a deploy', async () => {
  const timelines = {
    3: [rec('Checkpoint.Approval', 'failed'), rec('Job', 'skipped')],
    2: [rec('Task', 'failed')],
  };
  const asked = [];
  const provider = {
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [{ id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'main' }],
    listBuilds: async () => [run(3, 'failed', 1), run(1, 'succeeded', 9)],
    listDefinitions: async () => [],
    listReleases: async () => [],
    getBuildTimeline: async (projectId, id) => {
      asked.push(id);
      return timelines[id] || [];
    },
    listDeployments: async () => [
      { id: 3, label: 'B3', at: at(1), status: 'failed', repoId: 'r1', commit: 'c3', branch: 'main' },
      { id: 2, label: 'B2', at: at(4), status: 'failed', repoId: 'r1', commit: 'c2', branch: 'main' },
      { id: 1, label: 'B1', at: at(9), status: 'succeeded', repoId: 'r1', commit: 'c1', branch: 'main' },
    ],
    listCommits: async () => [{ id: 'c1', message: 'Head', author: { name: 'Ana', date: at(9) } }],
    getPullRequestCommitIds: async () => [],
    getWorkItems: async () => [],
  };
  let settings = { ...structuredClone(DEFAULT_SETTINGS), projects: { p1: { name: 'Shop', tracked: true, repos: 'all', teams: [] } } };
  const monitoring = { status: () => [{ id: 'm', name: 'Web', link: { type: 'pipeline', projectId: 'p1', definitionId: 5 } }] };
  const service = createService({ provider, settings: { load: async () => settings, save: async (p) => (settings = { ...settings, ...p }) }, monitoring });

  const [row] = await service.pipelines();
  assert.equal(row.health, 'healthy');
  assert.equal(row.latest.result, 'declined');
  assert.deepEqual(asked, [3], 'only failed runs are looked at');

  // Waiting to ship: B2 really failed, B3 was declined (no deploy, not "Last deploy failed: B3").
  const { targets: [env] } = await service.undeployed();
  assert.equal(env.lastFailed.label, 'B2');
  assert.equal(env.lastDeploy.label, 'B1');
});

test('cache: an answer can be kept for a time that depends on it', async () => {
  const { Cache } = await import('../server/cache.js');
  const cache = new Cache();
  let reads = 0;
  const load = (v) => () => (reads++, v);
  const ttl = (yes) => (yes ? 60_000 : -1); // "no" is stale at once
  assert.equal(await cache.get('a', load(false), ttl), false);
  assert.equal(await cache.get('a', load(true), ttl), true, 'a "no" is read again');
  assert.equal(await cache.get('a', load(false), ttl), true, 'a "yes" is kept');
  assert.equal(reads, 2);
});
