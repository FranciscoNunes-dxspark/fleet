// Flaky tests: tests that fail now and then on a pipeline's own branch and
// pass again without anyone fixing them. A green run passed all its tests, so
// only red runs need their test results read (see service.js flakyTests).
const isPrRun = (b) => b.reason === 'pullRequest' || String(b.sourceBranch || '').startsWith('refs/pull/');
const RED = new Set(['failed', 'partiallySucceeded']);

/** Most flaky first: how often it flipped between failing and passing, a same-commit re-run counting extra. */
export const byFlakiness = (a, b) => (b.flips + 2 * b.sameCommit) - (a.flips + 2 * a.sameCommit) || b.fails - a.fails || a.name.localeCompare(b.name);

/** "Shop.Tests.CartTests.Adds_an_item" → "CartTests.Adds_an_item". */
export const shortTestName = (name) => String(name).split('.').slice(-2).join('.');

/**
 * pipelines: health rows (domain/pipelines.js); builds: their runs; failedTests:
 * Map of run id → { failed: [{ name, title, error }] } for red runs, or null
 * when a run's tests couldn't be read. Up to `perPipeline` latest runs each.
 *
 * A test is flaky when it failed and then passed on the same commit (someone
 * ran it again), or failed at least twice with a pass in between. A test that
 * has failed every run since it first did is broken, not flaky.
 */
export function findFlakyTests({ pipelines = [], builds = [], failedTests = new Map(), perPipeline = 30 }) {
  const out = [];
  let runs = 0;
  let unreadable = 0;
  for (const p of pipelines) {
    const history = builds
      .filter((b) => b.projectId === p.projectId && b.definition.id === p.definition.id && b.status === 'completed' && b.result !== 'canceled'
        && !isPrRun(b) && b.sourceBranch === p.branch)
      .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))
      .slice(0, perPipeline)
      .reverse(); // oldest first
    if (!history.length) continue;
    runs += history.length;
    // Per run: the set of failed test names, "pass" (a green run), or null (unknown).
    const outcome = history.map((b) => {
      if (b.result === 'succeeded') return 'pass';
      if (!RED.has(b.result)) return null;
      const t = failedTests.get(b.id);
      if (!t) {
        unreadable++;
        return null;
      }
      return new Map(t.failed.map((x) => [x.name, x]));
    });
    const names = new Set(outcome.flatMap((o) => (o instanceof Map ? [...o.keys()] : [])));
    for (const name of names) {
      // true = failed, false = passed (a green run, or a red run where it didn't fail), null = unknown.
      const seq = outcome.map((o) => (o === 'pass' ? false : o instanceof Map ? o.has(name) : null));
      const fails = seq.filter((x) => x === true).length;
      const first = seq.indexOf(true);
      const last = seq.lastIndexOf(true);
      const passedAfterFirst = seq.slice(first + 1).some((x) => x === false);
      const passBetween = seq.slice(first + 1, last).some((x) => x === false);
      const sameCommit = history.some((b, i) => seq[i] === true && b.commit && history.slice(i + 1).some((c, j) => c.commit === b.commit && seq[i + 1 + j] === false));
      if (!passedAfterFirst || !(sameCommit || (fails >= 2 && passBetween))) continue;
      let flips = 0;
      let prev = null;
      for (const x of seq) {
        if (x === null) continue;
        if (prev !== null && x !== prev) flips++;
        prev = x;
      }
      const known = seq.filter((x) => x !== null).length;
      const lastRun = history[last];
      const detail = outcome[last].get(name);
      out.push({
        name,
        shortName: shortTestName(detail?.name || name),
        title: detail?.title || null,
        error: detail?.error || null,
        pipeline: { key: p.key, name: p.definition.name, projectName: p.projectName, branch: p.branch, org: p.org },
        fails,
        runs: known,
        failRate: known ? fails / known : null,
        flips,
        sameCommit,
        lastFailedAt: lastRun.finishedAt,
        lastFailedRun: { id: lastRun.id, buildNumber: lastRun.buildNumber, webUrl: lastRun.webUrl },
        // Failing in the latest run that tested it: it may be what's making the pipeline red right now.
        failingNow: seq.filter((x) => x !== null).at(-1) === true,
      });
    }
  }
  out.sort(byFlakiness);
  return { tests: out, analyzed: { pipelines: pipelines.length, runs, unreadable } };
}
