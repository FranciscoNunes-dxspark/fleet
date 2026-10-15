import { HOUR, sameIdentity } from './prs.js';
import { isBlocked } from './attention.js';

/**
 * Per-person load across every tracked project: what they are building,
 * what they are waiting on, and what everyone else is waiting on them for.
 */
export function buildWorkload({ people, prs, items, thresholds, blockedTag, currentIterationPaths = [], now = Date.now() }) {
  const active = prs.filter((p) => p.status === 'active');
  const inSprint = (w) => currentIterationPaths.some((path) => w.iterationPath === path || w.iterationPath?.startsWith(`${path}\\`));

  return people.map((person) => {
    const mine = items.filter((w) => sameIdentity(w.assignedTo, person) && w.stateCategory !== 'Completed' && w.stateCategory !== 'Removed');
    const inProgress = mine.filter((w) => w.stateCategory === 'InProgress');
    const authored = active.filter((p) => sameIdentity(p.author, person));
    const reviewing = active.filter((p) => !p.isDraft && !sameIdentity(p.author, person)
      && p.reviewers.some((r) => sameIdentity(r, person) && r.vote === 0));
    const oldestPr = authored.reduce((max, p) => Math.max(max, (now - Date.parse(p.createdAt)) / HOUR), 0);
    const sprintItems = mine.filter(inSprint);

    const flags = [];
    if (inProgress.length > thresholds.maxInProgressPerPerson) flags.push(`${inProgress.length} items in progress`);
    if (reviewing.length > thresholds.maxPendingReviewsPerPerson) flags.push(`${reviewing.length} reviews pending`);
    if (!mine.length && !authored.length) flags.push('No assigned work');

    return {
      person,
      openItems: mine.length,
      inProgress: inProgress.length,
      proposed: mine.filter((w) => w.stateCategory === 'Proposed').length,
      resolved: mine.filter((w) => w.stateCategory === 'Resolved').length,
      sprintItems: sprintItems.length,
      sprintPoints: sprintItems.reduce((s, w) => s + (w.type !== 'Task' && w.storyPoints ? Number(w.storyPoints) : 0), 0),
      remainingWork: mine.reduce((s, w) => s + (w.remainingWork ? Number(w.remainingWork) : 0), 0),
      bugs: mine.filter((w) => w.type === 'Bug').length,
      blocked: mine.filter((w) => isBlocked(w, blockedTag)).length,
      prsAuthored: authored.length,
      draftPrs: authored.filter((p) => p.isDraft).length,
      reviewsPending: reviewing.length,
      oldestPrHours: Math.round(oldestPr),
      flags,
      overloaded: flags.some((f) => !f.startsWith('No ')),
      itemIds: mine.map((w) => w.id),
    };
  }).sort((a, b) => (b.inProgress + b.reviewsPending) - (a.inProgress + a.reviewsPending) || a.person.displayName.localeCompare(b.person.displayName));
}
