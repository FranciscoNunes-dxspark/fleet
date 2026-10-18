// Commit history: what a commit message points at, and the list the Commits
// page shows (newest first, across repos).

/**
 * Work items a commit mentions (#123, AB#123) and the pull request that made
 * it, when it's the merge commit Azure DevOps writes ("Merged PR 123: ...").
 */
export function commitRefs(message = '') {
  const text = String(message);
  const workItemIds = [...new Set([...text.matchAll(/(?:AB)?#(\d{2,7})\b/g)].map((m) => Number(m[1])))].slice(0, 20);
  const pr = text.match(/^Merged PR (\d+):/);
  return { workItemIds, prId: pr ? Number(pr[1]) : null };
}

/** When a commit reached its branch: its committer date (a merge, rebase or cherry-pick), else its author date. */
export const landedAt = (c) => c.committedAt || c.author?.date || null;

/**
 * How much is waiting to ship, counted as people count changes: each merged
 * pull request is one change (however many commits it brought) and each
 * commit pushed without one is one. The oldest is timed from when it reached
 * the branch (the PR's merge), not from when its code was first written.
 */
export function waitingChanges({ pullRequests = [], directCommits = [] }) {
  const landed = [...pullRequests.map((p) => p.commits?.[0]), ...directCommits]
    .map((c) => Date.parse(c && landedAt(c)))
    .filter(Number.isFinite);
  return {
    waiting: pullRequests.length + directCommits.length,
    oldestAt: landed.length ? new Date(Math.min(...landed)).toISOString() : null,
  };
}

/** The commits of several repos as one list, newest first, each with its repo and what it refers to. */
export function mergeCommits(perRepo, { limit = 2000 } = {}) {
  const all = [];
  for (const { repo, commits } of perRepo) {
    for (const c of commits || []) {
      all.push({
        ...c,
        ...commitRefs(c.message),
        subject: String(c.message || '').split('\n')[0].trim(),
        repoId: repo.id,
        repoName: repo.name,
        projectId: repo.projectId,
        projectName: repo.projectName,
      });
    }
  }
  return all
    .sort((a, b) => (Date.parse(b.author?.date) || 0) - (Date.parse(a.author?.date) || 0))
    .slice(0, limit);
}
