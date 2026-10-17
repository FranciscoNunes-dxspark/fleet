// Delivery to production, as the four DORA measures: how often you deploy,
// how long a commit takes to reach production, how many deploys fail, and how
// long it takes to deploy successfully again after one does.
import { DAY, HOUR, median } from './prs.js';

// A deploy that failed or only partly succeeded counts as a failed change.
export const FAILED = new Set(['failed', 'partiallySucceeded']);

/** Monday (UTC) of the week `ms` falls in, as YYYY-MM-DD. */
export function weekOf(ms) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// Bands from the DORA research (State of DevOps 2023), simplified.
const band = (value, limits) => {
  if (value == null) return null;
  const names = ['elite', 'high', 'medium'];
  const i = limits.findIndex((limit) => value <= limit);
  return i < 0 ? 'low' : names[i];
};
export const bands = {
  // Deploys per day: several a day (elite), at least weekly (high), at least monthly (medium).
  frequency: (perDay) => (perDay == null ? null : perDay >= 1 ? 'elite' : perDay >= 1 / 7 ? 'high' : perDay >= 1 / 30 ? 'medium' : 'low'),
  leadTime: (h) => band(h, [24, 7 * 24, 30 * 24]),
  failureRate: (r) => band(r, [0.05, 0.1, 0.15]),
  recovery: (h) => band(h, [1, 24, 7 * 24]),
};

/**
 * For one environment's deploys (newest first): failed deploys and how long
 * each took to recover (the next successful deploy), in hours.
 */
function recoveries(deploys) {
  const oldestFirst = [...deploys].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out = [];
  for (let i = 0; i < oldestFirst.length; i++) {
    if (!FAILED.has(oldestFirst[i].status)) continue;
    // A run of failures recovers once, measured from the first of them.
    if (i > 0 && FAILED.has(oldestFirst[i - 1].status)) continue;
    const next = oldestFirst.slice(i + 1).find((d) => d.status === 'succeeded');
    out.push(next ? (Date.parse(next.at) - Date.parse(oldestFirst[i].at)) / HOUR : null);
  }
  return out;
}

/**
 * targets: [{ key, name, projectName, deploys: [{ at, status, leadTimes?: [hours] }] }],
 * deploys newest first. Only deploys in the last `days` days count.
 */
export function buildDelivery({ targets, days, now = Date.now() }) {
  const since = now - days * DAY;
  const inWindow = (d) => Date.parse(d.at) >= since && Date.parse(d.at) <= now;
  const rows = targets.map((t) => {
    const deploys = t.deploys.filter(inWindow);
    const ok = deploys.filter((d) => d.status === 'succeeded');
    const failed = deploys.filter((d) => FAILED.has(d.status));
    const lead = ok.flatMap((d) => d.leadTimes || []);
    const rec = recoveries(deploys);
    return {
      key: t.key,
      name: t.name,
      projectName: t.projectName,
      ...(t.org ? { org: t.org } : {}),
      deploys: ok.length,
      failed: failed.length,
      failureRate: deploys.length ? failed.length / deploys.length : null,
      medianLeadTimeHours: median(lead),
      medianRecoveryHours: median(rec.filter((x) => x != null)),
      unrecovered: rec.filter((x) => x == null).length,
      lastDeploy: deploys[0] ? { id: deploys[0].id, at: deploys[0].at, status: deploys[0].status, label: deploys[0].label } : null,
      _lead: lead,
      _rec: rec,
    };
  });

  const all = targets.flatMap((t) => t.deploys.filter(inWindow));
  const ok = all.filter((d) => d.status === 'succeeded').length;
  const failed = all.filter((d) => FAILED.has(d.status)).length;
  const lead = rows.flatMap((r) => r._lead);
  const rec = rows.flatMap((r) => r._rec).filter((x) => x != null);
  const perDay = targets.length ? ok / days : null;
  const totals = {
    deploys: ok,
    failed,
    deploysPerWeek: perDay == null ? null : perDay * 7,
    medianLeadTimeHours: median(lead),
    failureRate: all.length ? failed / all.length : null,
    medianRecoveryHours: median(rec),
  };

  const weeks = [];
  for (let w = weekOf(since); Date.parse(w) <= now; w = new Date(Date.parse(w) + 7 * DAY).toISOString().slice(0, 10)) {
    weeks.push({ week: w, deploys: 0, failed: 0 });
  }
  for (const d of all) {
    const wk = weeks.find((x) => x.week === weekOf(Date.parse(d.at)));
    if (!wk) continue;
    if (d.status === 'succeeded') wk.deploys++;
    else if (FAILED.has(d.status)) wk.failed++;
  }

  return {
    days,
    totals,
    bands: {
      frequency: bands.frequency(perDay),
      leadTime: bands.leadTime(totals.medianLeadTimeHours),
      failureRate: bands.failureRate(totals.failureRate),
      recovery: bands.recovery(totals.medianRecoveryHours),
    },
    weekly: weeks,
    targets: rows.map(({ _lead, _rec, ...r }) => r).sort((a, b) => b.deploys + b.failed - (a.deploys + a.failed) || a.name.localeCompare(b.name)),
  };
}
