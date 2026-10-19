// How work items flow: cycle time (started to finished), throughput per week,
// work in progress by age, and what changed in each team's sprint since it
// started. Flow covers every work item type, or one type at a time; sprint
// scope leaves tasks out: they're steps of a backlog item, not deliveries.
import { DAY, HOUR, median, percentile } from './prs.js';
import { weekOf } from './delivery.js';
import { finishedAt } from './summary.js';

const isTask = (w) => /task/i.test(w.type || '');
const WIP = new Set(['InProgress', 'Resolved']);

/** When work started: its Activated Date (null in processes that don't set it). */
export const startedAt = (w) => w.activatedAt || null;

// Cycle time buckets for the distribution chart, in hours.
const BUCKETS = [
  { label: 'Under a day', max: 24 },
  { label: '1–3 days', max: 3 * 24 },
  { label: '3–7 days', max: 7 * 24 },
  { label: '1–2 weeks', max: 14 * 24 },
  { label: '2–4 weeks', max: 28 * 24 },
  { label: 'Over 4 weeks', max: Infinity },
];

const item = (w) => ({
  id: w.id,
  ...(w.org ? { org: w.org } : {}),
  type: w.type,
  typeColor: w.typeColor || null,
  title: w.title,
  state: w.state,
  stateCategory: w.stateCategory,
  projectName: w.projectName,
  assignedTo: w.assignedTo?.displayName || null,
  storyPoints: w.storyPoints ?? null,
  webUrl: w.webUrl,
});

/**
 * finished: work items completed recently (filtered to the last `days` days
 * here); open: open work items now; type: one work item type, or null for all.
 * Times are in hours.
 */
export function buildFlow({ finished = [], open = [], days, type = null, now = Date.now() }) {
  const since = now - days * DAY;
  const allDone = [...new Map(finished
    .filter((w) => w.stateCategory === 'Completed')
    .map((w) => [`${w.org || ''}:${w.id}`, w])).values()]
    .filter((w) => {
      const t = Date.parse(finishedAt(w));
      return t >= since && t <= now;
    })
    .map((w) => {
      const end = Date.parse(finishedAt(w));
      const start = Date.parse(startedAt(w));
      // Without an Activated Date, the time from creation stands in (lead time rather than cycle time).
      const from = Number.isFinite(start) && start <= end ? start : Date.parse(w.createdAt);
      return { w, end, hours: Number.isFinite(from) ? (end - from) / HOUR : null, estimated: !(Number.isFinite(start) && start <= end) };
    });
  const allWip = open.filter((w) => WIP.has(w.stateCategory));
  // Every type with something finished or in progress, for the type picker.
  const typeCounts = new Map();
  for (const [list, k] of [[allDone.map((d) => d.w), 'finished'], [allWip, 'wip']]) {
    for (const w of list) {
      const c = typeCounts.get(w.type) || { type: w.type, typeColor: w.typeColor || null, finished: 0, wip: 0 };
      c[k] += 1;
      typeCounts.set(w.type, c);
    }
  }
  const done = type ? allDone.filter((d) => d.w.type === type) : allDone;
  const cycles = done.map((d) => d.hours);
  const p50 = median(cycles);
  const p85 = percentile(cycles, 85);

  const weeks = [];
  for (let t = Date.parse(weekOf(since)); t <= now; t += 7 * DAY) weeks.push(weekOf(t));
  const weekly = weeks.map((week) => {
    const inWeek = done.filter((d) => weekOf(d.end) === week);
    return { week, finished: inWeek.length, medianCycleHours: median(inWeek.map((d) => d.hours)) };
  });

  const distribution = BUCKETS.map((b, i) => ({
    label: b.label,
    count: done.filter((d) => d.hours != null && d.hours < b.max && d.hours >= (i ? BUCKETS[i - 1].max : -Infinity)).length,
  }));

  const byType = [...new Set(done.map((d) => d.w.type))].map((name) => {
    const hrs = done.filter((d) => d.w.type === name).map((d) => d.hours);
    return { type: name, count: hrs.length, medianCycleHours: median(hrs), p85CycleHours: percentile(hrs, 85) };
  }).sort((a, b) => b.count - a.count);

  // Work in progress, oldest first; "age" is time since it started.
  const aging = allWip
    .filter((w) => !type || w.type === type)
    .map((w) => {
      const from = Date.parse(startedAt(w) || w.stateChangedAt || w.createdAt);
      const ageHours = Number.isFinite(from) ? Math.max(0, (now - from) / HOUR) : null;
      return { ...item(w), startedAt: Number.isFinite(from) ? new Date(from).toISOString() : null, ageHours, overP85: p85 != null && ageHours > p85, overMedian: p50 != null && ageHours > p50 };
    })
    .sort((a, b) => (b.ageHours ?? -1) - (a.ageHours ?? -1));

  // States in the order work moves through them: in progress before resolved, busiest first.
  const stateCount = new Map();
  for (const a of aging) {
    const k = `${a.stateCategory === 'Resolved' ? 1 : 0}|${a.state}`;
    stateCount.set(k, (stateCount.get(k) || 0) + 1);
  }
  const states = [...stateCount.entries()].sort(([a, x], [b, y]) => a.split('|')[0] - b.split('|')[0] || y - x).map(([k]) => k.split('|')[1]);

  return {
    days,
    type,
    types: [...typeCounts.values()].sort((a, b) => b.finished + b.wip - (a.finished + a.wip) || a.type.localeCompare(b.type)),
    totals: {
      finished: done.length,
      perWeek: done.length / (days / 7),
      medianCycleHours: p50,
      p85CycleHours: p85,
      wip: aging.length,
      wipOverP85: aging.filter((a) => a.overP85).length,
      oldestWipHours: aging[0]?.ageHours ?? null,
      // Finished items without an Activated Date (their cycle time counts from creation).
      estimated: done.filter((d) => d.estimated).length,
    },
    weekly,
    distribution,
    byType,
    aging,
    states,
  };
}

const sum = (list) => list.reduce((n, w) => n + (Number(w.storyPoints) || 0), 0);
const tally = (list) => ({ count: list.length, points: sum(list), unestimated: list.filter((w) => w.storyPoints == null).length });

/**
 * One team's sprint: what it held at the start (startIds, the end of its first
 * day), what it holds now (items), what was taken out since (removed), and what
 * came over unfinished from the sprint before (prevOpenIds: open in that sprint
 * when it ended).
 */
export function buildSprintScope({ project, team, iteration, startIds = [], prevOpenIds = [], items = [], removed = [], previous = null, now = Date.now() }) {
  const start = new Set(startIds);
  const carried = new Set(prevOpenIds);
  const backlog = items.filter((w) => !isTask(w));
  const out = removed.filter((w) => !isTask(w) && !backlog.some((x) => x.id === w.id));
  const committed = [...backlog.filter((w) => start.has(w.id)), ...out];
  const s = Date.parse(iteration.startDate);
  const f = Date.parse(iteration.finishDate);
  const totalDays = Number.isFinite(s) && Number.isFinite(f) ? Math.max(1, Math.round((f - s) / DAY) + 1) : null;
  return {
    project,
    team,
    iteration: {
      name: iteration.name,
      path: iteration.path,
      startDate: iteration.startDate,
      finishDate: iteration.finishDate,
      days: totalDays,
      day: totalDays ? Math.min(totalDays, Math.max(1, Math.floor((now - s) / DAY) + 1)) : null,
    },
    previous: previous ? { name: previous.name, path: previous.path } : null,
    committed: tally(committed),
    current: tally(backlog),
    completed: tally(backlog.filter((w) => w.stateCategory === 'Completed')),
    added: backlog.filter((w) => !start.has(w.id)).map(item),
    removed: out.map(item),
    carriedOver: committed.filter((w) => carried.has(w.id)).map(item),
  };
}
