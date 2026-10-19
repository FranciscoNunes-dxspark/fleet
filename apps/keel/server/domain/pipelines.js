import { median } from './prs.js';

const AUTOMATIC = new Set(['individualCI', 'batchedCI', 'schedule', 'buildCompletion', 'resourceTrigger', 'triggered']);
const isPrRun = (b) => b.reason === 'pullRequest' || b.sourceBranch.startsWith('refs/pull/');
const byFinishDesc = (a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt);

/**
 * The branch a pipeline is "for". Environment pipelines often build one branch
 * that isn't the repo default (Prod on master, PreProd on preprod), and the
 * definition's own default branch doesn't say so (YAML filters live in the
 * file), so we learn it from history: the branch most of its automatic runs
 * use, then most of its manual runs, then the repo's default branch.
 */
export function homeBranch(runs, repoDefault) {
  const pick = (list) => {
    const counts = new Map();
    for (const b of list) counts.set(b.sourceBranch, (counts.get(b.sourceBranch) || 0) + 1);
    let best = null;
    for (const [branch, n] of counts) {
      // Ties go to the repo default, then to whichever branch ran most recently.
      const latest = Math.max(...list.filter((b) => b.sourceBranch === branch).map((b) => Date.parse(b.queuedAt || b.finishedAt || 0)));
      const score = [n, branch === repoDefault ? 1 : 0, latest];
      if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && (score[1] > best.score[1] || (score[1] === best.score[1] && score[2] > best.score[2])))) {
        best = { branch, score };
      }
    }
    return best?.branch || null;
  };
  const nonPr = runs.filter((b) => !isPrRun(b));
  return pick(nonPr.filter((b) => AUTOMATIC.has(b.reason))) || pick(nonPr) || repoDefault || null;
}

const minutesRun = (b) => (Date.parse(b.finishedAt) - Date.parse(b.startedAt)) / 60_000;

/**
 * Is the pipeline getting slower? The median duration of its runs in the last
 * 7 days against the 7 days before, when both have at least 3 runs:
 * { recentMin, beforeMin, change } (change 0.25 = 25% slower).
 */
export function durationTrend(runs, now = Date.now()) {
  const week = 7 * 86_400_000;
  const timed = runs.filter((b) => b.startedAt && b.finishedAt);
  const recent = timed.filter((b) => Date.parse(b.finishedAt) > now - week).map(minutesRun);
  const before = timed.filter((b) => Date.parse(b.finishedAt) <= now - week && Date.parse(b.finishedAt) > now - 2 * week).map(minutesRun);
  if (recent.length < 3 || before.length < 3) return null;
  const r = median(recent);
  const b = median(before);
  return { recentMin: r, beforeMin: b, change: b > 0 ? (r - b) / b : null };
}

/**
 * One row per pipeline definition. Health, pass rate and the run strip are
 * judged on the pipeline's home branch (PR validation runs ignored); "last
 * run" is simply its newest completed run, whatever branch or trigger.
 */
// The "Manual validation" task of an agentless job: someone resumes or rejects the run.
const MANUAL_VALIDATION = '2003ad3a-104a-451a-9238-60474ab294e6';
const isManualValidation = (r) => r.type === 'Task' && (r.task?.id === MANUAL_VALIDATION || r.task?.name === 'ManualValidation');

/**
 * A run that failed only because it wasn't approved: an environment's approval check
 * (Checkpoint.Approval) or a Manual validation task was declined (or timed out), and nothing
 * else failed. Azure DevOps reports such a run as failed; it isn't one: Keel calls it
 * "declined" and leaves it out of health, pass rate, streaks and deploys.
 *
 * A rejected Manual validation fails its task, and with it its job, phase and stage; those
 * failures are the rejection, not something broken. Any other failed task or job is.
 */
export function wasDeclined(timeline = []) {
  const rejected = timeline.filter((r) => isManualValidation(r) && r.result === 'failed');
  const notApproved = rejected.length > 0
    || timeline.some((r) => r.type === 'Checkpoint.Approval' && r.state === 'completed' && r.result !== 'succeeded' && r.result !== 'skipped');
  if (!notApproved) return false;
  const byRejection = new Set(rejected.map((r) => r.parentId)); // the jobs a rejected validation failed
  return !timeline.some((r) => r.result === 'failed'
    && ((r.type === 'Task' && !isManualValidation(r)) || (r.type === 'Job' && !byRejection.has(r.id))));
}

export function pipelineHealth(builds, repos, definitions = []) {
  const repoDefault = new Map(repos.map((r) => [r.id, r.defaultBranch]));
  const byDef = new Map();
  for (const b of builds) {
    const key = `${b.projectId}:${b.definition.id}`;
    if (!byDef.has(key)) byDef.set(key, []);
    byDef.get(key).push(b);
  }

  const rows = [];
  for (const runs of byDef.values()) {
    const first = runs[0];
    const branch = homeBranch(runs, repoDefault.get(first.repoId));
    const completedAll = runs.filter((b) => b.status === 'completed').sort(byFinishDesc);
    const completed = completedAll.filter((b) => !isPrRun(b) && b.sourceBranch === branch);
    const running = runs.filter((b) => b.status !== 'completed')
      .sort((a, b) => (a.status === 'notStarted') - (b.status === 'notStarted')
        || Date.parse(b.startedAt || b.queuedAt) - Date.parse(a.startedAt || a.queuedAt));
    const latest = completed[0] || null;
    // Canceled and declined runs (see wasDeclined) say nothing about whether the pipeline works.
    const judged = completed.filter((b) => b.result !== 'canceled' && b.result !== 'declined');
    const passRate = judged.length ? judged.filter((b) => b.result === 'succeeded').length / judged.length : null;

    let failStreak = 0;
    for (const b of judged) {
      if (b.result === 'failed') failStreak++;
      else break;
    }
    const lastGreen = judged.find((b) => b.result === 'succeeded');

    let health = 'unknown';
    if (judged[0]?.result === 'failed') health = 'failing';
    else if (judged[0]?.result === 'partiallySucceeded' || (passRate !== null && passRate < 0.8)) health = 'unstable';
    else if (latest) health = 'healthy';

    rows.push({
      key: `${first.projectId}:${first.definition.id}`,
      projectId: first.projectId,
      projectName: first.projectName,
      definition: first.definition,
      repoId: first.repoId,
      repoName: first.repoName,
      branch,
      health,
      latest,
      lastRun: completedAll[0] || null,
      running,
      passRate,
      failStreak,
      lastGreenAt: lastGreen?.finishedAt || null,
      runCount: judged.length,
      recent: completed.slice(0, 12).map((b) => ({ id: b.id, result: b.result, finishedAt: b.finishedAt, webUrl: b.webUrl, buildNumber: b.buildNumber })),
      medianDurationMin: median(completed.filter((b) => b.startedAt).map(minutesRun)),
      // Waiting for an agent before it started.
      medianQueueMin: median(completed.filter((b) => b.startedAt && b.queuedAt).map((b) => Math.max(0, (Date.parse(b.startedAt) - Date.parse(b.queuedAt)) / 60_000))),
      durationTrend: durationTrend(judged),
    });
  }
  // Pipelines with no runs in the window (or never run): listed, judged on nothing.
  const seen = new Set(rows.map((r) => r.key));
  for (const d of definitions) {
    const key = `${d.projectId}:${d.id}`;
    if (seen.has(key)) continue;
    rows.push({
      key,
      projectId: d.projectId,
      projectName: d.projectName,
      definition: { id: d.id, name: d.name, path: d.path },
      repoId: d.repoId,
      repoName: d.repoName,
      branch: d.defaultBranch || repoDefault.get(d.repoId) || null,
      health: 'unknown',
      latest: null,
      lastRun: d.lastRun || null,
      running: [],
      passRate: null,
      failStreak: 0,
      lastGreenAt: d.lastRun?.result === 'succeeded' ? d.lastRun.finishedAt : null,
      runCount: 0,
      recent: [],
      medianDurationMin: null,
      medianQueueMin: null,
      durationTrend: null,
      paused: !!d.paused,
      webUrl: d.webUrl || null,
    });
  }
  const order = { failing: 0, unstable: 1, healthy: 2, unknown: 3 };
  return rows.sort((a, b) => order[a.health] - order[b.health] || a.definition.name.localeCompare(b.definition.name));
}
