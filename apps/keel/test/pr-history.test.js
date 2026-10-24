import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../server/service.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';

const DAY = 86_400_000;
const at = (d) => new Date(Date.now() - d * DAY).toISOString();
const person = (id) => ({ id, displayName: id, uniqueName: `${id}@x` });
const pr = (id, status, closedDaysAgo, extra = {}) => ({
  key: `p1/r1/${id}`, id, title: `PR ${id}`, projectId: 'p1', projectName: 'Shop', repoId: 'r1', repoName: 'web',
  author: person('ana'), createdAt: at(closedDaysAgo + 2), closedAt: closedDaysAgo == null ? null : at(closedDaysAgo),
  closedBy: closedDaysAgo == null ? null : person('rui'), status, isDraft: false, mergeStatus: 'succeeded',
  sourceBranch: `feature/${id}`, targetBranch: 'main', reviewers: [], labels: [], autoComplete: false, ...extra,
});

test('pull request history: completed and abandoned in the period, newest first, tracked repos only', async () => {
  const asked = [];
  const provider = {
    me: async () => person('ana'),
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [{ id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'main' }],
    listTeams: async () => [],
    getTeamMembers: async () => [],
    queryWorkItems: async () => [],
    getWorkItems: async () => [],
    getWorkItemTypeStates: async () => ({}),
    listWorkItemTypes: async () => [],
    listPullRequests: async (projectId, opts) => {
      asked.push(opts);
      return [pr(3, 'completed', 5), pr(1, 'abandoned', 1), pr(2, 'active', null), pr(4, 'completed', 2, { repoId: 'other' })];
    },
  };
  let settings = { ...structuredClone(DEFAULT_SETTINGS), projects: { p1: { name: 'Shop', tracked: true, repos: 'all', teams: [] } } };
  const service = createService({ provider, settings: { load: async () => settings, save: async (p) => (settings = { ...settings, ...p }) } });

  const { prs, days } = await service.closedPullRequests(30);
  assert.equal(days, 30);
  assert.deepEqual(prs.map((p) => [p.id, p.status]), [[1, 'abandoned'], [3, 'completed']], 'no active PRs, none from untracked repos');
  assert.equal(prs[0].closedBy.id, 'rui');
  assert.equal(prs[0].isMine, true);
  assert.equal(asked[0].status, 'all');
  assert.ok(Math.abs(Date.parse(asked[0].closedAfter) - (Date.now() - 30 * DAY)) < 60_000, 'asks for 30 days back');
  await assert.rejects(service.closedPullRequests(365), /7, 30 or 90/);
});
