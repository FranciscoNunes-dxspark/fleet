// The weekly summary: what got finished, merged and deployed in one week, and
// what's blocked now. Written for everyone, not only people who read PRs.
import { DAY } from './prs.js';
import { FAILED, weekOf } from './delivery.js';

const isBug = (w) => /bug|defect|issue|incident/i.test(w.type);

/** The week (Monday 00:00 UTC to the next Monday) a YYYY-MM-DD date falls in; this week when invalid. */
export function weekRange(week, now = Date.now()) {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(week || '')) && Number.isFinite(Date.parse(week)) ? weekOf(Date.parse(week)) : weekOf(now);
  const from = Date.parse(start);
  return { week: start, from, to: from + 7 * DAY };
}

/** When a work item was finished: its Closed Date, else when it entered its current (completed) state. */
export const finishedAt = (w) => w.closedAt || w.stateChangedAt || w.changedAt;

const item = (w) => ({
  id: w.id,
  ...(w.org ? { org: w.org } : {}),
  type: w.type,
  title: w.title,
  state: w.state,
  projectName: w.projectName,
  assignedTo: w.assignedTo?.displayName || null,
  webUrl: w.webUrl,
});

/**
 * finished: work items completed (any time recently; filtered to the week here),
 * merged: completed PRs, deploys: production deploys with their environment name,
 * blocked: open blocked items now, inProgress: how many items are in progress now.
 */
export function buildSummary({ week, from, to, finished = [], merged = [], deploys = [], blocked = [], inProgress = 0, now = Date.now() }) {
  const inWeek = (iso) => {
    const t = Date.parse(iso);
    return t >= from && t < to;
  };
  const done = finished
    .filter((w) => w.stateCategory === 'Completed' && !/task/i.test(w.type) && inWeek(finishedAt(w)))
    .sort((a, b) => a.projectName.localeCompare(b.projectName) || Date.parse(finishedAt(a)) - Date.parse(finishedAt(b)));
  const prs = merged.filter((p) => p.status === 'completed' && inWeek(p.closedAt));
  const shipped = deploys.filter((d) => inWeek(d.at)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const byRepo = new Map();
  for (const p of prs) {
    const key = `${p.projectName}/${p.repoName}`;
    byRepo.set(key, { projectName: p.projectName, repoName: p.repoName, count: (byRepo.get(key)?.count || 0) + 1 });
  }

  return {
    week,
    from: new Date(from).toISOString(),
    to: new Date(to - 1).toISOString(),
    current: now >= from && now < to,
    totals: {
      finished: done.length,
      features: done.filter((w) => !isBug(w)).length,
      bugs: done.filter(isBug).length,
      merged: prs.length,
      deploys: shipped.filter((d) => d.status === 'succeeded').length,
      failedDeploys: shipped.filter((d) => FAILED.has(d.status)).length,
      blocked: blocked.length,
      inProgress,
    },
    features: done.filter((w) => !isBug(w)).map(item),
    bugs: done.filter(isBug).map(item),
    mergedByRepo: [...byRepo.values()].sort((a, b) => b.count - a.count || a.repoName.localeCompare(b.repoName)),
    deploys: shipped.map(({ target, label, at, status, webUrl, org }) => ({ target, label, at, status, webUrl, ...(org ? { org } : {}) })),
    blocked: blocked.map(item),
  };
}
