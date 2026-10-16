// Turns two consecutive snapshots of what the lead cares about into the
// notifications worth interrupting them for. Pure, so it's easy to test.

// Whole sentences (not fragments), so they read well and translate cleanly.
const VOTE_TITLE = {
  10: (n) => `${n} approved your pull request`,
  5: (n) => `${n} approved your pull request with suggestions`,
  '-5': (n) => `${n} is waiting for changes on your pull request`,
  '-10': (n) => `${n} rejected your pull request`,
};
const RUN_TITLE = {
  succeeded: (p) => `Your run of ${p} succeeded`,
  partiallySucceeded: (p) => `Your run of ${p} partially succeeded`,
  failed: (p) => `Your run of ${p} failed`,
  canceled: (p) => `Your run of ${p} was canceled`,
};

const CATEGORY_BY_KIND = { approval: 'approval', review: 'review', pipeline: 'pipeline', work: 'work', pr: 'pr', production: 'production' };

/**
 * snapshot = {
 *   attention: [{ key, kind, severity, title, reasons: [{ text }], target, webUrl }],
 *   myPrs: [{ key, id, title, projectId, repoId, status, reviewers: [{ id, displayName, vote, isContainer }] }],
 *   runs: [{ id, definition: { name }, status, result, buildNumber, sourceBranch, webUrl, mine }],
 * }
 */
export function diffSnapshots(prev, next) {
  if (!prev) return []; // first look: establish a baseline, don't announce history
  const out = [];

  // New inbox entries worth an interruption: anything high-priority, plus review
  // requests and approvals the moment they arrive (they only turn "high" after waiting).
  const before = new Set(prev.attention.map((i) => i.key));
  for (const i of next.attention) {
    if (before.has(i.key) || i.kind === 'team') continue;
    if (i.severity !== 'high' && i.kind !== 'review' && i.kind !== 'approval') continue;
    out.push({
      key: `attention:${i.key}`,
      category: CATEGORY_BY_KIND[i.kind] || 'other',
      title: i.title,
      body: i.reasons[0]?.text || '',
      target: i.target,
      webUrl: i.webUrl,
      severity: i.severity,
    });
  }

  // Someone voted on one of your pull requests.
  const prevPrs = new Map(prev.myPrs.map((p) => [p.key, p]));
  for (const pr of next.myPrs) {
    const old = prevPrs.get(pr.key);
    if (!old) continue;
    const oldVotes = new Map(old.reviewers.map((r) => [r.id, r.vote]));
    for (const r of pr.reviewers) {
      if (r.isContainer || !r.vote || oldVotes.get(r.id) === r.vote) continue;
      out.push({
        key: `vote:${pr.key}:${r.id}:${r.vote}`,
        category: 'myPr',
        title: (VOTE_TITLE[r.vote] || ((n) => `${n} voted on your pull request`))(r.displayName),
        body: pr.title,
        target: { type: 'pr', projectId: pr.projectId, repoId: pr.repoId, id: pr.id },
        severity: r.vote < 0 ? 'high' : 'medium',
      });
    }
  }
  // Your pull request left the active list (completed or abandoned).
  const nowActive = new Set(next.myPrs.map((p) => p.key));
  for (const old of prev.myPrs) {
    if (nowActive.has(old.key)) continue;
    out.push({
      key: `closed:${old.key}`,
      category: 'myPr',
      title: 'Your pull request is no longer active',
      body: `${old.title} was completed or abandoned`,
      target: { type: 'pr', projectId: old.projectId, repoId: old.repoId, id: old.id },
      severity: 'medium',
    });
  }

  // A run you started has finished.
  const wasRunning = new Set(prev.runs.filter((b) => b.status !== 'completed').map((b) => b.id));
  for (const b of next.runs) {
    if (!b.mine || b.status !== 'completed' || !wasRunning.has(b.id)) continue;
    const ok = b.result === 'succeeded';
    out.push({
      key: `run:${b.id}`,
      category: 'run',
      title: (RUN_TITLE[b.result] || ((p) => `Your run of ${p} finished`))(b.definition.name),
      body: `${b.buildNumber} on ${b.sourceBranch}`,
      target: { type: 'pipeline' },
      webUrl: b.webUrl,
      severity: ok ? 'medium' : 'high',
    });
  }
  return out;
}

/** Cheap fingerprint: did anything the UI shows change? */
export function fingerprint(snapshot) {
  return JSON.stringify([
    snapshot.attention.map((i) => [i.key, i.severity, i.reasons.map((r) => r.text)]),
    snapshot.myPrs.map((p) => [p.key, p.reviewers.map((r) => r.vote)]),
    snapshot.runs.map((b) => [b.id, b.status, b.result]),
    snapshot.extra ?? null,
  ]);
}
