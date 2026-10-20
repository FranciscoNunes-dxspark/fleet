// Demo GitHub source: an in-memory GitHub API (the REST and GraphQL calls Keel makes) for an
// organization called octo-demo, handed to the real GitHub provider in place of its client.
// So demo data and tests go through the same mapping as a real GitHub owner, and write
// actions (reviews, merges, runs, deployment reviews) really change what it answers.
import { createGithubProvider } from '../github/provider.js';

const NOW = Date.now();
const H = 3_600_000;
const D = 24 * H;
const iso = (ms) => new Date(ms).toISOString();
const ago = (ms) => iso(NOW - ms);
const WEB = 'https://github.com';

const user = (login, name) => ({ login, name, avatarUrl: null, avatar_url: null });
const ME = user('lead-dev', 'You (Tech Lead)');
const PRIYA = user('priya-s', 'Priya Shah');
const MARCUS = user('marcus-c', 'Marcus Chen');
const SOFIA = user('sofia-a', 'Sofia Alvarez');
const BOT = { login: 'dependabot[bot]', avatarUrl: null };

const later = (ms, fn) => setTimeout(fn, ms).unref?.();
const notFound = (what) => Object.assign(new Error(`GitHub: ${what} not found`), { status: 404 });

/** A fresh demo owner (state is per provider, so tests don't see each other's changes). */
function demoData(owner) {
  const repo = (name, pushedDaysAgo, extra = {}) => ({
    name, full_name: `${owner}/${name}`, default_branch: 'main', html_url: `${WEB}/${owner}/${name}`,
    archived: false, disabled: false, pushed_at: ago(pushedDaysAgo * D), ...extra,
  });
  const repos = [repo('web-app', 0.2), repo('api', 0.5), repo('infra', 3), repo('legacy-tools', 400, { archived: true })];

  let sha = 0;
  const nextSha = () => (++sha).toString(16).padStart(40, 'a');
  // Each repo's main branch, newest first.
  const history = {};
  for (const r of repos) {
    history[r.name] = Array.from({ length: 12 }, (_, i) => ({
      sha: nextSha(),
      message: i === 2 ? 'Merge pull request #39 from octo-demo/dark-mode-tokens\n\nDark mode colour tokens' : i === 5 ? 'Retry flaky upload (#36)' : `Change ${12 - i} on ${r.name}`,
      author: [PRIYA, MARCUS, SOFIA, ME][i % 4],
      at: NOW - (i * 9 + 2) * H,
    }));
  }

  const pr = (repoName, number, title, author, o = {}) => ({
    repo: repoName, number, title, author, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
    createdAt: ago(o.ageH * H || 20 * H), closedAt: null, mergedBy: null, head: o.head || `feature/${number}`, base: 'main',
    headSha: nextSha(), labels: o.labels || [], autoMerge: null, requests: o.requests || [], reviews: o.reviews || [],
    body: o.body || `${title}.\n\n- [x] Tests\n- [ ] Docs`, comments: o.comments || [], threads: o.threads || [],
    checks: o.checks || [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: true }],
    reviewDecision: o.reviewDecision ?? 'REVIEW_REQUIRED',
    files: o.files || [{ filename: 'src/index.js', status: 'modified' }, { filename: `src/${number}.js`, status: 'added' }],
    ...o.extra,
  });
  const prs = [
    pr('web-app', 41, 'Dark mode toggle in settings', PRIYA, { ageH: 30, requests: [ME], labels: ['ui'] }),
    pr('api', 87, 'Rate limit the search endpoint', ME, { ageH: 20, reviews: [{ author: MARCUS, state: 'APPROVED' }], reviewDecision: 'APPROVED' }),
    pr('api', 85, 'Drop Node 18 support', SOFIA, {
      ageH: 70, reviews: [{ author: MARCUS, state: 'CHANGES_REQUESTED' }], reviewDecision: 'CHANGES_REQUESTED', extra: { mergeable: 'CONFLICTING' },
      threads: [{ id: 'T1', isResolved: false, path: 'package.json', comments: [{ author: MARCUS, body: 'CI images still use 18.', createdAt: ago(40 * H) }] }],
      checks: [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: true }, { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: false }],
    }),
    pr('web-app', 40, 'WIP: new onboarding flow', MARCUS, { ageH: 50, extra: { isDraft: true }, reviewDecision: null }),
    pr('infra', 12, 'Bump hashicorp/aws from 5.40 to 5.62', BOT, { ageH: 9 * 24, head: 'dependabot/terraform/aws-5.62', labels: ['dependencies'], reviewDecision: null }),
    { ...pr('web-app', 39, 'Dark mode colour tokens', PRIYA, { ageH: 80 }), state: 'MERGED', closedAt: ago(2 * D), mergedBy: PRIYA },
    { ...pr('api', 84, 'Experiment: GraphQL gateway', SOFIA, { ageH: 200 }), state: 'CLOSED', closedAt: ago(5 * D) },
  ];

  const workflows = [
    { id: 1001, name: 'CI', path: '.github/workflows/ci.yml', repo: 'web-app' },
    { id: 1002, name: 'Deploy', path: '.github/workflows/deploy.yml', repo: 'web-app', dispatch: true },
    { id: 2001, name: 'CI', path: '.github/workflows/ci.yml', repo: 'api', dispatch: true },
    { id: 2002, name: 'Release', path: '.github/workflows/release.yml', repo: 'api' },
    { id: 3001, name: 'Terraform plan', path: '.github/workflows/plan.yml', repo: 'infra' },
    { id: 9001, name: 'Dependabot Updates', path: 'dynamic/dependabot/dependabot-updates', repo: 'infra' },
  ];

  let runId = 70_000;
  const runs = [];
  const run = (wf, hoursAgo, conclusion, o = {}) => {
    const id = ++runId;
    const commit = history[wf.repo][Math.min(11, Math.floor(hoursAgo / 9))];
    const r = {
      id, workflow: wf, run_number: runs.filter((x) => x.workflow === wf).length + 1, event: o.event || 'push',
      status: o.status || 'completed', conclusion: o.status && o.status !== 'completed' ? null : conclusion,
      head_branch: o.branch || 'main', head_sha: commit.sha, created: NOW - hoursAgo * H, minutes: o.minutes || 6,
      actor: o.actor || [PRIYA, MARCUS, SOFIA, ME][id % 4], commit, declined: !!o.declined, approvals: o.approvals || [], pending: o.pending || [],
    };
    runs.push(r);
    return r;
  };
  // History, oldest first so run numbers count up.
  const ci = workflows[0];
  const deploy = workflows[1];
  const apiCi = workflows[2];
  for (let h = 300; h > 0; h -= 22) run(ci, h, h === 168 ? 'failure' : 'success');
  run(ci, 5, 'success', { event: 'pull_request', branch: 'feature/41' });
  for (let h = 290; h > 10; h -= 40) run(apiCi, h, 'success');
  run(apiCi, 6, 'failure');
  run(apiCi, 2, 'failure');
  for (let h = 250; h > 30; h -= 48) run(deploy, h, 'success', { event: 'workflow_dispatch', minutes: 9 });
  run(deploy, 26, 'failure', { event: 'workflow_dispatch', declined: true, approvals: [{ state: 'rejected', comment: 'Not during the freeze', user: MARCUS, environments: [{ id: 501, name: 'production' }] }] });
  run(deploy, 1, null, { event: 'workflow_dispatch', status: 'waiting', pending: [{ environment: { id: 501, name: 'production' }, current_user_can_approve: true, reviewers: [{ type: 'User', reviewer: ME }] }] });
  for (let h = 200; h > 0; h -= 50) run(workflows[3], h, 'success', { minutes: 12 });
  for (let h = 100; h > 0; h -= 30) run(workflows[4], h, 'success', { minutes: 2 });

  return { owner, repos, history, prs, workflows, runs, nextSha, nextRun: () => ++runId };
}

const STEP_NAMES = ['Set up job', 'Checkout', 'Install dependencies', 'Test', 'Complete job'];

/** A run's jobs, as GET .../runs/{id}/jobs gives them. */
function jobsOf(r) {
  const start = r.created + 30_000;
  const done = r.status === 'completed';
  const steps = (failAt) => STEP_NAMES.map((name, i) => ({
    name, number: i + 1, status: done || i < 2 ? 'completed' : 'in_progress',
    conclusion: !done && i >= 2 ? null : failAt != null && i > failAt ? 'skipped' : failAt === i ? 'failure' : 'success',
    started_at: iso(start + i * 40_000), completed_at: done ? iso(start + (i + 1) * 40_000) : null,
  }));
  if (r.workflow.name === 'Deploy') {
    const build = { id: r.id * 10 + 1, name: 'build', status: 'completed', conclusion: 'success', started_at: iso(start), completed_at: iso(start + 4 * 60_000), steps: steps(null) };
    const prod = {
      id: r.id * 10 + 2,
      name: 'deploy-production',
      status: r.status === 'waiting' || r.status === 'completed' ? r.status : 'in_progress',
      conclusion: r.status === 'waiting' ? null : r.conclusion,
      started_at: r.status === 'waiting' || r.declined ? null : iso(start + 5 * 60_000),
      completed_at: r.status === 'completed' ? iso(r.created + r.minutes * 60_000) : null,
      steps: r.status === 'waiting' || r.conclusion === 'failure' ? [] : steps(null),
    };
    return [build, prod];
  }
  const failAt = r.conclusion === 'failure' ? 3 : null;
  return [{ id: r.id * 10 + 1, name: 'test', status: r.status === 'completed' ? 'completed' : 'in_progress', conclusion: r.conclusion, started_at: iso(start), completed_at: done ? iso(r.created + r.minutes * 60_000) : null, steps: steps(failAt) }];
}

function createDemoApi(owner) {
  const db = demoData(owner);
  const repoOf = (name) => db.repos.find((r) => r.name === name) || (() => { throw notFound(`repo ${name}`); })();
  const prOf = (repo, n) => db.prs.find((p) => p.repo === repo && p.number === Number(n)) || (() => { throw notFound(`pull request ${n}`); })();
  const runOf = (id) => db.runs.find((r) => r.id === Number(id)) || (() => { throw notFound(`run ${id}`); })();

  const restCommit = (repo, c) => ({
    sha: c.sha, html_url: `${WEB}/${owner}/${repo}/commit/${c.sha}`,
    commit: { message: c.message, author: { name: c.author.name, email: `${c.author.login}@users.noreply.github.com`, date: iso(c.at) }, committer: { date: iso(c.at) } },
    author: { login: c.author.login },
  });
  const restRun = (r) => ({
    id: r.id, name: r.workflow.name, workflow_id: r.workflow.id, run_number: r.run_number, event: r.event, status: r.status, conclusion: r.conclusion,
    head_branch: r.head_branch, head_sha: r.head_sha, repository: { name: r.workflow.repo },
    created_at: iso(r.created), run_started_at: iso(r.created + 20_000), updated_at: iso(r.status === 'completed' ? r.created + r.minutes * 60_000 : NOW),
    html_url: `${WEB}/${owner}/${r.workflow.repo}/actions/runs/${r.id}`, actor: r.actor, triggering_actor: r.actor,
    head_commit: { id: r.commit.sha, message: r.commit.message, author: { name: r.commit.author.name }, timestamp: iso(r.commit.at) },
  });
  const runsWhere = (filter, query = {}) => {
    const since = /^>=(.*)$/.exec(query.created || '')?.[1];
    return db.runs
      .filter(filter)
      .filter((r) => !since || r.created >= Date.parse(since))
      .filter((r) => !query.status || r.status === query.status)
      .filter((r) => !query.branch || r.head_branch === query.branch)
      .sort((a, b) => b.created - a.created)
      .map(restRun);
  };
  const compare = (repo, base, head) => {
    const h = db.history[repo] || [];
    const bi = h.findIndex((c) => c.sha === base || (base === 'main' && c === h[0]));
    const hi = h.findIndex((c) => c.sha === head || (head === 'main' && c === h[0]));
    const between = bi >= 0 && hi >= 0 ? h.slice(hi, bi) : h.slice(0, 2);
    return {
      ahead_by: between.length, behind_by: bi >= 0 && hi > bi ? hi - bi : 0,
      commits: between.slice().reverse().map((c) => restCommit(repo, c)),
      files: [{ filename: 'src/index.js', status: 'modified' }, { filename: 'README.md', status: 'modified' }],
    };
  };

  // REST: [method, path pattern, handler(match, { query, body })].
  const routes = [
    ['GET', /^user$/, () => ({ login: ME.login, name: ME.name })],
    ['GET', /^users\/([^/]+)$/, () => ({ login: owner, type: 'Organization' })],
    ['GET', /^orgs\/[^/]+\/repos$/, () => db.repos],
    ['GET', /^repos\/[^/]+\/([^/]+)\/pulls\/(\d+)\/files$/, ([, r, n]) => prOf(r, n).files],
    ['GET', /^repos\/[^/]+\/([^/]+)\/pulls\/(\d+)\/commits$/, ([, r, n]) => [{ sha: prOf(r, n).headSha }]],
    ['GET', /^repos\/[^/]+\/([^/]+)\/pulls\/(\d+)$/, ([, r, n]) => {
      const p = prOf(r, n);
      return { number: p.number, head: { sha: p.headSha, ref: p.head, repo: { full_name: `${owner}/${r}` } }, base: { repo: { full_name: `${owner}/${r}` } } };
    }],
    ['GET', /^repos\/[^/]+\/([^/]+)\/pulls$/, ([, r], { query }) => db.prs.filter((p) => p.repo === r && p.state === 'OPEN' && `${owner}:${p.head}` === query.head && p.base === query.base)
      .map((p) => ({ number: p.number, title: p.title, html_url: `${WEB}/${owner}/${r}/pull/${p.number}` }))],
    ['POST', /^repos\/[^/]+\/([^/]+)\/pulls$/, ([, r], { body }) => {
      repoOf(r);
      const number = Math.max(...db.prs.filter((p) => p.repo === r).map((p) => p.number), 0) + 1;
      db.prs.push({
        repo: r, number, title: body.title, author: ME, state: 'OPEN', isDraft: !!body.draft, mergeable: 'MERGEABLE', createdAt: iso(Date.now()), closedAt: null, mergedBy: null,
        head: body.head, base: body.base, headSha: db.nextSha(), labels: [], autoMerge: null, requests: [], reviews: [], body: body.body || '', comments: [], threads: [],
        checks: [{ name: 'build', status: 'IN_PROGRESS', conclusion: null, isRequired: true }], reviewDecision: 'REVIEW_REQUIRED', files: [],
      });
      return { number, title: body.title, html_url: `${WEB}/${owner}/${r}/pull/${number}`, node_id: `PR_${r}_${number}` };
    }],
    ['POST', /^repos\/[^/]+\/([^/]+)\/pulls\/(\d+)\/requested_reviewers$/, ([, r, n], { body }) => {
      const p = prOf(r, n);
      const everyone = [ME, PRIYA, MARCUS, SOFIA];
      for (const login of body.reviewers || []) p.requests = [...p.requests.filter((u) => u.login !== login), everyone.find((u) => u.login === login) || user(login, login)];
      for (const slug of body.team_reviewers || []) p.requests.push({ slug, name: slug });
      return {};
    }],
    ['POST', /^repos\/[^/]+\/([^/]+)\/pulls\/(\d+)\/reviews$/, ([, r, n], { body }) => {
      const p = prOf(r, n);
      if (p.author.login === ME.login) throw Object.assign(new Error('GitHub POST failed (422): Can not approve your own pull request'), { status: 422 });
      const state = body.event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED';
      p.reviews = [...p.reviews.filter((x) => x.author.login !== ME.login), { author: ME, state }];
      p.requests = p.requests.filter((u) => u.login !== ME.login);
      p.reviewDecision = state === 'APPROVED' ? 'APPROVED' : 'CHANGES_REQUESTED';
      return {};
    }],
    ['POST', /^repos\/[^/]+\/([^/]+)\/issues\/(\d+)\/comments$/, ([, r, n], { body }) => {
      const p = prOf(r, n);
      p.comments.push({ id: `C${p.comments.length + 1}`, author: ME, body: body.body, createdAt: iso(Date.now()) });
      return {};
    }],
    ['PATCH', /^repos\/[^/]+\/([^/]+)\/pulls\/(\d+)$/, ([, r, n], { body }) => {
      const p = prOf(r, n);
      if (body.state === 'closed') Object.assign(p, { state: 'CLOSED', closedAt: iso(Date.now()) });
      return {};
    }],
    ['PUT', /^repos\/[^/]+\/([^/]+)\/pulls\/(\d+)\/merge$/, ([, r, n], { body }) => {
      const p = prOf(r, n);
      if (p.mergeable === 'CONFLICTING') throw Object.assign(new Error('GitHub PUT failed (405): Pull Request is not mergeable'), { status: 405 });
      if (body.sha && body.sha !== p.headSha) throw Object.assign(new Error('GitHub PUT failed (409): Head branch was modified'), { status: 409 });
      Object.assign(p, { state: 'MERGED', closedAt: iso(Date.now()), mergedBy: ME });
      db.history[r].unshift({ sha: db.nextSha(), message: body.merge_method === 'squash' ? `${p.title} (#${p.number})` : `Merge pull request #${p.number} from ${owner}/${p.head}`, author: ME, at: Date.now() });
      return { merged: true };
    }],
    ['DELETE', /^repos\/[^/]+\/[^/]+\/git\/refs\/heads\/.+$/, () => null],
    ['GET', /^repos\/[^/]+\/([^/]+)\/branches$/, ([, r]) => [{ name: 'main' }, ...db.prs.filter((p) => p.repo === r && p.state === 'OPEN').map((p) => ({ name: p.head }))]],
    ['GET', /^repos\/[^/]+\/([^/]+)\/commits$/, ([, r], { query }) => {
      if (query.sha && query.sha !== 'main' && !db.prs.some((p) => p.repo === r && p.head === query.sha)) throw Object.assign(new Error('GitHub: No commit found for SHA'), { status: 422 });
      const since = query.since ? Date.parse(query.since) : 0;
      return (db.history[r] || []).filter((c) => c.at >= since).map((c) => restCommit(r, c));
    }],
    ['GET', /^repos\/[^/]+\/([^/]+)\/commits\/([^/]+)$/, ([, r, s]) => {
      const h = db.history[r] || [];
      const i = h.findIndex((c) => c.sha === s);
      if (i < 0) throw notFound(`commit ${s}`);
      return { ...restCommit(r, h[i]), parents: h[i + 1] ? [{ sha: h[i + 1].sha }] : [], files: [{ filename: 'src/index.js', status: 'modified' }] };
    }],
    ['GET', /^repos\/[^/]+\/([^/]+)\/compare\/([^.]+)\.\.\.(.+)$/, ([, r, base, head]) => compare(r, decodeURIComponent(base), decodeURIComponent(head))],
    ['GET', /^repos\/[^/]+\/([^/]+)\/actions\/runs$/, ([, r], { query }) => ({ workflow_runs: runsWhere((x) => x.workflow.repo === r, query) })],
    ['GET', /^repos\/[^/]+\/([^/]+)\/actions\/workflows$/, ([, r]) => ({
      workflows: db.workflows.filter((w) => w.repo === r).map((w) => ({ id: w.id, name: w.name, path: w.path, state: 'active', html_url: `${WEB}/${owner}/${r}/actions/workflows/${w.path.split('/').pop()}` })),
    })],
    ['GET', /^repos\/[^/]+\/([^/]+)\/actions\/workflows\/(\d+)$/, ([, r, id]) => {
      const w = db.workflows.find((x) => x.id === Number(id) && x.repo === r);
      if (!w) throw notFound(`workflow ${id}`);
      return { id: w.id };
    }],
    ['GET', /^repos\/[^/]+\/([^/]+)\/actions\/workflows\/(\d+)\/runs$/, ([, r, id], { query }) => {
      const runs = runsWhere((x) => x.workflow.repo === r && x.workflow.id === Number(id), query);
      return { workflow_runs: query.per_page ? runs.slice(0, Number(query.per_page)) : runs };
    }],
    ['POST', /^repos\/[^/]+\/([^/]+)\/actions\/workflows\/(\d+)\/dispatches$/, ([, r, id], { body }) => {
      const w = db.workflows.find((x) => x.id === Number(id) && x.repo === r);
      if (!w) throw notFound(`workflow ${id}`);
      if (!w.dispatch) throw Object.assign(new Error("GitHub POST failed (422): Workflow does not have 'workflow_dispatch' trigger"), { status: 422 });
      const created = Date.now();
      const started = {
        id: db.nextRun(), workflow: w, run_number: db.runs.filter((x) => x.workflow === w).length + 1, event: 'workflow_dispatch', status: 'queued', conclusion: null,
        head_branch: body.ref, head_sha: db.history[r][0].sha, created, minutes: 6, actor: ME, commit: db.history[r][0], approvals: [], pending: [],
      };
      db.runs.push(started);
      // It starts after a few seconds and passes half a minute later, unless it's canceled first.
      later(5_000, () => started.status === 'queued' && Object.assign(started, { status: 'in_progress' }));
      later(30_000, () => started.status === 'in_progress' && Object.assign(started, { status: 'completed', conclusion: 'success', minutes: 0.5 }));
      return null;
    }],
    ['GET', /^repos\/[^/]+\/([^/]+)\/actions\/runs\/(\d+)$/, ([, r, id]) => {
      const run = runOf(id);
      if (run.workflow.repo !== r) throw notFound(`run ${id}`);
      return restRun(run);
    }],
    ['GET', /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs$/, ([, id]) => ({ jobs: jobsOf(runOf(id)) })],
    ['GET', /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/approvals$/, ([, id]) => runOf(id).approvals],
    ['GET', /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/pending_deployments$/, ([, id]) => runOf(id).pending],
    ['POST', /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/pending_deployments$/, ([, id], { body }) => {
      const run = runOf(id);
      run.pending = [];
      if (body.state === 'approved') {
        Object.assign(run, { status: 'in_progress' });
        later(20_000, () => Object.assign(run, { status: 'completed', conclusion: 'success', minutes: (Date.now() - run.created) / 60_000 }));
      }
      else {
        run.approvals.push({ state: 'rejected', comment: body.comment, user: ME, environments: [{ id: body.environment_ids[0], name: 'production' }] });
        Object.assign(run, { status: 'completed', conclusion: 'failure', declined: true, minutes: (Date.now() - run.created) / 60_000 });
      }
      return [];
    }],
    ['POST', /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/cancel$/, ([, id]) => {
      const run = runOf(id);
      if (run.status === 'completed') throw Object.assign(new Error('GitHub POST failed (409): Cannot cancel a workflow run that is completed.'), { status: 409 });
      Object.assign(run, { status: 'completed', conclusion: 'cancelled', pending: [], minutes: (Date.now() - run.created) / 60_000 });
      return null;
    }],
  ];

  function api(path, { method = 'GET', query = {}, body } = {}) {
    const url = new URL(path.startsWith('http') ? path : `https://api.github.com/${path}`);
    const clean = url.pathname.replace(/^\//, '');
    const q = { ...Object.fromEntries(url.searchParams), ...query };
    for (const [m, re, fn] of routes) {
      const match = m === method && re.exec(clean);
      if (match) {
        try {
          return Promise.resolve(structuredClone(fn(match.map((x) => (x === undefined ? x : decodeURIComponent(x))), { query: q, body })));
        } catch (e) {
          return Promise.reject(e);
        }
      }
    }
    return Promise.reject(notFound(`${method} ${clean}`));
  }

  async function apiText(path) {
    if (/\/contents\//.test(path)) {
      if (/\.github\/pull_request_template\.md$/.test(path)) return '## What\n\n## Why\n\n## How to test\n';
      throw notFound(path);
    }
    const job = /actions\/jobs\/(\d+)\/logs$/.exec(path);
    if (job) {
      const t = iso(NOW - H);
      return [`${t} ##[group]Run npm test`, `${t} > api@1.0.0 test`, `${t} > node --test`, `${t} \u001b[31m✖ search returns 429 after 30 requests (12ms)\u001b[0m`,
        `${t}   AssertionError: Expected 429, got 200`, `${t} ℹ tests 214`, `${t} ℹ pass 213`, `${t} ℹ fail 1`, `${t} ##[error]Process completed with exit code 1.`].join('\n');
    }
    throw notFound(path);
  }

  async function listAll(path, { query = {}, max = 1000, pick = (d) => d } = {}) {
    return (pick(await api(path, { query })) || []).slice(0, max);
  }

  // GraphQL: pull requests as the PR_FIELDS fragment and detail query ask for them.
  const who = (u) => (u ? { login: u.login, name: u.name, avatarUrl: null } : null);
  const node = (p) => ({
    number: p.number, title: p.title, url: `${WEB}/${owner}/${p.repo}/pull/${p.number}`, state: p.state, isDraft: p.isDraft, mergeable: p.mergeable,
    createdAt: p.createdAt, closedAt: p.closedAt, headRefName: p.head, baseRefName: p.base, repository: { name: p.repo },
    author: who(p.author), mergedBy: who(p.mergedBy), labels: { nodes: p.labels.map((name) => ({ name })) },
    autoMergeRequest: p.autoMerge ? { enabledAt: p.autoMerge.at, mergeMethod: p.autoMerge.method, enabledBy: who(ME) } : null,
    reviewRequests: { nodes: p.requests.map((u) => ({ requestedReviewer: u.slug ? { slug: u.slug, name: u.name } : who(u) })) },
    latestOpinionatedReviews: { nodes: p.reviews.map((r) => ({ state: r.state, author: who(r.author) })) },
    id: `PR_${p.repo}_${p.number}`, body: p.body, headRefOid: p.headSha, reviewDecision: p.reviewDecision,
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: p.checks.map((c) => ({ __typename: 'CheckRun', ...c })) } } } }] },
    reviewThreads: { totalCount: p.threads.length, nodes: p.threads.map((t) => ({ ...t, comments: { nodes: t.comments.map((c) => ({ ...c, author: who(c.author) })) } })) },
    comments: { totalCount: p.comments.length, nodes: p.comments.map((c) => ({ ...c, author: who(c.author) })) },
  });
  const byNodeId = (id) => db.prs.find((p) => `PR_${p.repo}_${p.number}` === id) || (() => { throw notFound(id); })();

  async function graphql(query, v = {}) {
    if (/search\(/.test(query)) {
      const open = /is:open/.test(v.q);
      const since = /closed:>=(\S+)/.exec(v.q)?.[1];
      const nodes = db.prs.filter((p) => (open ? p.state === 'OPEN' : p.state !== 'OPEN' && (!since || Date.parse(p.closedAt) >= Date.parse(since))))
        .filter((p) => db.repos.find((r) => r.name === p.repo && !r.archived)).map(node);
      return structuredClone({ search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } });
    }
    if (/markPullRequestReadyForReview/.test(query)) byNodeId(v.id).isDraft = false;
    else if (/enablePullRequestAutoMerge/.test(query)) byNodeId(v.id).autoMerge = { at: iso(Date.now()), method: v.m };
    else if (/disablePullRequestAutoMerge/.test(query)) byNodeId(v.id).autoMerge = null;
    else if (/repository\(/.test(query)) {
      const p = db.prs.find((x) => x.repo === v.name && x.number === v.n);
      return structuredClone({ repository: { pullRequest: p ? node(p) : null } });
    }
    return {};
  }

  return {
    bases: { rest: 'https://api.github.com', graphql: 'https://api.github.com/graphql', web: WEB },
    api,
    apiText,
    listAll,
    graphql,
    fetchOrgImage() {
      throw Object.assign(new Error('Images from GitHub open on GitHub'), { status: 400 });
    },
    db,
  };
}

/** The demo GitHub owner for an added GitHub organization (named after its address, octo-demo by default). */
export function createMockGithub(org = { key: 'gh-octo-demo', url: `${WEB}/octo-demo`, kind: 'github' }) {
  const owner = new URL(org.url).pathname.split('/').filter(Boolean)[0] || 'octo-demo';
  return createGithubProvider({ org, client: createDemoApi(owner) });
}
