// GitHub provider: one GitHub owner (an organization or a user) as a Keel "organization" with
// a single project, the owner itself, whose repositories are its repos. It covers pull
// requests and Actions, with the same normalized shapes as azdo/provider.js; GitHub has no
// work items, boards, sprints or classic releases here, so those answer empty.
import { createClient, seg } from './client.js';
import {
  person, normalizePR, withEmails, policiesOf, threadsOf, fileOf, normalizeCommit, normalizeRun, normalizeWorkflow, timelineOf, logTail, approvalsOf,
} from './normalize.js';

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const noWorkItems = () => {
  throw err('GitHub sources have no work items in Keel.');
};
const noReleases = () => {
  throw err('GitHub sources have no classic releases.');
};

// Keel's merge strategies in GitHub's words. Semi-linear (rebase, then a merge commit) has no equivalent.
const MERGE_METHOD = { squash: 'squash', noFastForward: 'merge', rebase: 'rebase' };
const STRATEGY_OF = { SQUASH: 'squash', MERGE: 'noFastForward', REBASE: 'rebase' };
const mergeMethod = (strategy) => {
  if (!MERGE_METHOD[strategy]) throw err('GitHub has no semi-linear merge. Choose squash, merge commit or rebase.');
  return MERGE_METHOD[strategy];
};

const WHO = '__typename login avatarUrl ... on User { name }';
// Requested teams' names need the read:org scope; without it the provider asks again leaving them out.
const TEAM = '... on Team { slug name }';
const prFields = (teams) => `
  number title url state isDraft mergeable createdAt closedAt headRefName baseRefName reviewDecision
  repository { name }
  author { ${WHO} }
  mergedBy { ${WHO} }
  labels(first: 20) { nodes { name } }
  autoMergeRequest { enabledAt mergeMethod enabledBy { ${WHO} } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login name avatarUrl } ${teams ? TEAM : ''} } } }
  latestOpinionatedReviews(first: 20) { nodes { state author { ${WHO} } } }
`;
const SEARCH = (teams) => `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${prFields(teams)} } }
  }
}`;
const DETAIL = (teams) => `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      ${prFields(teams)}
      id body headRefOid
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
        __typename
        ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $n) }
        ... on StatusContext { context state isRequired(pullRequestNumber: $n) }
      } } } } } }
      reviewThreads(last: 30) { totalCount nodes { id isResolved path comments(last: 3) { nodes { body createdAt author { ${WHO} } } } } }
      comments(last: 15) { totalCount nodes { id body createdAt author { ${WHO} } } }
    }
  }
}`;

/** The host and owner of a GitHub source's address: https://github.com/acme, or a GitHub Enterprise Server's. */
export function githubTarget(url) {
  const u = new URL(url);
  return { host: u.hostname.toLowerCase(), owner: u.pathname.split('/').filter(Boolean)[0] || '' };
}

export function createGithubProvider({ org, token, client } = {}) {
  const { host, owner } = githubTarget(org.url);
  const projectId = org.key;
  const projectName = owner;
  const where = { projectId, projectName };
  const { bases, api, apiText, listAll, graphql, fetchOrgImage } = client || createClient({ host, token });
  const repoPath = (repo) => `repos/${seg(owner)}/${seg(repo)}`;

  const once = (fn) => {
    let p;
    return () => {
      p ??= fn().catch((e) => {
        p = undefined;
        throw e;
      });
      return p;
    };
  };
  const me = once(async () => {
    const u = await api('user');
    return { id: u.login, displayName: u.name || u.login, uniqueName: u.login };
  });
  // Pull request search and the repo list need to know whether the owner is an organization.
  const ownerType = once(async () => (await api(`users/${seg(owner)}`)).type);

  let reposAt = 0;
  let reposP = null;
  /** The owner's repositories (archived and disabled left out), kept for 5 minutes. */
  function rawRepos() {
    if (!reposP || Date.now() - reposAt > 5 * 60_000) {
      reposAt = Date.now();
      reposP = (async () => {
        const [type, who] = await Promise.all([ownerType(), me()]);
        // Your own private repos are only listed through /user/repos.
        const path = type === 'Organization' ? `orgs/${seg(owner)}/repos`
          : who.uniqueName.toLowerCase() === owner.toLowerCase() ? 'user/repos' : `users/${seg(owner)}/repos`;
        const query = path === 'user/repos' ? { affiliation: 'owner' } : { type: 'all' };
        const list = await listAll(path, { query, max: 2000 });
        return list.filter((r) => !r.archived && !r.disabled);
      })().catch((e) => {
        reposP = null;
        throw e;
      });
    }
    return reposP;
  }
  const repoByName = async (name) => (await rawRepos()).find((r) => r.name === name) || null;

  // People's emails (login to email, '' when GitHub has none), kept for an hour, so a GitHub login
  // and an Azure DevOps account can be the same person: the address in the organization's verified
  // domains when GitHub gives it, else the public profile email. Verified-domain emails need the
  // organization to have verified a domain; when GitHub refuses them, ask for public emails only.
  const emails = new Map();
  let emailsAt = 0;
  let verifiedOk = true;
  async function emailsFor(logins) {
    if (Date.now() - emailsAt > 3_600_000) {
      emails.clear();
      emailsAt = Date.now();
      verifiedOk = true;
    }
    const missing = [...new Set(logins)].filter((l) => l && l !== 'ghost' && !emails.has(l));
    if (!missing.length) return emails;
    const isOrg = (await ownerType()) === 'Organization';
    const ask = (batch, verified) => graphql(
      `query(${verified ? '$org: String!, ' : ''}${batch.map((_, j) => `$l${j}: String!`).join(', ')}) { ${batch
        .map((_, j) => `u${j}: user(login: $l${j}) { email${verified ? ' organizationVerifiedDomainEmails(login: $org)' : ''} }`).join(' ')} }`,
      { ...(verified ? { org: owner } : {}), ...Object.fromEntries(batch.map((l, j) => [`l${j}`, l])) },
      { partial: true },
    );
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      try {
        // A login GitHub no longer knows (NOT_FOUND) only leaves its own answer empty; any other refusal is the verified emails'.
        let answer = isOrg && verifiedOk ? await ask(batch, true) : null;
        if (answer?.errors.some((e) => e.type !== 'NOT_FOUND')) {
          verifiedOk = false;
          answer = null;
        }
        answer ??= await ask(batch, false);
        batch.forEach((l, j) => {
          const u = answer.data[`u${j}`];
          emails.set(l, String(u?.organizationVerifiedDomainEmails?.[0] || u?.email || '').toLowerCase());
        });
      } catch (e) {
        console.warn(`[github] ${owner}: no emails for people (${e.message})`);
      }
    }
    return emails;
  }

  // Workflow and run ids are unique across GitHub, but the API addresses them under their repo:
  // remember each one's repo as it's listed, and look for an unknown one in the recently pushed repos.
  const repoOfWorkflow = new Map();
  const repoOfRun = new Map();
  async function findRepo(map, id, probe) {
    if (map.has(id)) return map.get(id);
    const recent = [...(await rawRepos())].sort((a, b) => Date.parse(b.pushed_at) - Date.parse(a.pushed_at)).slice(0, 30);
    for (const r of recent) {
      if (await probe(r.name).then(() => true, () => false)) {
        map.set(id, r.name);
        return r.name;
      }
    }
    throw err('Couldn\'t find that run or workflow in this GitHub owner\'s recent repositories.', 404);
  }
  const workflowRepo = (id) => findRepo(repoOfWorkflow, Number(id), (repo) => api(`${repoPath(repo)}/actions/workflows/${Number(id)}`));
  const runRepo = (id) => findRepo(repoOfRun, Number(id), (repo) => api(`${repoPath(repo)}/actions/runs/${Number(id)}`));

  const toRun = (r) => {
    repoOfRun.set(r.id, r.repository?.name);
    repoOfWorkflow.set(r.workflow_id, r.repository?.name);
    return normalizeRun(r, where);
  };
  const reposFor = async (repoIds, sinceDays) => {
    const all = await rawRepos();
    if (repoIds) return all.filter((r) => repoIds.includes(r.name));
    // Every repo: only those pushed to lately, so an owner with hundreds of repos stays affordable.
    const since = Date.now() - (sinceDays || 14) * 86_400_000;
    return all.filter((r) => Date.parse(r.pushed_at) >= since);
  };

  // A token with repo but not read:org can't see requested teams: drop them for the rest of this provider's life.
  let teams = true;
  async function prQuery(build, variables) {
    try {
      return await graphql(build(teams), variables);
    } catch (e) {
      if (!teams || !e.detail?.some?.((x) => x.type === 'INSUFFICIENT_SCOPES')) throw e;
      teams = false;
      return graphql(build(teams), variables);
    }
  }

  async function searchPRs(q) {
    const out = [];
    let after = null;
    do {
      const d = await prQuery(SEARCH, { q, after });
      out.push(...d.search.nodes.filter((n) => n?.number));
      after = d.search.pageInfo.hasNextPage ? d.search.pageInfo.endCursor : null;
    } while (after && out.length < 1000);
    const prs = out.map((n) => normalizePR(n, where));
    const people = prs.flatMap((p) => [p.author, p.closedBy, ...p.reviewers]).filter((p) => p && !p.isContainer && !p.isBot);
    const known = await emailsFor(people.map((p) => p.id));
    return prs.map((p) => withEmails(p, known));
  }

  async function prNodeId(repo, n) {
    const d = await graphql('query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { id } } }', { owner, name: repo, n: Number(n) });
    return d.repository.pullRequest.id;
  }

  /** Asks people (logins) and teams ("team:slug") to review. */
  async function requestReviewers(repo, number, ids) {
    const teams = ids.filter((id) => String(id).startsWith('team:')).map((id) => id.slice(5));
    const reviewers = ids.filter((id) => !String(id).startsWith('team:'));
    await api(`${repoPath(repo)}/pulls/${Number(number)}/requested_reviewers`, { method: 'POST', body: { reviewers, team_reviewers: teams } });
  }

  return {
    kind: 'github',
    orgUrl: `${bases.web}/${owner}`,
    fetchOrgImage,
    me,

    async listProjects() {
      return [{ id: projectId, name: projectName, description: '', webUrl: `${bases.web}/${owner}` }];
    },

    async listRepos() {
      return (await rawRepos())
        .map((r) => ({ id: r.name, name: r.name, projectId, projectName, defaultBranch: r.default_branch || null, webUrl: r.html_url }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    /** One search across the owner's repos; the service keeps the tracked ones. */
    async listPullRequests(_projectId, { status = 'active', closedAfter } = {}) {
      const scope = `${(await ownerType()) === 'Organization' ? 'org' : 'user'}:${owner}`;
      if (status === 'active') return searchPRs(`is:pr is:open archived:false ${scope}`);
      const since = closedAfter ? ` closed:>=${new Date(closedAfter).toISOString().slice(0, 10)}` : '';
      const prs = await searchPRs(`is:pr is:closed ${scope}${since}`);
      return closedAfter ? prs.filter((p) => p.closedAt && Date.parse(p.closedAt) >= Date.parse(closedAfter)) : prs;
    },

    async getPullRequest(_projectId, repoId, prId) {
      const [d, files] = await Promise.all([
        prQuery(DETAIL, { owner, name: repoId, n: Number(prId) }),
        listAll(`${repoPath(repoId)}/pulls/${Number(prId)}/files`, { max: 3000 })
          .then((list) => ({ iteration: null, total: list.length, truncated: list.length >= 3000, items: list.map(fileOf).sort((a, b) => a.path.localeCompare(b.path)) }))
          .catch((e) => ({ error: e.message, total: 0, truncated: false, items: [] })),
      ]);
      const raw = d.repository?.pullRequest;
      if (!raw) throw err('No such pull request.', 404);
      const auto = raw.autoMergeRequest;
      return {
        ...normalizePR(raw, where),
        description: raw.body || '',
        autoCompleteSetBy: auto ? person(auto.enabledBy) : null,
        completionOptions: auto ? { mergeStrategy: STRATEGY_OF[auto.mergeMethod] || 'squash', deleteSourceBranch: false, transitionWorkItems: false } : null,
        threads: threadsOf(raw),
        workItems: [],
        files,
        policies: policiesOf(raw),
      };
    },

    async getPullRequestWorkItemIds() {
      return [];
    },

    async getPullRequestCommitIds(_projectId, repoId, prId) {
      const list = await listAll(`${repoPath(repoId)}/pulls/${Number(prId)}/commits`, { max: 500 });
      return list.map((c) => c.sha);
    },

    async listBranches(_projectId, repoId) {
      const list = await listAll(`${repoPath(repoId)}/branches`, { max: 1000 });
      return list.map((b) => ({ name: b.name, pushedAt: null, pushedBy: null }));
    },

    async listCommits(_projectId, repoId, { branch, since, path, top = 300 } = {}) {
      try {
        const list = await listAll(`${repoPath(repoId)}/commits`, { query: { sha: branch, since, path: path?.replace(/^\//, '') }, max: top });
        return list.map(normalizeCommit);
      } catch (e) {
        // An unknown branch: GitHub says 404 or 422, the service expects 404.
        if (e.status === 422 || e.status === 409) throw Object.assign(e, { status: 404 });
        throw e;
      }
    },

    async listCommitsBetween(_projectId, repoId, from, to, { top = 300 } = {}) {
      const d = await api(`${repoPath(repoId)}/compare/${seg(from)}...${seg(to)}`);
      return (d.commits || []).map(normalizeCommit).reverse().slice(0, top);
    },

    async aheadBehind(_projectId, repoId, base, target) {
      const d = await api(`${repoPath(repoId)}/compare/${seg(base)}...${seg(target)}`);
      return { ahead: d.ahead_by ?? null, behind: d.behind_by ?? null };
    },

    async getCommit(_projectId, repoId, sha) {
      const c = await api(`${repoPath(repoId)}/commits/${seg(sha)}`);
      return { ...normalizeCommit(c), parents: (c.parents || []).map((p) => p.sha), files: (c.files || []).map(fileOf) };
    },

    async compareBranches(_projectId, repoId, source, target) {
      const templates = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'pull_request_template.md'];
      const [diff, existing, found] = await Promise.all([
        api(`${repoPath(repoId)}/compare/${seg(target)}...${seg(source)}`),
        api(`${repoPath(repoId)}/pulls`, { query: { head: `${owner}:${source}`, base: target, state: 'open' } }).catch(() => []),
        Promise.all(templates.map((p) => apiText(`${repoPath(repoId)}/contents/${p}`, { query: { ref: target } }).catch(() => null))),
      ]);
      const files = (diff.files || []).map(fileOf);
      return {
        ahead: diff.ahead_by ?? 0,
        behind: diff.behind_by ?? 0,
        commits: (diff.commits || []).slice(-100).reverse().map((c) => ({ id: c.sha, message: c.commit?.message || '', author: c.commit?.author?.name, date: c.commit?.author?.date })),
        files: { total: files.length, items: files },
        existing: existing.map((p) => ({ id: p.number, title: p.title, webUrl: p.html_url, projectId, repoId })),
        template: found.find(Boolean) || null,
      };
    },

    async createPullRequest(_projectId, repoId, pr) {
      const created = await api(`${repoPath(repoId)}/pulls`, {
        method: 'POST',
        body: { title: pr.title, head: pr.source, base: pr.target, body: pr.description || '', draft: !!pr.isDraft },
      });
      const people = (pr.reviewers || []).map((r) => r.id);
      if (people.length) await requestReviewers(repoId, created.number, people);
      if (pr.autoComplete && !pr.isDraft) {
        await graphql('mutation($id: ID!, $m: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $m }) { clientMutationId } }', {
          id: created.node_id, m: mergeMethod(pr.completionOptions?.mergeStrategy || 'squash').toUpperCase(),
        });
      }
      return { id: created.number, title: created.title, projectId, projectName, repoId, repoName: repoId, webUrl: created.html_url, key: `${projectId}/${repoId}/${created.number}` };
    },

    /** Approve (10) or request changes (-5, -10). GitHub has no "with suggestions" and can't take a review back. */
    async votePullRequest(_projectId, repoId, prId, vote) {
      if (vote === 5) throw err('GitHub has no "approve with suggestions". Approve, and add a comment.');
      if (vote === 0) throw err('GitHub can\'t take a review back from Keel. Dismiss it on GitHub.');
      const event = vote > 0 ? 'APPROVE' : 'REQUEST_CHANGES';
      await api(`${repoPath(repoId)}/pulls/${Number(prId)}/reviews`, {
        method: 'POST',
        // GitHub needs a few words with a change request.
        body: { event, ...(event === 'REQUEST_CHANGES' ? { body: 'Changes requested.' } : {}) },
      });
    },

    async addReviewer(_projectId, repoId, prId, reviewerId) {
      await requestReviewers(repoId, prId, [reviewerId]);
    },

    async commentPullRequest(_projectId, repoId, prId, content) {
      await api(`${repoPath(repoId)}/issues/${Number(prId)}/comments`, { method: 'POST', body: { body: content } });
    },

    // GitHub doesn't list a pull request's conflicting files; it shows them on its page.
    async listPullRequestConflicts() {
      return [];
    },

    async restartMerge() {
      throw err('GitHub checks merges again by itself after each push.');
    },

    async updatePullRequest(_projectId, repoId, prId, change) {
      const n = Number(prId);
      if (change.publish) {
        await graphql('mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }', { id: await prNodeId(repoId, n) });
      }
      if (change.abandon) await api(`${repoPath(repoId)}/pulls/${n}`, { method: 'PATCH', body: { state: 'closed' } });
      if (change.autoComplete === true) {
        await graphql('mutation($id: ID!, $m: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $m }) { clientMutationId } }', {
          id: await prNodeId(repoId, n), m: mergeMethod(change.completionOptions?.mergeStrategy).toUpperCase(),
        });
      }
      if (change.autoComplete === false) {
        await graphql('mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }', { id: await prNodeId(repoId, n) });
      }
      if (change.complete) {
        const o = change.completionOptions || {};
        if (o.bypassPolicy) throw err('Override branch protection on GitHub itself.');
        const method = mergeMethod(o.mergeStrategy);
        // Merge the commit we last saw, so a push that lands in between can't be merged unseen.
        const current = await api(`${repoPath(repoId)}/pulls/${n}`);
        const [title, ...rest] = String(o.mergeCommitMessage || '').split('\n');
        await api(`${repoPath(repoId)}/pulls/${n}/merge`, {
          method: 'PUT',
          body: { merge_method: method, sha: current.head.sha, ...(title.trim() ? { commit_title: title.trim(), commit_message: rest.join('\n').trim() } : {}) },
        });
        // Only a branch in this same repository; a fork's isn't ours to delete.
        if (o.deleteSourceBranch && current.head.repo?.full_name === current.base.repo?.full_name) {
          await api(`${repoPath(repoId)}/git/refs/heads/${current.head.ref.split('/').map(seg).join('/')}`, { method: 'DELETE' }).catch(() => {});
        }
      }
    },

    async listBuilds(_projectId, { sinceDays = 14, repoIds } = {}) {
      const created = `>=${new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10)}`;
      const repos = await reposFor(repoIds, sinceDays);
      const lists = await Promise.all(repos.map((r) => listAll(`${repoPath(r.name)}/actions/runs`, { query: { created }, max: 300, pick: (d) => d.workflow_runs })
        .catch((e) => (e.status === 404 ? [] : Promise.reject(e)))));
      return lists.flat().map(toRun);
    },

    /** Workflows people wrote (GitHub's own, like Dependabot's, have no file in .github/workflows). */
    async listDefinitions(_projectId, { repoIds } = {}) {
      const repos = await reposFor(repoIds, 90);
      const lists = await Promise.all(repos.map(async (r) => {
        const list = await listAll(`${repoPath(r.name)}/actions/workflows`, { pick: (d) => d.workflows }).catch(() => []);
        return list
          .filter((w) => w.state === 'active' && String(w.path).startsWith('.github/workflows/'))
          .map((w) => {
            repoOfWorkflow.set(w.id, r.name);
            return normalizeWorkflow(w, r, where);
          });
      }));
      return lists.flat();
    },

    async listDefinitionRuns(_projectId, definitionId, { top = 25 } = {}) {
      const repo = await workflowRepo(definitionId);
      const d = await api(`${repoPath(repo)}/actions/workflows/${Number(definitionId)}/runs`, { query: { per_page: top } });
      return (d.workflow_runs || []).map(toRun);
    },

    async getBuildTimeline(_projectId, buildId) {
      const repo = await runRepo(buildId).catch(() => null);
      if (!repo) return [];
      const base = `${repoPath(repo)}/actions/runs/${Number(buildId)}`;
      const [jobs, approvals, pending] = await Promise.all([
        listAll(`${base}/jobs`, { query: { filter: 'latest' }, pick: (d) => d.jobs }),
        api(`${base}/approvals`).catch(() => []),
        api(`${base}/pending_deployments`).catch(() => []),
      ]);
      return timelineOf(jobs, { approvals, pending });
    },

    async getBuildLogTail(_projectId, buildId, logId, lines = 60) {
      const repo = await runRepo(buildId);
      return logTail(await apiText(`${repoPath(repo)}/actions/jobs/${Number(logId)}/logs`), lines);
    },

    /** The commit a run built. */
    async getBuildChanges(_projectId, buildId) {
      const repo = await runRepo(buildId);
      const r = await api(`${repoPath(repo)}/actions/runs/${Number(buildId)}`);
      const c = r.head_commit;
      return c ? [{ id: c.id, message: String(c.message || '').split('\n')[0].slice(0, 200), author: c.author?.name || null, at: c.timestamp || null, webUrl: `${bases.web}/${owner}/${repo}/commit/${c.id}` }] : [];
    },

    // GitHub Actions has no test results API.
    async getBuildTests() {
      return null;
    },
    async getBuildFailedTests() {
      return null;
    },

    /** Runs of a pipeline that reached its environment: completed, not pull request runs, not canceled. */
    async listDeployments(target, { since }) {
      if (target.type !== 'pipeline') return [];
      const repo = await workflowRepo(target.definitionId);
      const list = await listAll(`${repoPath(repo)}/actions/workflows/${Number(target.definitionId)}/runs`, {
        query: { status: 'completed', created: `>=${String(since).slice(0, 10)}`, ...(target.branch ? { branch: target.branch } : {}) },
        max: 500,
        pick: (d) => d.workflow_runs,
      });
      return list.map(toRun)
        .filter((b) => b.reason !== 'pullRequest' && b.result !== 'canceled')
        .map((b) => ({
          id: b.id, label: b.buildNumber, at: b.finishedAt, startedAt: b.startedAt || b.queuedAt, status: b.result,
          by: b.requestedFor?.displayName || null, webUrl: b.webUrl, repoId: b.repoId, commit: b.commit, branch: b.sourceBranch,
        }));
    },

    /** Environment reviews waiting on someone, from the project's running runs. */
    async listPipelineApprovals(_projectId, _projectName, runningBuilds = []) {
      const lists = await Promise.all(runningBuilds.filter((b) => b.repoId).map((b) => api(`${repoPath(b.repoId)}/actions/runs/${b.id}/pending_deployments`)
        .then((pending) => approvalsOf(b, pending || []))
        .catch(() => [])));
      return lists.flat();
    },

    async decidePipelineApproval(_projectName, approvalId, status, comment) {
      const [repo, runId, envId] = String(approvalId).split('~');
      await api(`${repoPath(repo)}/actions/runs/${Number(runId)}/pending_deployments`, {
        method: 'POST',
        body: { environment_ids: [Number(envId)], state: status === 'approved' ? 'approved' : 'rejected', comment: comment || '' },
      });
    },

    async cancelBuild(_projectId, buildId) {
      const repo = await runRepo(buildId);
      await api(`${repoPath(repo)}/actions/runs/${Number(buildId)}/cancel`, { method: 'POST' });
      return { id: Number(buildId), status: 'cancelling' };
    },

    /** Starts a workflow on a branch (its default when none is given). It needs a workflow_dispatch trigger. */
    async queueBuild(_projectId, definitionId, branch) {
      const repo = await workflowRepo(definitionId);
      const r = await repoByName(repo);
      try {
        await api(`${repoPath(repo)}/actions/workflows/${Number(definitionId)}/dispatches`, { method: 'POST', body: { ref: branch || r?.default_branch || 'main' } });
      } catch (e) {
        if (e.status === 422 && /workflow_dispatch/i.test(e.message)) throw err('This workflow can\'t be started by hand: add "workflow_dispatch" to its "on:" triggers.');
        throw e;
      }
      // GitHub doesn't say which run it started.
      return { id: null, webUrl: `${r?.html_url || `${bases.web}/${owner}/${repo}`}/actions` };
    },

    // No work items, teams, sprints or classic releases on a GitHub source: empty answers, refused changes.
    async listTeams() {
      return [];
    },
    async listTeamMembers() {
      return [];
    },
    removeTeamMember: noWorkItems,
    async getTeamAreas() {
      return null;
    },
    async getTeamDefaultArea() {
      return null;
    },
    async getCurrentIteration() {
      return null;
    },
    async listIterations() {
      return [];
    },
    async getStateMap() {
      return {};
    },
    async getWorkItemTypes() {
      return [];
    },
    async queryWorkItems() {
      return [];
    },
    async queryWorkItemIds() {
      return [];
    },
    async getBoards() {
      return null;
    },
    async getHierarchy() {
      return { roots: [], links: [], items: [] };
    },
    async getWorkItems() {
      return [];
    },
    async getWorkItem() {
      throw err('GitHub sources have no work items in Keel.', 404);
    },
    reorderWorkItems: noWorkItems,
    updateWorkItem: noWorkItems,
    createWorkItem: noWorkItems,
    async listAttachments() {
      return [];
    },
    downloadAttachment: noWorkItems,
    uploadAttachment: noWorkItems,
    commentWorkItem: noWorkItems,
    async listReleases() {
      return [];
    },
    async listReleaseApprovals() {
      return [];
    },
    decideReleaseApproval: noReleases,
    createRelease: noReleases,
    deployReleaseStage: noReleases,
  };
}
