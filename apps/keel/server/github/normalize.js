// GitHub's answers in the shapes Keel's providers share (see azdo/provider.js), as pure
// functions so they can be tested with hand-built payloads. People are identified by their
// login (id and uniqueName both), which REST and GraphQL agree on.

/** A GitHub user (REST or GraphQL) as an identity; teams are containers, like Azure DevOps groups. */
export function person(u) {
  if (!u) return null;
  if (u.slug) return { id: `team:${u.slug}`, displayName: u.name || u.slug, uniqueName: `team:${u.slug}`, imageUrl: null, isContainer: true };
  const login = u.login || '';
  const who = { id: login, displayName: u.name || login, uniqueName: login, imageUrl: u.avatarUrl || u.avatar_url || null, isContainer: false };
  // Apps such as Dependabot: GraphQL says Bot, REST says so in the type and the "[bot]" login.
  return u.__typename === 'Bot' || u.type === 'Bot' || /\[bot\]$/.test(login) ? { ...who, isBot: true } : who;
}

/**
 * The people of a normalized pull request with their email (from `emails`, login to email),
 * so they're recognised as the same person in Azure DevOps (sameIdentity in domain/prs.js).
 */
export function withEmails(pr, emails) {
  const add = (p) => (p && emails.get(p.id) ? { ...p, email: emails.get(p.id) } : p);
  return { ...pr, author: add(pr.author), closedBy: add(pr.closedBy), reviewers: pr.reviewers.map(add) };
}

// Review states as Azure DevOps votes: approved is 10, changes requested waits for the author (-5).
const VOTE = { APPROVED: 10, CHANGES_REQUESTED: -5 };

/**
 * Reviewers with votes: the latest approving or change-requesting review of each person, and
 * anyone asked to review who hasn't answered since (vote 0, so it waits on them). Someone who
 * only commented and wasn't asked isn't a reviewer, so it never "needs their review".
 */
export function reviewersOf(pr) {
  const out = new Map();
  for (const r of pr.latestOpinionatedReviews?.nodes || []) {
    if (!(r.state in VOTE) || !r.author) continue;
    out.set(r.author.login, { ...person(r.author), vote: VOTE[r.state], isRequired: false, hasDeclined: false });
  }
  // Asked again after reviewing: their earlier review no longer answers it.
  for (const q of pr.reviewRequests?.nodes || []) {
    const who = person(q.requestedReviewer);
    if (who) out.set(who.uniqueName, { ...who, vote: 0, isRequired: false, hasDeclined: false });
  }
  return [...out.values()];
}

const STATUS = { OPEN: 'active', MERGED: 'completed', CLOSED: 'abandoned' };
const MERGEABLE = { MERGEABLE: 'succeeded', CONFLICTING: 'conflicts', UNKNOWN: 'queued' };
// GitHub's StatusCheckRollupState: EXPECTED is a required status that hasn't reported yet.
const ROLLUP = { SUCCESS: 'passed', PENDING: 'running', EXPECTED: 'running', FAILURE: 'failed', ERROR: 'failed' };

/** A pull request from GraphQL (the PR_FIELDS fragment in provider.js). */
export function normalizePR(n, { projectId, projectName }) {
  const repo = n.repository?.name;
  const status = STATUS[n.state] || 'active';
  return {
    key: `${projectId}/${repo}/${n.number}`,
    id: n.number,
    title: n.title,
    projectId,
    projectName,
    repoId: repo,
    repoName: repo,
    author: person(n.author) || { id: 'ghost', displayName: 'ghost', uniqueName: 'ghost', imageUrl: null, isContainer: false },
    createdAt: n.createdAt,
    closedAt: n.closedAt || null,
    closedBy: status === 'completed' ? person(n.mergedBy) : null,
    status,
    isDraft: !!n.isDraft,
    // GitHub works out whether it merges cleanly in the background; until then it's "queued".
    mergeStatus: status === 'active' ? MERGEABLE[n.mergeable] || 'notSet' : status === 'completed' ? 'succeeded' : 'notSet',
    mergeFailureMessage: null,
    sourceBranch: n.headRefName,
    targetBranch: n.baseRefName,
    reviewers: reviewersOf(n),
    labels: (n.labels?.nodes || []).map((l) => l.name),
    autoComplete: !!n.autoMergeRequest,
    // Whether the branch asks for an approving review (GitHub's reviewDecision is null when it doesn't).
    reviewRequired: n.reviewDecision != null,
    // Its checks on the latest commit, all together (tests, builds, commit statuses): a pull request
    // waits while they run (domain/prs.js prFlow). Null when it has none.
    checks: ROLLUP[n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state] ?? null,
    webUrl: n.url,
  };
}

const CHECK_DONE = { SUCCESS: 'approved', NEUTRAL: 'approved', SKIPPED: 'approved' };
const CHECK_RUNNING = { IN_PROGRESS: 'running' };
const STATUS_STATE = { SUCCESS: 'approved', FAILURE: 'rejected', ERROR: 'rejected', PENDING: 'running', EXPECTED: 'queued' };
const DECISION = { APPROVED: 'approved', CHANGES_REQUESTED: 'rejected', REVIEW_REQUIRED: 'queued' };

/**
 * A pull request's checks as branch policies ({ name, status, isBlocking }): its checks and
 * commit statuses on the latest commit (blocking when branch protection requires them), and the
 * required review when the branch asks for one.
 */
export function policiesOf(pr) {
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
  const out = contexts.map((c) => (c.__typename === 'StatusContext'
    ? { name: c.context, status: STATUS_STATE[c.state] || 'queued', isBlocking: !!c.isRequired }
    : {
      name: c.name,
      status: c.status === 'COMPLETED' ? CHECK_DONE[c.conclusion] || 'rejected' : CHECK_RUNNING[c.status] || 'queued',
      isBlocking: !!c.isRequired,
    }));
  if (DECISION[pr.reviewDecision]) out.unshift({ name: 'Required reviews', status: DECISION[pr.reviewDecision], isBlocking: true });
  return out;
}

/** Review threads and conversation comments as Azure DevOps-style threads, newest 15 comments. */
export function threadsOf(pr) {
  const reviewThreads = pr.reviewThreads?.nodes || [];
  const conversation = pr.comments?.nodes || [];
  const comment = (c, extra) => ({ author: person(c.author), content: c.body || '', publishedAt: c.createdAt, ...extra });
  return {
    total: (pr.reviewThreads?.totalCount || 0) + (pr.comments?.totalCount || 0),
    active: reviewThreads.filter((t) => !t.isResolved).length,
    recent: [
      ...reviewThreads.flatMap((t) => (t.comments?.nodes || []).map((c) => comment(c, { threadId: t.id, status: t.isResolved ? 'fixed' : 'active', filePath: t.path ? `/${t.path}` : null }))),
      ...conversation.map((c) => comment(c, { threadId: c.id, status: null, filePath: null })),
    ]
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, 15),
  };
}

const FILE_KIND = { added: 'added', removed: 'deleted', renamed: 'renamed', copied: 'added' };

/** A changed file (REST pulls/commits files); paths start with "/", as Azure DevOps' do. */
export const fileOf = (f) => {
  const kind = FILE_KIND[f.status] || 'edited';
  return { path: `/${f.filename}`, kind, originalPath: kind === 'renamed' && f.previous_filename ? `/${f.previous_filename}` : null };
};

/** A REST commit (list or single). */
export function normalizeCommit(c) {
  return {
    id: c.sha,
    message: c.commit?.message || '',
    truncated: false,
    author: { name: c.commit?.author?.name || c.author?.login || '', email: c.commit?.author?.email || '', date: c.commit?.author?.date || null },
    committedAt: c.commit?.committer?.date || null,
    changes: null,
    webUrl: c.html_url || null,
  };
}

const RUN_STATUS = { completed: 'completed', in_progress: 'inProgress', waiting: 'inProgress' };
const RUN_RESULT = { success: 'succeeded', neutral: 'succeeded', failure: 'failed', timed_out: 'failed', startup_failure: 'failed', action_required: 'failed', cancelled: 'canceled', skipped: 'canceled', stale: 'canceled' };
// What started a run, in Azure DevOps' words; pull request runs are left out of health and deploys.
const REASON = { push: 'individualCI', schedule: 'schedule', pull_request: 'pullRequest', pull_request_target: 'pullRequest', workflow_dispatch: 'manual', workflow_run: 'buildCompletion' };

/** A workflow run as a build. Its "folder" is its repository, so the Pipelines page groups by repo. */
export function normalizeRun(r, { projectId, projectName }) {
  const repo = r.repository?.name || null;
  const status = RUN_STATUS[r.status] || 'notStarted';
  return {
    id: r.id,
    projectId,
    projectName,
    definition: { id: r.workflow_id, name: r.name, path: repo ? `\\${repo}` : '\\' },
    buildNumber: `#${r.run_number}`,
    status,
    result: status === 'completed' ? RUN_RESULT[r.conclusion] || 'failed' : null,
    reason: REASON[r.event] || 'triggered',
    sourceBranch: r.head_branch || null,
    repoId: repo,
    repoName: repo,
    commit: r.head_sha || null,
    requestedFor: person(r.triggering_actor || r.actor),
    queuedAt: r.created_at,
    startedAt: r.run_started_at || null,
    finishedAt: status === 'completed' ? r.updated_at : null,
    webUrl: r.html_url,
  };
}

/** A workflow as a pipeline definition. Disabled ones and GitHub's own (Dependabot, Pages) are left out by the caller. */
export function normalizeWorkflow(w, repo, { projectId, projectName }) {
  return {
    id: w.id,
    name: w.name,
    path: `\\${repo.name}`,
    projectId,
    projectName,
    repoId: repo.name,
    repoName: repo.name,
    defaultBranch: repo.default_branch || null,
    paused: false,
    lastRun: null,
    webUrl: w.html_url || `${repo.html_url}/actions/workflows/${String(w.path).split('/').pop()}`,
  };
}

// A job waiting on an environment's reviewers is under way: its stage is the one the run is on.
const JOB_STATE = { completed: 'completed', in_progress: 'inProgress', waiting: 'inProgress' };
const JOB_RESULT = { success: 'succeeded', neutral: 'succeeded', failure: 'failed', timed_out: 'failed', cancelled: 'canceled', skipped: 'skipped' };
const state = (s) => JOB_STATE[s] || 'pending';
const result = (s, c) => (s === 'completed' ? JOB_RESULT[c] || 'failed' : null);

/**
 * A run's timeline in Azure DevOps' terms (domain/pipelines.js reads it): each job is a stage
 * with one job under it, its steps are tasks, and an environment's review is the stage's
 * approval checkpoint. GitHub logs are per job, so a failed step's log is its job's.
 *
 * A job waiting on an environment's reviewers gets a pending approval, so the run shows as
 * waiting. A rejected review never starts its job, which GitHub then reports as failed: that
 * job is marked canceled behind a declined approval, so the run counts as declined, not failed.
 */
export function timelineOf(jobs = [], { approvals = [], pending = [] } = {}) {
  const records = [];
  const rejections = approvals.filter((a) => a.state === 'rejected');
  const neverRan = (j) => j.conclusion === 'failure' && !(j.steps || []).some((s) => s.conclusion && s.conclusion !== 'skipped');
  let waitingIndex = 0;
  let rejectedIndex = 0;
  jobs.forEach((j, i) => {
    const stageId = `stage-${j.id}`;
    const jobId = `job-${j.id}`;
    const declined = rejections.length > 0 && neverRan(j);
    const base = { order: i + 1, startedAt: j.started_at || null, finishedAt: j.completed_at || null, errorCount: 0, warningCount: 0, issues: [], logId: null, task: null };
    const jobResult = declined ? 'canceled' : result(j.status, j.conclusion);
    records.push({ ...base, id: stageId, parentId: null, type: 'Stage', name: j.name, state: state(j.status), result: jobResult });
    records.push({ ...base, id: jobId, parentId: stageId, type: 'Job', name: j.name, state: state(j.status), result: jobResult });
    for (const s of j.steps || []) {
      const r = result(s.status, s.conclusion);
      records.push({
        ...base,
        id: `step-${j.id}-${s.number}`,
        parentId: jobId,
        type: 'Task',
        name: s.name,
        order: s.number,
        state: state(s.status),
        result: r,
        startedAt: s.started_at || null,
        finishedAt: s.completed_at || null,
        logId: r === 'failed' ? j.id : null,
      });
    }
    const gate = (env, extra) => records.push({ ...base, id: `approval-${j.id}-${env?.id ?? i}`, parentId: stageId, type: 'Checkpoint.Approval', name: `Approval: ${env?.name || 'environment'}`, ...extra });
    if (j.status === 'waiting' && pending[waitingIndex]) gate(pending[waitingIndex++].environment, { state: 'inProgress', result: null });
    if (declined && rejections[rejectedIndex]) gate(rejections[rejectedIndex++].environments?.[0], { state: 'completed', result: 'rejected' });
  });
  return records;
}

/** Log text without GitHub's timestamps and colour codes, last `lines` lines. */
export function logTail(text, lines = 60) {
  return String(text || '').trimEnd().split(/\r?\n/).slice(-lines)
    .map((l) => l.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\u001b\[[0-9;]*m/g, ''))
    .join('\n').trimEnd();
}

/**
 * Pending environment reviews of a waiting run as approvals, the shape YAML approvals have.
 * The id carries what deciding needs (repo, run and environment), joined with "~".
 */
export function approvalsOf(build, pending = []) {
  return pending.map((p) => ({
    kind: 'yaml',
    id: `${build.repoId}~${build.id}~${p.environment?.id}`,
    projectId: build.projectId,
    projectName: build.projectName,
    pipeline: build.definition.name,
    stage: p.environment?.name || null,
    run: { id: build.id, name: build.buildNumber, webUrl: build.webUrl, branch: build.sourceBranch },
    createdOn: build.startedAt || build.queuedAt,
    instructions: '',
    minRequired: 1,
    approvers: (p.reviewers || []).map((r) => person(r.reviewer)).filter(Boolean),
    canDecide: !!p.current_user_can_approve,
  }));
}
