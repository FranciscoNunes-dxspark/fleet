// GitHub sources: the mapping from GitHub's answers (pure, hand-built payloads), and the demo
// GitHub owner (mock/github.js, a fake GitHub API behind the real provider) through the service,
// next to the Azure DevOps demo, as Keel runs them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-github-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const { reviewersOf, policiesOf, normalizeRun, timelineOf, logTail, approvalsOf } = await import('../server/github/normalize.js');
const { wasDeclined, currentStage } = await import('../server/domain/pipelines.js');
const { commitRefs } = await import('../server/domain/commits.js');
const { orgKeyOf, normalizeOrgUrl, kindOf } = await import('../server/orgs.js');
const { createService } = await import('../server/service.js');
const { createMultiService } = await import('../server/multiorg.js');
const { createSettingsStore } = await import('../server/settings.js');
const { createMockProvider } = await import('../server/mock/provider.js');
const { createMockGithub } = await import('../server/mock/github.js');
const { createGithubProvider } = await import('../server/github/provider.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('GitHub addresses: an owner on github.com or a GitHub Enterprise Server, keyed apart from Azure DevOps', () => {
  assert.equal(kindOf('https://github.com/acme'), 'github');
  assert.equal(kindOf('https://dev.azure.com/acme'), 'azdo');
  assert.equal(kindOf('https://ghe.example.com/acme', 'github'), 'github');
  assert.equal(normalizeOrgUrl('https://github.com/Acme/web-app/pulls', 'github'), 'https://github.com/Acme');
  assert.equal(orgKeyOf('https://github.com/Acme', 'github'), 'gh-acme');
  assert.equal(orgKeyOf('https://ghe.example.com/acme', 'github'), 'gh-ghe-acme');
  assert.throws(() => normalizeOrgUrl('https://github.com/', 'github'), /organization or user/);
});

test('reviews become votes: approved 10, changes requested -5, asked again 0, a comment alone is no vote', () => {
  const who = (login) => ({ login, name: login.toUpperCase() });
  const reviewers = reviewersOf({
    latestOpinionatedReviews: { nodes: [{ state: 'APPROVED', author: who('ann') }, { state: 'CHANGES_REQUESTED', author: who('bob') }, { state: 'APPROVED', author: who('cy') }, { state: 'COMMENTED', author: who('dee') }] },
    reviewRequests: { nodes: [{ requestedReviewer: who('cy') }, { requestedReviewer: { slug: 'web', name: 'Web team' } }] },
  });
  const vote = Object.fromEntries(reviewers.map((r) => [r.uniqueName, r.vote]));
  assert.deepEqual(vote, { ann: 10, bob: -5, cy: 0, 'team:web': 0 });
  assert.equal(reviewers.find((r) => r.uniqueName === 'team:web').isContainer, true);
});

test('checks become policies, blocking when branch protection requires them', () => {
  const policies = policiesOf({
    reviewDecision: 'REVIEW_REQUIRED',
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: true },
      { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: null, isRequired: false },
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', isRequired: false },
    ] } } } }] },
  });
  assert.deepEqual(policies, [
    { name: 'Required reviews', status: 'queued', isBlocking: true },
    { name: 'build', status: 'rejected', isBlocking: true },
    { name: 'e2e', status: 'running', isBlocking: false },
    { name: 'ci/legacy', status: 'approved', isBlocking: false },
  ]);
});

test('workflow runs become builds: pull request runs say so, a waiting run is under way', () => {
  const base = { id: 9, workflow_id: 3, name: 'CI', run_number: 12, head_branch: 'main', head_sha: 'abc', repository: { name: 'api' }, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:05:00Z', html_url: 'u', actor: { login: 'ann' } };
  const done = normalizeRun({ ...base, event: 'push', status: 'completed', conclusion: 'failure' }, { projectId: 'gh-x', projectName: 'x' });
  assert.equal(done.result, 'failed');
  assert.equal(done.reason, 'individualCI');
  assert.equal(done.buildNumber, '#12');
  assert.equal(done.definition.path, '\\api');
  assert.equal(normalizeRun({ ...base, event: 'pull_request', status: 'completed', conclusion: 'success' }, {}).reason, 'pullRequest');
  const waiting = normalizeRun({ ...base, event: 'workflow_dispatch', status: 'waiting', conclusion: null }, {});
  assert.equal(waiting.status, 'inProgress');
  assert.equal(waiting.finishedAt, null);
});

test('a rejected environment review makes the run declined, a failed step makes it failed', () => {
  const step = (number, conclusion) => ({ name: `s${number}`, number, status: 'completed', conclusion });
  const build = { id: 1, name: 'build', status: 'completed', conclusion: 'success', steps: [step(1, 'success')] };
  const deploy = { id: 2, name: 'deploy', status: 'completed', conclusion: 'failure', steps: [] };
  const rejected = [{ state: 'rejected', environments: [{ id: 7, name: 'production' }] }];
  assert.equal(wasDeclined(timelineOf([build, deploy], { approvals: rejected })), true);
  const broken = { ...build, conclusion: 'failure', steps: [step(1, 'success'), step(2, 'failure')] };
  const t = timelineOf([broken], {});
  assert.equal(wasDeclined(t), false);
  assert.equal(t.find((r) => r.type === 'Task' && r.result === 'failed').logId, 1);
});

test('a job waiting on reviewers is the stage the run waits at, and its review is an approval', () => {
  const waiting = { id: 5, name: 'deploy-production', status: 'waiting', conclusion: null, steps: [] };
  const pending = [{ environment: { id: 7, name: 'production' }, current_user_can_approve: true, reviewers: [{ type: 'User', reviewer: { login: 'ann' } }] }];
  assert.deepEqual(currentStage(timelineOf([waiting], { pending })), { name: 'deploy-production', startedAt: null, waiting: true });
  const build = { id: 3, repoId: 'web', projectId: 'gh-x', projectName: 'x', definition: { name: 'Deploy' }, buildNumber: '#4', webUrl: 'u', sourceBranch: 'main' };
  const [a] = approvalsOf(build, pending);
  assert.equal(a.id, 'web~3~7');
  assert.equal(a.stage, 'production');
  assert.equal(a.canDecide, true);
  assert.equal(a.approvers[0].uniqueName, 'ann');
});

test('log tails lose GitHub timestamps and colours', () => {
  assert.equal(logTail('2026-10-01T10:00:00.1234567Z \u001b[31mfail\u001b[0m\n2026-10-01T10:00:01.0Z done\n', 1), 'done');
  assert.equal(logTail('2026-10-01T10:00:00.1234567Z \u001b[31mfail\u001b[0m', 5), 'fail');
});

test('emails: verified-domain ones when GitHub gives them, else public ones; an unknown login only loses its own', async () => {
  const org = { key: 'gh-acme', url: 'https://github.com/acme', kind: 'github' };
  const asked = [];
  const client = {
    bases: { web: 'https://github.com' },
    api: async () => ({ type: 'Organization' }),
    async graphql(query, v, { partial } = {}) {
      if (/search\(/.test(query)) {
        const who = (login) => ({ __typename: login === 'renovate' ? 'Bot' : 'User', login, name: login.toUpperCase() });
        return { search: { pageInfo: { hasNextPage: false }, nodes: [
          { number: 1, title: 'A', state: 'OPEN', repository: { name: 'web' }, author: who('ana'), reviewRequests: { nodes: [{ requestedReviewer: who('rui') }] } },
          { number: 2, title: 'B', state: 'OPEN', repository: { name: 'web' }, author: who('gone') },
          { number: 3, title: 'C', state: 'OPEN', repository: { name: 'web' }, author: who('renovate') },
        ] } };
      }
      assert.ok(partial);
      const verified = /organizationVerifiedDomainEmails/.test(query);
      asked.push(verified ? 'verified' : 'public');
      const logins = Object.entries(v).filter(([k]) => /^l\d/.test(k));
      // Verified-domain emails refused (no verified domain, or not allowed to see them).
      if (verified && !refuseVerified) return { data: Object.fromEntries(logins.map(([k, l]) => [`u${k.slice(1)}`, l === 'gone' ? null : { email: '', organizationVerifiedDomainEmails: [`${l}@acme.com`] }])), errors: [{ type: 'NOT_FOUND', path: ['u2'] }] };
      if (verified) return { data: {}, errors: [{ type: 'FORBIDDEN', path: ['u0', 'organizationVerifiedDomainEmails'] }] };
      return { data: Object.fromEntries(logins.map(([k, l]) => [`u${k.slice(1)}`, l === 'ana' ? { email: 'Ana@Home.example' } : l === 'gone' ? null : { email: '' }])), errors: [] };
    },
  };
  let refuseVerified = false;
  const byId = (prs) => Object.fromEntries(prs.flatMap((p) => [p.author, ...p.reviewers]).map((x) => [x.id, x.email || null]));
  const prs = await createGithubProvider({ org, client }).listPullRequests('gh-acme');
  assert.deepEqual(byId(prs), { ana: 'ana@acme.com', rui: 'rui@acme.com', gone: null, renovate: null });
  assert.equal(prs[2].author.isBot, true, 'apps are bots, and nobody asks for their email');
  assert.deepEqual(asked, ['verified']);

  refuseVerified = true;
  asked.length = 0;
  const provider = createGithubProvider({ org, client });
  assert.deepEqual(byId(await provider.listPullRequests('gh-acme')), { ana: 'ana@home.example', rui: null, gone: null, renovate: null });
  await provider.listPullRequests('gh-acme');
  assert.deepEqual(asked, ['verified', 'public'], 'refused once, then public emails only, kept for an hour');
});

test('GitHub merge commits name their pull request; #123 is not a work item there', () => {
  assert.deepEqual(commitRefs('Merge pull request #39 from acme/dark-mode\n\nDark mode', { github: true }), { workItemIds: [], prId: 39 });
  assert.deepEqual(commitRefs('Retry flaky upload (#36)\n\n* fix #12', { github: true }), { workItemIds: [], prId: 36 });
  // In Azure DevOps "(#36)" is still a work item mention.
  assert.deepEqual(commitRefs('Retry flaky upload (#36)'), { workItemIds: [36], prId: null });
});

// The demo GitHub owner next to the Azure DevOps demo, tracked with all its repos.
const P = 'gh-octo-demo';
let service;
before(async () => {
  const settings = createSettingsStore(path.join(dataDir, 'settings.mock.json'));
  const primary = { key: 'contoso-demo', url: 'https://dev.azure.com/contoso-demo', name: 'contoso-demo', kind: 'azdo', primary: true };
  const gh = { key: P, url: 'https://github.com/octo-demo', name: 'octo-demo', kind: 'github', primary: false };
  service = createMultiService([
    { org: primary, service: createService({ provider: createMockProvider(), settings, org: primary }) },
    { org: gh, service: createService({ provider: createMockGithub(gh), settings, org: gh }) },
  ]);
  await service.meta(); // seeds the Azure DevOps demo projects
  const s = await settings.load();
  await settings.save({ projects: { ...s.projects, [P]: { name: 'octo-demo', tracked: true, repos: 'all', teams: [], scopeToTeamArea: false } } });
  service.invalidate('');
});

const ghPrs = async () => (await service.pullRequests()).prs.filter((p) => p.org === P);

test('demo GitHub: pull requests in each review state, archived repos left out', async () => {
  const state = Object.fromEntries((await ghPrs()).map((p) => [`${p.repoName}#${p.id}`, p.reviewState]));
  assert.deepEqual(state, { 'web-app#41': 'in-review', 'api#87': 'approved', 'api#85': 'waiting-author', 'web-app#40': 'draft', 'infra#12': 'no-reviewers' });
  const mine = (await ghPrs()).find((p) => p.id === 41);
  assert.equal(mine.needsMyReview, true);
  assert.equal((await ghPrs()).find((p) => p.id === 85).hasConflicts, true);
});

test('demo GitHub: the Team page has one row per person, with their GitHub pull requests counted by email', async () => {
  const { rows } = await service.team();
  const names = rows.map((r) => r.person.displayName);
  assert.deepEqual(names, [...new Set(names)], 'nobody twice');
  assert.ok(!names.some((n) => /bot/.test(n)), 'with Azure DevOps teams, GitHub adds no one of its own');
  const prs = (await service.pullRequests()).prs.filter((p) => p.status === 'active');
  // Priya by her verified-domain email, Sofia by her public one.
  for (const name of ['Priya Shah', 'Sofia Alvarez']) {
    const theirs = prs.filter((p) => p.author.displayName === name);
    assert.ok(theirs.some((p) => p.org === P));
    assert.equal(rows.find((r) => r.person.displayName === name).prsAuthored, theirs.length, name);
  }
});

test('demo GitHub: workflows are pipelines, with failing, declined and waiting runs', async () => {
  const pipes = (await service.pipelines()).filter((p) => p.org === P);
  const health = Object.fromEntries(pipes.map((p) => [`${p.repoName}/${p.definition.name}`, p.health]));
  assert.equal(health['api/CI'], 'failing');
  assert.equal(health['web-app/Deploy'], 'healthy'); // the declined run doesn't count
  assert.equal(health['infra/Dependabot Updates'], undefined);
  const deploy = pipes.find((p) => p.definition.name === 'Deploy');
  const { runs } = await service.pipelineRuns(P, deploy.definition.id);
  assert.deepEqual(runs.slice(0, 2).map((r) => r.result), [null, 'declined']);
  const [approval] = (await service.approvals()).filter((a) => a.org === P);
  assert.equal(approval.stage, 'production');
  assert.equal(approval.forMe, true);
  const details = await service.runDetails(P, runs[0].id);
  assert.ok(details.timeline.some((r) => r.type === 'Checkpoint.Approval' && r.state === 'inProgress'));
});

test('demo GitHub: the Inbox has its review, failing pipeline and deployment approval', async () => {
  const kinds = (await service.attention()).items.filter((i) => i.org === P).map((i) => `${i.kind}:${i.title}`);
  assert.ok(kinds.includes('review:Dark mode toggle in settings'));
  assert.ok(kinds.includes('pipeline:CI is failing on main'));
  assert.ok(kinds.includes('approval:Approve Deploy → production'));
});

test('demo GitHub: reviews, merges and refusals', async () => {
  await service.prAction(P, 'web-app', 41, { type: 'vote', vote: 10 });
  assert.equal((await service.pullRequest(P, 'web-app', 41)).reviewState, 'approved');
  await assert.rejects(service.prAction(P, 'web-app', 41, { type: 'vote', vote: 5 }), /no "approve with suggestions"/);
  await assert.rejects(service.prAction(P, 'web-app', 41, { type: 'complete', mergeStrategy: 'rebaseMerge' }), /no semi-linear merge/);
  await service.prAction(P, 'api', 87, { type: 'complete', mergeStrategy: 'squash', deleteSourceBranch: true });
  assert.ok(!(await ghPrs()).some((p) => p.id === 87));
  const merged = (await service.commits({ projectId: P })).commits.find((c) => c.prId === 87);
  assert.equal(merged.subject, 'Rate limit the search endpoint (#87)');
});

test('demo GitHub: rejecting a deployment declines the run; a workflow without a manual trigger says so', async () => {
  const [approval] = (await service.approvals()).filter((a) => a.org === P);
  await service.decideApproval('yaml', approval.id, { status: 'rejected', comment: 'freeze' }, P);
  service.invalidate('');
  const deploy = (await service.pipelines()).find((p) => p.org === P && p.definition.name === 'Deploy');
  assert.equal((await service.pipelineRuns(P, deploy.definition.id)).runs[0].result, 'declined');
  const release = (await service.pipelines()).find((p) => p.org === P && p.definition.name === 'Release');
  await assert.rejects(service.queueBuild(P, release.definition.id, 'main'), /workflow_dispatch/);
});

test('demo GitHub: work item pages simply have nothing from it', async () => {
  assert.ok(!(await service.workItems()).items.some((w) => w.org === P));
  assert.ok(!(await service.epics()).projects.some((p) => p.org === P));
});

test('a token without read:org still lists pull requests, without requested teams', async () => {
  const { createDemoApi } = await import('../server/mock/github.js');
  const { createGithubProvider } = await import('../server/github/provider.js');
  const { GithubError } = await import('../server/github/client.js');
  const api = createDemoApi('octo-demo');
  const asked = [];
  const graphql = (query, v, opts) => {
    if (!/search\(/.test(query)) return api.graphql(query, v, opts); // people's emails, not a PR search
    asked.push(/on Team/.test(query));
    if (/on Team/.test(query)) throw new GithubError('GitHub: The \'slug\' field requires one of the following scopes: [\'read:org\']', 400, [{ type: 'INSUFFICIENT_SCOPES' }]);
    return api.graphql(query, v);
  };
  const provider = createGithubProvider({ org: { key: 'gh-octo-demo', url: 'https://github.com/octo-demo', kind: 'github' }, client: { ...api, graphql } });
  assert.ok((await provider.listPullRequests()).length > 0);
  await provider.listPullRequests();
  assert.deepEqual(asked, [true, false, false]); // asks once with teams, then never again
});
