import { DAY, HOUR, median, percentile, sameIdentity } from './prs.js';

function weekStart(ms) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const countBy = (list, keyFn, init = () => ({})) => {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, { key: k, ...init(x), count: 0 });
    m.get(k).count++;
  }
  return [...m.values()];
};

/** Delivery and review-flow metrics over the last `days` days. */
export function buildInsights({ closedPrs, activePrs, pipelines, days, now = Date.now() }) {
  const since = now - days * DAY;
  const inWindow = closedPrs.filter((p) => p.closedAt && Date.parse(p.closedAt) >= since);
  const merged = inWindow.filter((p) => p.status === 'completed');
  const abandoned = inWindow.filter((p) => p.status === 'abandoned');
  const cycle = (p) => (Date.parse(p.closedAt) - Date.parse(p.createdAt)) / HOUR;
  const cycles = merged.map(cycle);

  const byRepo = countBy(merged, (p) => `${p.projectName}/${p.repoName}`, (p) => ({ projectName: p.projectName, repoName: p.repoName }))
    .map((r) => {
      const prs = merged.filter((p) => `${p.projectName}/${p.repoName}` === r.key);
      return { ...r, medianCycleHours: median(prs.map(cycle)), p85CycleHours: percentile(prs.map(cycle), 85) };
    })
    .sort((a, b) => b.count - a.count);

  const byAuthor = countBy(merged, (p) => p.author?.id || p.author?.displayName, (p) => ({ person: p.author }))
    .map((r) => ({ ...r, medianCycleHours: median(merged.filter((p) => sameIdentity(p.author, r.person)).map(cycle)) }))
    .sort((a, b) => b.count - a.count);

  const approvals = [];
  for (const p of merged) {
    for (const r of p.reviewers) if (!r.isContainer && r.vote >= 5 && !sameIdentity(r, p.author)) approvals.push(r);
  }
  const byReviewer = countBy(approvals, (r) => r.id || r.displayName, (r) => ({ person: { id: r.id, displayName: r.displayName, uniqueName: r.uniqueName } }))
    .sort((a, b) => b.count - a.count);

  const weeks = [];
  for (let w = weekStart(since); Date.parse(w) <= now; w = new Date(Date.parse(w) + 7 * DAY).toISOString().slice(0, 10)) {
    weeks.push({ week: w, merged: 0, medianCycleHours: null });
  }
  for (const wk of weeks) {
    const prs = merged.filter((p) => weekStart(Date.parse(p.closedAt)) === wk.week);
    wk.merged = prs.length;
    wk.medianCycleHours = median(prs.map(cycle));
  }

  const buckets = [
    { label: '< 1 day', max: 24 },
    { label: '1–3 days', max: 72 },
    { label: '3–7 days', max: 168 },
    { label: '1–2 weeks', max: 336 },
    { label: '> 2 weeks', max: Infinity },
  ].map((b) => ({ ...b, count: 0 }));
  for (const p of activePrs) {
    const h = (now - Date.parse(p.createdAt)) / HOUR;
    buckets.find((b) => h < b.max).count++;
  }

  const judged = pipelines.filter((p) => p.passRate !== null);
  const totalRuns = judged.reduce((s, p) => s + p.runCount, 0);

  return {
    days,
    totals: {
      merged: merged.length,
      abandoned: abandoned.length,
      medianCycleHours: median(cycles),
      p85CycleHours: percentile(cycles, 85),
      activePrs: activePrs.length,
      medianOpenAgeHours: median(activePrs.map((p) => (now - Date.parse(p.createdAt)) / HOUR)),
      buildPassRate: totalRuns ? judged.reduce((s, p) => s + p.passRate * p.runCount, 0) / totalRuns : null,
      reviewersActive: byReviewer.length,
    },
    byRepo,
    byAuthor,
    byReviewer,
    weekly: weeks,
    openAge: buckets.map(({ label, count }) => ({ label, count })),
  };
}
