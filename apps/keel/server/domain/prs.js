// Pure helpers that turn normalized pull requests into lead-relevant signals.

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/**
 * A person's email, lowercased, or '': GitHub people carry one when GitHub shares it, and an
 * Azure DevOps sign-in name usually is one (not on Azure DevOps Server, where it's DOMAIN\user).
 */
export const emailOf = (p) => String(p?.email || (/@/.test(p?.uniqueName || '') ? p.uniqueName : '')).toLowerCase();

// The email lets a GitHub login and an Azure DevOps account be the same person.
export const sameIdentity = (a, b) => !!a && !!b && (
  (a.id && b.id && a.id === b.id)
  || (a.uniqueName && b.uniqueName && a.uniqueName.toLowerCase() === b.uniqueName.toLowerCase())
  || (!!emailOf(a) && emailOf(a) === emailOf(b))
);

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
}

/** Adds the computed fields the UI and rules rely on. */
export function enrichPR(pr, me, now = Date.now()) {
  const people = pr.reviewers.filter((r) => !r.isContainer);
  const approvedBy = pr.reviewers.filter((r) => r.vote >= 5);
  const rejectedBy = pr.reviewers.filter((r) => r.vote === -10);
  const waitingBy = pr.reviewers.filter((r) => r.vote === -5);
  const mine = pr.reviewers.find((r) => sameIdentity(r, me));
  const requiredPending = pr.reviewers.filter((r) => r.isRequired && r.vote < 5);
  const isMine = sameIdentity(pr.author, me);
  const ageHours = (now - Date.parse(pr.createdAt)) / HOUR;

  let reviewState = 'in-review';
  if (pr.isDraft) reviewState = 'draft';
  else if (rejectedBy.length) reviewState = 'rejected';
  else if (waitingBy.length) reviewState = 'waiting-author';
  else if (!pr.reviewers.length) reviewState = 'no-reviewers';
  else if (approvedBy.length && !requiredPending.length) reviewState = 'approved';

  return {
    ...pr,
    ageHours,
    isMine,
    myVote: mine ? mine.vote : null,
    needsMyReview: pr.status === 'active' && !pr.isDraft && !isMine && !!mine && mine.vote === 0,
    approvals: approvedBy.length,
    humanReviewerCount: people.length,
    hasConflicts: pr.mergeStatus === 'conflicts',
    reviewState,
    readyToMerge: reviewState === 'approved' && pr.mergeStatus !== 'conflicts',
  };
}

export function voteLabel(vote) {
  return { 10: 'Approved', 5: 'Approved with suggestions', 0: 'No vote', '-5': 'Waiting for author', '-10': 'Rejected' }[vote] ?? 'No vote';
}
