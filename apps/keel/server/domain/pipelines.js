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

/**
 * One row per pipeline definition. Health, pass rate and the run strip are
 * judged on the pipeline's home branch (PR validation runs ignored); "last
 * run" is simply its newest completed run, whatever branch or trigger.
 */
export function pipelineHealth(builds, repos) {
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
      .sort((a, b) => Date.parse(b.startedAt || b.queuedAt) - Date.parse(a.startedAt || a.queuedAt));
    const latest = completed[0] || null;
    const judged = completed.filter((b) => b.result !== 'canceled');
    const passRate = judged.length ? judged.filter((b) => b.result === 'succeeded').length / judged.length : null;

    let failStreak = 0;
    for (const b of judged) {
      if (b.result === 'failed') failStreak++;
      else break;
    }
    const lastGreen = judged.find((b) => b.result === 'succeeded');

    let health = 'unknown';
    if (latest?.result === 'failed') health = 'failing';
    else if (latest?.result === 'partiallySucceeded' || (passRate !== null && passRate < 0.8)) health = 'unstable';
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
      medianDurationMin: median(completed.filter((b) => b.startedAt).map((b) => (Date.parse(b.finishedAt) - Date.parse(b.startedAt)) / 60_000)),
    });
  }
  const order = { failing: 0, unstable: 1, healthy: 2, unknown: 3 };
  return rows.sort((a, b) => order[a.health] - order[b.health] || a.definition.name.localeCompare(b.definition.name));
}
