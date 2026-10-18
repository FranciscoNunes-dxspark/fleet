import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../server/service.js';
import { comingNext } from '../server/domain/commits.js';
import { deployUnderWay } from '../server/domain/production.js';
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
    aheadBehind: async () => ({ ahead: 3, behind: 0 }),
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
  // One PR and one commit without a PR: two changes, not three commits.
  assert.equal(env.waiting, 2);
  // Waiting since PR 7 merged (c3), not since its first commit was written (c2b).
  assert.equal(env.oldestAt, history[1].author.date);
});

test('waiting to ship: compared on the branch the deployed build came from', async () => {
  const seen = [];
  const provider = {
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [{ id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'main' }],
    listReleases: async () => [],
    listBuilds: async () => [],
    listDefinitions: async () => [],
    listDeployments: async () => [{ id: 3, label: 'Release-3', at: at(10), status: 'succeeded', repoId: 'r1', commit: 'h1', branch: 'release/2026.10' }],
    listCommits: async (projectId, repoId, { branch }) => {
      seen.push(branch);
      return [commit('h2', 2, 'Hotfix for checkout')];
    },
    listCommitsBetween: async () => [commit('h2', 2, 'Hotfix for checkout')],
    getPullRequestCommitIds: async () => [],
    aheadBehind: async () => ({ ahead: 1, behind: 0 }),
    getWorkItems: async () => [],
  };
  const monitoring = { status: () => [{ id: 'm1', name: 'Shop', link: { type: 'release', projectId: 'p1', definitionId: 1, stage: 'Production' } }] };
  const { targets: [env] } = await createService({ provider, settings: memoryStore(), monitoring }).undeployed();
  assert.deepEqual(seen, ['release/2026.10'], 'not the repo\'s default branch');
  assert.equal(env.branch, 'release/2026.10');
  assert.equal(env.waiting, 1);
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

test('waiting to ship: production on a commit the branch lacks is not counted', async () => {
  const provider = {
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [{ id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'develop' }],
    listReleases: async () => [],
    listBuilds: async () => [],
    listDefinitions: async () => [],
    // Deployed from master (squash-merged releases): develop never contains that commit.
    listDeployments: async () => [{ id: 9, label: 'Release-9', at: at(48), status: 'succeeded', repoId: 'r1', commit: 'm1', branch: null }],
    listCommits: async () => [commit('d300', 1, 'Latest on develop')],
    aheadBehind: async (projectId, repoId, base, target) => {
      assert.deepEqual([base, target], ['m1', 'd300']);
      return { ahead: 2400, behind: 12 };
    },
    listCommitsBetween: async () => assert.fail('years of history would be counted as waiting'),
    getPullRequestCommitIds: async () => [],
    getWorkItems: async () => [],
  };
  const monitoring = { status: () => [{ id: 'm1', name: 'Shop', link: { type: 'release', projectId: 'p1', definitionId: 1, stage: 'Production' } }] };
  const { targets: [env] } = await createService({ provider, settings: memoryStore(), monitoring }).undeployed();
  assert.equal(env.diverged, true);
  assert.equal(env.waiting, 0);
  assert.equal(env.oldestAt, null);
  assert.equal(env.lastDeploy.label, 'Release-9');
});

test('waiting to ship: a deleted branch falls back to the default, a differently cased one is found', async () => {
  const seen = [];
  const provider = {
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [
      { id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'master' },
      { id: 'r2', name: 'api', projectId: 'p1', projectName: 'Shop', defaultBranch: 'master' },
    ],
    listReleases: async () => [],
    listBuilds: async () => [],
    listDefinitions: async () => [],
    listDeployments: async (target) => [{ id: 1, label: 'R1', at: at(10), status: 'succeeded', repoId: target.definitionId === 1 ? 'r1' : 'r2', commit: 'c1', branch: 'Develop' }],
    listBranches: async (projectId, repoId) => (repoId === 'r1' ? [{ name: 'master' }] : [{ name: 'master' }, { name: 'develop' }]),
    listCommits: async (projectId, repoId, { branch }) => {
      // Like Azure DevOps: exact names only.
      if (!(repoId === 'r1' ? ['master'] : ['master', 'develop']).includes(branch)) throw Object.assign(new Error('TF401175'), { status: 404 });
      seen.push(`${repoId}:${branch}`);
      return [commit('c1', 10, 'Head')];
    },
    getPullRequestCommitIds: async () => [],
    getWorkItems: async () => [],
  };
  const link = (definitionId) => ({ type: 'release', projectId: 'p1', definitionId, stage: 'Production' });
  const monitoring = { status: () => [{ id: 'a', name: 'Web', link: link(1) }, { id: 'b', name: 'Api', link: link(2) }] };
  const { targets } = await createService({ provider, settings: memoryStore(), monitoring }).undeployed();
  const by = Object.fromEntries(targets.map((x) => [x.name, x]));
  assert.deepEqual(seen.sort(), ['r1:master', 'r2:develop']);
  assert.equal(by.Web.error, undefined);
  assert.deepEqual([by.Web.branch, by.Web.branchGone], ['master', 'Develop']);
  assert.deepEqual([by.Api.branch, by.Api.branchGone], ['develop', null]);
});

test('waiting to ship: a branch Azure DevOps rejects falls back to the default', async () => {
  const provider = {
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [{ id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'master' }],
    listReleases: async () => [],
    listBuilds: async () => [],
    listDefinitions: async () => [],
    listDeployments: async () => [{ id: 1, label: 'R1', at: at(10), status: 'succeeded', repoId: 'r1', commit: 'c1', branch: 'Develop' }],
    listBranches: async () => { throw new Error('No access to refs'); },
    listCommits: async (projectId, repoId, { branch }) => {
      if (branch === 'Develop') throw Object.assign(new Error('TF401175: The version descriptor <Branch: Develop > could not be resolved'), { status: 404 });
      return [commit('c1', 10, 'Head')];
    },
    getPullRequestCommitIds: async () => [],
    getWorkItems: async () => [],
  };
  const monitoring = { status: () => [{ id: 'a', name: 'Web', link: { type: 'release', projectId: 'p1', definitionId: 1, stage: 'Production' } }] };
  const { targets: [env] } = await createService({ provider, settings: memoryStore(), monitoring }).undeployed();
  assert.equal(env.error, undefined);
  assert.deepEqual([env.branch, env.branchGone, env.waiting], ['master', 'Develop', 0]);
});

test('waiting to ship: a default branch that is missing says so instead of failing', async () => {
  const provider = {
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [
      { id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'Develop' },
      { id: 'r2', name: 'api', projectId: 'p1', projectName: 'Shop', defaultBranch: 'Develop' },
    ],
    listReleases: async () => [],
    listBuilds: async () => [],
    listDefinitions: async () => [],
    listDeployments: async (target) => [{ id: 1, label: 'R1', at: at(10), status: 'succeeded', repoId: target.definitionId === 1 ? 'r1' : 'r2', commit: 'c1', branch: target.definitionId === 1 ? 'Develop' : null }],
    // web has no Develop at all; api has it as develop.
    listBranches: async (projectId, repoId) => (repoId === 'r1' ? [{ name: 'main' }] : [{ name: 'develop' }]),
    listCommits: async (projectId, repoId, { branch }) => {
      if (!(repoId === 'r1' ? ['main'] : ['develop']).includes(branch)) throw Object.assign(new Error('TF401175'), { status: 404 });
      return [commit('c1', 10, 'Head')];
    },
    getPullRequestCommitIds: async () => [],
    getWorkItems: async () => [],
  };
  const link = (definitionId) => ({ type: 'release', projectId: 'p1', definitionId, stage: 'Production' });
  const monitoring = { status: () => [{ id: 'a', name: 'Web', link: link(1) }, { id: 'b', name: 'Api', link: link(2) }] };
  const { targets } = await createService({ provider, settings: memoryStore(), monitoring }).undeployed();
  const by = Object.fromEntries(targets.map((x) => [x.name, x]));
  assert.equal(by.Web.error, undefined);
  assert.deepEqual([by.Web.missingBranch, by.Web.branch, by.Web.waiting], ['Develop', null, 0]);
  assert.equal(by.Api.error, undefined);
  assert.deepEqual([by.Api.branch, by.Api.missingBranch, by.Api.branchGone], ['develop', undefined, null]);
});

test('waiting to ship: other Azure DevOps errors still show', async () => {
  const provider = {
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [{ id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'main' }],
    listReleases: async () => [],
    listBuilds: async () => [],
    listDefinitions: async () => [],
    listDeployments: async () => [{ id: 1, label: 'R1', at: at(10), status: 'succeeded', repoId: 'r1', commit: 'c1', branch: 'main' }],
    listCommits: async () => { throw Object.assign(new Error('Access denied'), { status: 403 }); },
  };
  const monitoring = { status: () => [{ id: 'a', name: 'Web', link: { type: 'release', projectId: 'p1', definitionId: 1, stage: 'Production' } }] };
  const { targets: [env] } = await createService({ provider, settings: memoryStore(), monitoring }).undeployed();
  assert.equal(env.error, 'Access denied');
});

test('waiting to ship: every monitor shows; monitors sharing a deploy are one environment', async () => {
  const provider = {
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [{ id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'main' }],
    listReleases: async () => [],
    listBuilds: async () => [],
    listDefinitions: async () => [],
    listDeployments: async () => [{ id: 2, label: '2', at: at(3), status: 'succeeded', repoId: 'r1', commit: 'c1' }],
    listCommits: async () => [commit('c1', 4, 'Head')],
    getPullRequestCommitIds: async () => [],
    getWorkItems: async () => [],
  };
  const shared = { type: 'release', projectId: 'p1', definitionId: 3, stage: 'Production' };
  const monitoring = {
    status: () => [
      { id: 'a', name: 'Berlin', link: shared },
      { id: 'b', name: 'Sydney', link: shared },
      { id: 'c', name: 'Status page', link: null },
    ],
  };
  const { targets } = await createService({ provider, settings: memoryStore(), monitoring }).undeployed();
  assert.deepEqual(targets.map((x) => x.name), ['Berlin, Sydney', 'Status page']);
  assert.equal(targets[1].unlinked, true);
});

test('coming next: open pull requests into the deployed branch, closest to merging first', () => {
  const pr = (id, extra) => ({ id, title: `PR ${id}`, repoId: 'r1', targetBranch: 'master', createdAt: at(id), reviewState: 'in-review', author: { displayName: 'Ana' }, ...extra });
  const open = [
    pr(1, { reviewState: 'draft' }),
    pr(2, { reviewState: 'approved' }),
    pr(3, { reviewState: 'approved', autoComplete: true }),
    pr(4),
    pr(5, { targetBranch: 'develop' }), // another branch
    pr(6, { repoId: 'r2' }), // another repo
  ];
  assert.deepEqual(comingNext(open, 'r1', 'master').map((p) => p.id), [3, 2, 4, 1]);
  assert.equal(comingNext(open, 'r1', 'master')[0].autoComplete, true);
  assert.deepEqual(comingNext(open, 'r1', 'main'), []);
});

test('deploy under way: a release stage deploying or waiting for approval, a pipeline run and its approval check', () => {
  const stage = (over) => ({ name: 'Production', deploying: false, waiting: false, startedAt: at(0.2), ...over });
  const releases = [{
    projectId: 'p1', id: 1,
    releases: [
      { name: 'Release-9', webUrl: 'u9', stages: [stage({ name: 'QA', deploying: true }), stage({ waiting: true, startedAt: at(3) })] },
      { name: 'Release-8', webUrl: 'u8', stages: [stage({ deploying: true, startedAt: at(30) })] },
    ],
  }];
  const release = { type: 'release', projectId: 'p1', definitionId: 1, stage: 'Production' };
  assert.deepEqual(
    (({ state, label }) => ({ state, label }))(deployUnderWay(release, { releases }, { since: at(10) })),
    { state: 'approval', label: 'Release-9' },
    'the QA stage is not production; a release older than the last good deploy is not next',
  );
  assert.equal(deployUnderWay(release, { releases }, { since: at(1) }), null, 'waiting since before the last good deploy: superseded');
  assert.equal(deployUnderWay({ ...release, stage: 'QA' }, { releases }).state, 'deploying');

  const run = (id, over) => ({ id, projectId: 'p1', definition: { id: 5 }, status: 'inProgress', reason: 'individualCI', sourceBranch: 'master', buildNumber: `B${id}`, startedAt: at(0.1), ...over });
  const pipeline = { type: 'pipeline', projectId: 'p1', definitionId: 5, branch: 'master' };
  const builds = [run(1), run(2, { sourceBranch: 'feature/x', startedAt: at(0.05) }), run(3, { reason: 'pullRequest', startedAt: at(0.01) })];
  assert.deepEqual((({ state, label }) => ({ state, label }))(deployUnderWay(pipeline, { builds })), { state: 'deploying', label: 'B1' });
  assert.equal(deployUnderWay(pipeline, { builds, approvals: [{ kind: 'yaml', run: { id: 1 } }] }).state, 'approval');
  assert.equal(deployUnderWay(pipeline, { builds: [run(1, { startedAt: at(2) })] }), null, 'running for over an hour: stuck, not deploying');
  assert.equal(deployUnderWay(pipeline, { builds: [run(1, { status: 'completed' })] }), null);
});

test('waiting to ship: the newest deploy failing is shown, with what production still runs', async () => {
  const provider = {
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [{ id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'master' }],
    listReleases: async () => [],
    listBuilds: async () => [],
    listDefinitions: async () => [],
    listDeployments: async () => [
      { id: 3, label: 'B3', at: at(1), status: 'failed', repoId: 'r1', commit: 'c3', branch: 'master' },
      { id: 2, label: 'B2', at: at(5), status: 'succeeded', repoId: 'r1', commit: 'c2', branch: 'master' },
      { id: 1, label: 'B1', at: at(9), status: 'failed', repoId: 'r1', commit: 'c1', branch: 'master' },
    ],
    listCommits: async () => [commit('c2', 6, 'Head')],
    getPullRequestCommitIds: async () => [],
    getWorkItems: async () => [],
  };
  const monitoring = { status: () => [{ id: 'a', name: 'Web', link: { type: 'pipeline', projectId: 'p1', definitionId: 5 } }] };
  const { targets: [env] } = await createService({ provider, settings: memoryStore(), monitoring }).undeployed();
  assert.deepEqual([env.lastFailed?.label, env.lastDeploy.label, env.deploy], ['B3', 'B2', null]);
});

test('production branch set in Settings: cleaned up and checked when saved, then compared with', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createMonitoring } = await import('../server/monitoring.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-branch-'));
  const monitoring = createMonitoring({ dataDir: dir, mock: false });
  const appInsightsAppId = '0f1e2d3c-0000-4000-8000-000000000000';
  const release = { type: 'release', projectId: 'p1', definitionId: 1, stage: 'Production' };
  await assert.rejects(monitoring.save([{ name: 'Web', appInsightsAppId, link: { ...release, branch: 'a..b' } }]), /isn't a valid branch name/);
  await monitoring.save([
    { name: 'Web', appInsightsAppId, link: { ...release, branch: ' refs/heads/master ' } },
    { name: 'Api', appInsightsAppId, link: { type: 'pipeline', projectId: 'p1', definitionId: 5, branch: '' } },
  ]);
  const links = monitoring.status().map((m) => m.link);
  assert.equal(links[0].branch, 'master');
  assert.equal('branch' in links[1], false, 'empty means automatic');

  const asked = [];
  const provider = {
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [{ id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'develop' }],
    listReleases: async () => [],
    listBuilds: async () => [],
    listDefinitions: async () => [],
    // The release says it came from develop; Settings says production is master.
    listDeployments: async () => [{ id: 1, label: 'R1', at: at(10), status: 'succeeded', repoId: 'r1', commit: 'c1', branch: 'develop' }],
    listCommits: async (projectId, repoId, { branch }) => {
      asked.push(branch);
      return [commit('c1', 10, 'Head')];
    },
    getPullRequestCommitIds: async () => [],
    getWorkItems: async () => [],
  };
  const { targets } = await createService({ provider, settings: memoryStore(), monitoring }).undeployed();
  const web = targets.find((x) => x.name === 'Web');
  assert.deepEqual([web.branch, web.branchSet], ['master', true]);
  assert.ok(asked.includes('master'));
  const api = targets.find((x) => x.name === 'Api');
  assert.deepEqual([api.branch, api.branchSet], ['develop', false], 'not set: the branch the deploy came from');
});
