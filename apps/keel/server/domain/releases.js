// Classic release pipelines: per stage, what was last deployed and what is
// deploying now, plus an overall health like build pipelines have.

export const FINISHED = new Set(['succeeded', 'partiallySucceeded', 'rejected', 'canceled']);
export const ACTIVE = new Set(['inProgress', 'queued', 'scheduled']);

/**
 * stageDefs: [{ id, name, rank }]; releases newest first, each with
 * envs: [{ definitionEnvironmentId, id, status, at, requestedFor, reason }].
 */
export function stageSummary(stageDefs, releases) {
  return [...stageDefs].sort((a, b) => a.rank - b.rank).map((sd) => {
    let latest = null;
    let active = null;
    for (const r of releases) {
      const e = r.envs.find((x) => x.definitionEnvironmentId === sd.id);
      if (!e) continue;
      const snap = {
        releaseId: r.id, releaseName: r.name, environmentId: e.id, status: e.status, at: e.at || r.createdOn,
        requestedFor: e.requestedFor || null, reason: e.reason || null, webUrl: r.webUrl,
      };
      if (!active && ACTIVE.has(e.status)) active = snap;
      if (FINISHED.has(e.status)) {
        latest = snap;
        break;
      }
    }
    return { id: sd.id, name: sd.name, rank: sd.rank, latest, active };
  });
}

/** Failing if any stage's last deployment failed; unstable on partial success. */
export function releaseHealth(stages) {
  const last = stages.map((s) => s.latest).filter(Boolean);
  if (last.some((l) => l.status === 'rejected')) return 'failing';
  if (last.some((l) => l.status === 'partiallySucceeded')) return 'unstable';
  if (last.length) return 'healthy';
  return 'unknown';
}
