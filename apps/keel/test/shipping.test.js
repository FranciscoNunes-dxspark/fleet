import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../server/service.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';

const H = 3_600_000;
const at = (hAgo) => new Date(Date.now() - hAgo * H).toISOString();
const commit = (id, hAgo, message) => ({ id, message, author: { name: 'Ana', email: 'ana@x', date: at(hAgo) } });

/** Settings kept in memory, with one tracked project. */
export const memoryStore = (extra = {}) => {
  let current = { ...structuredClone(DEFAULT_SETTINGS), projects: { p1: { name: 'Shop', tracked: true, repos: 'all', teams: [] } }, ...extra };
  return { load: async () => current, save: async (patch) => (current = { ...current, ...patch }) };
};

test('waiting to ship: commits on the branch since the last good deploy, with their PRs and work items', async () => {
  // Newest first: c4 and c3 came after the deploy of c2; c3 is the merge commit of PR 7, which brought c2b.
  const history = [commit('c4', 2, 'Tidy logs (AB#41)'), commit('c3', 5, 'Merged PR 7: Add refunds'), commit('c2b', 6, 'Refund endpoint'), commit('c2', 30, 'Old')];
  const provider = {
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [{ id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'main' }],
    listReleases: async () => [],
    listBuilds: async () => [],
    listDefinitions: async () => [],
    listDeployments: async () => [
      { id: 12, label: '12', at: at(1), status: 'failed', repoId: 'r1', commit: 'c4' },
      { id: 11, label: '11', at: at(20), status: 'succeeded', repoId: 'r1', commit: 'c2' },
    ],
    listCommits: async (projectId, repoId, { branch, top }) => {
      assert.equal(branch, 'main');
      return history.slice(0, top);
    },
    listCommitsBetween: async (projectId, repoId, from, to) => {
      assert.deepEqual([from, to], ['c2', 'c4']);
      return history.slice(0, 3);
    },
    getPullRequestCommitIds: async () => ['c2b'],
    getWorkItems: async (ids) => ids.map((id) => ({ id, type: 'Bug', title: `Item ${id}`, state: 'Active', stateCategory: 'InProgress', assignedTo: null })),
  };
  const monitoring = { status: () => [{ id: 'm1', name: 'Shop web', link: { type: 'pipeline', projectId: 'p1', definitionId: 5 } }] };
  const service = createService({ provider, settings: memoryStore(), monitoring });

  const { targets } = await service.undeployed();
  assert.equal(targets.length, 1);
  const env = targets[0];
  assert.equal(env.lastDeploy.id, 11, 'a failed deploy is not what production runs');
  assert.deepEqual(env.commits.map((c) => c.id), ['c4', 'c3', 'c2b']);
  assert.deepEqual(env.pullRequests.map((p) => [p.id, p.title, p.commits.map((c) => c.id)]), [[7, 'Add refunds', ['c3', 'c2b']]]);
  assert.deepEqual(env.directCommits.map((c) => c.id), ['c4']);
  assert.deepEqual(env.workItems.map((w) => w.id), [41]);
  assert.equal(env.oldestAt, history[2].author.date);
});

test('waiting to ship: up to date, and environments that cannot be read', async () => {
  const provider = {
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [{ id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'main' }],
    listReleases: async () => [],
    listBuilds: async () => [],
    listDefinitions: async () => [],
    listDeployments: async (target) => {
      if (target.definitionId === 6) throw new Error('No access');
      if (target.definitionId === 7) return [{ id: 1, label: '1', at: at(3), status: 'succeeded', repoId: 'other', commit: 'x' }];
      return [{ id: 2, label: '2', at: at(3), status: 'succeeded', repoId: 'r1', commit: 'c1' }];
    },
    listCommits: async () => [commit('c1', 4, 'Head')],
    listCommitsBetween: async () => assert.fail('nothing to compare when production runs the tip'),
    getPullRequestCommitIds: async () => [],
    getWorkItems: async () => [],
  };
  const link = (definitionId) => ({ type: 'pipeline', projectId: 'p1', definitionId });
  const monitoring = { status: () => [5, 6, 7].map((d) => ({ id: `m${d}`, name: `Env ${d}`, link: link(d) })) };
  const { targets } = await createService({ provider, settings: memoryStore(), monitoring }).undeployed();
  const by = Object.fromEntries(targets.map((x) => [x.name, x]));
  assert.deepEqual([by['Env 5'].commits.length, by['Env 5'].oldestAt], [0, null]);
  assert.equal(by['Env 6'].error, 'No access');
  assert.equal(by['Env 7'].untracked, true);
});
