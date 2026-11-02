// One change's path along the Line, end to end: the work item planned and started, its pull
// requests reviewed and merged, the run that built the merge, each production target it's
// waiting for, being deployed to or already in, and how that app is doing now. Pure, from what
// the app already has: the work item, its pull requests, the pipelines, the deploy targets
// (/deploys/pending) and the production monitors. Steps are codes; Trace.jsx words them.
//
// Without merge commits, "built" is the first run of a pipeline on the repo's target branch that
// finished after the merge, and "deployed" means merged before the target's latest deploy and not
// among the changes it's still waiting to ship: close, and exact for the waiting ones. A target with
// a Development branch is exact: what it has and the production branch hasn't is waiting, the rest live.

const time = (iso) => (iso ? Date.parse(iso) : NaN);

/**
 * steps: [{ stage, code, state: 'done'|'now'|'todo'|'bad', at, … what its sentence needs }], in path order.
 */
export function traceChange({ workItem = null, prs = [], pipelines = [], targets = [], monitors = [] } = {}) {
  const steps = [];
  const cat = workItem?.stateCategory;

  if (workItem) {
    steps.push({ stage: 'planned', code: 'created', state: 'done', at: workItem.createdAt });
    if (workItem.activatedAt || cat === 'InProgress' || cat === 'Resolved' || cat === 'Completed') {
      steps.push({ stage: 'building', code: 'started', state: prs.length || cat === 'Completed' ? 'done' : 'now', at: workItem.activatedAt || workItem.stateChangedAt });
    } else {
      steps.push({ stage: 'building', code: 'not-started', state: 'todo' });
    }
  }

  if (!prs.length) {
    steps.push({ stage: 'review', code: 'no-prs', state: 'todo' });
    if (workItem && cat === 'Completed') steps.push({ stage: 'live', code: 'closed-without-code', state: 'done', at: workItem.closedAt });
    return steps;
  }

  for (const pr of prs) {
    const merged = pr.status === 'completed';
    const abandoned = pr.status === 'abandoned';
    steps.push({
      stage: 'review', code: abandoned ? 'pr-abandoned' : merged ? 'pr-reviewed' : 'pr-open', pr: brief(pr),
      state: abandoned ? 'bad' : merged ? 'done' : 'now', at: pr.createdAt,
    });
    if (abandoned) continue;
    if (!merged) {
      steps.push({ stage: 'merged', code: 'not-merged', state: 'todo', pr: brief(pr) });
      continue;
    }
    steps.push({ stage: 'merged', code: 'merged', state: 'done', at: pr.closedAt, pr: brief(pr), branch: shortBranch(pr.targetBranch) });

    // The first run after the merge, of a pipeline judged on that repo and branch. Keel holds each
    // pipeline's latest runs only: when they don't reach back to the merge, the first one it has
    // after it may not be the one that built it, so it says it was built since instead.
    const all = pipelines
      .filter((p) => p.repoId === pr.repoId && sameBranch(p.branch, pr.targetBranch))
      .flatMap((p) => (p.recent || []).map((r) => ({ ...r, pipeline: p.definition?.name, key: p.key })));
    const reaches = all.some((r) => time(r.finishedAt) <= time(pr.closedAt));
    const built = all.filter((r) => time(r.finishedAt) >= time(pr.closedAt)).sort((a, b) => time(a.finishedAt) - time(b.finishedAt))[0];
    if (built && !reaches) {
      steps.push({ stage: 'deploying', code: 'built-since', state: 'done', pipeline: built.pipeline });
    } else if (built) {
      steps.push({
        stage: 'deploying', code: 'built', state: built.result === 'failed' ? 'bad' : 'done', at: built.finishedAt,
        result: built.result, pipeline: built.pipeline, label: built.buildNumber, open: { type: 'pipeline', key: built.key, buildId: built.id },
      });
    } else {
      steps.push({ stage: 'deploying', code: 'not-built', state: 'todo', pr: brief(pr) });
    }

    // Each production target that deploys this repo's branch, or whose Development branch it merged into.
    const mine = targets.filter((t) => t.repo?.id === pr.repoId && (sameBranch(t.branch, pr.targetBranch) || (t.devBranch && sameBranch(t.devBranch, pr.targetBranch))));
    if (!mine.length) steps.push({ stage: 'deploying', code: 'no-target', state: 'todo', repo: pr.repoName });
    for (const t of mine) {
      const waiting = (t.commits || []).some((c) => c.prId === pr.id) || (t.pullRequests || []).some((p) => p.id === pr.id);
      const monitor = monitors.find((m) => m.targetKey === t.key);
      if (waiting) {
        steps.push({ stage: 'merged', code: t.deploy ? (t.deploy.state === 'approval' ? 'awaiting-approval' : 'deploying') : 'waiting', state: 'now', target: t.name, at: pr.closedAt, label: t.deploy?.label });
      } else if (t.devBranch && !t.missingBranch && !t.error) {
        // On the production branch already (it isn't among what the Development branch has waiting): live.
        steps.push({ stage: 'deploying', code: 'on-production-branch', state: 'done', target: t.name, branch: t.branch });
        if (monitor) steps.push({ stage: 'live', code: `monitor-${monitor.state || 'unknown'}`, state: monitor.state === 'down' || monitor.state === 'degraded' ? 'bad' : 'done', name: monitor.name });
      } else if (t.lastDeploy && time(t.lastDeploy.at) >= time(pr.closedAt)) {
        steps.push({ stage: 'deploying', code: 'deployed', state: 'done', target: t.name, at: t.lastDeploy.at, label: t.lastDeploy.label });
        if (monitor) steps.push({ stage: 'live', code: `monitor-${monitor.state || 'unknown'}`, state: monitor.state === 'down' || monitor.state === 'degraded' ? 'bad' : 'done', name: monitor.name });
      } else {
        steps.push({ stage: 'merged', code: 'waiting', state: 'now', target: t.name, at: pr.closedAt });
      }
    }
  }
  return steps;
}

const brief = (pr) => ({ id: pr.id, title: pr.title, repoName: pr.repoName, projectId: pr.projectId, repoId: pr.repoId });
const shortBranch = (ref) => String(ref || '').replace(/^refs\/heads\//, '');
const sameBranch = (a, b) => shortBranch(a) === shortBranch(b);

/** Where the change is now: the first step that's under way, else the furthest one reached (done, or reached and in trouble). */
export function whereNow(steps) {
  const order = ['planned', 'building', 'review', 'merged', 'deploying', 'live'];
  const now = steps.filter((s) => s.state === 'now');
  if (now.length) return now.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage))[0].stage;
  const done = steps.filter((s) => s.state === 'done' || s.state === 'bad');
  return done.length ? done.sort((a, b) => order.indexOf(b.stage) - order.indexOf(a.stage))[0].stage : 'planned';
}
