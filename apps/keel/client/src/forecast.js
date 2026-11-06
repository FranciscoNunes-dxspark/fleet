// When will an epic or feature land? A Monte Carlo forecast over the team's real pace: each
// simulated day takes the number of backlog items finished on a random day of the last few
// months, until the work left is used up. Thousands of runs give a spread of finish dates, read
// as odds: half the runs finished by the 50% date, 85 in 100 by the 85% date. Pure, so the server
// builds the pace (dailyThroughput) and the web app runs the forecast and its what-ifs; it lives in the
// client, as line/stages.js does, and the server imports it.
// "Done" is the Completed state category, never a state name.

const DAY = 864e5;
const isContainer = (w) => /^(epic|feature)$/i.test(w?.type || '');
const isTask = (w) => /task/i.test(w?.type || '');
const finishedAt = (w) => w.closedAt || w.stateChangedAt || w.changedAt;

/** The odds a forecast answers with, in percent. */
export const ODDS = [50, 85, 95];
/** How much history it takes to forecast: days covered, and items finished in them. */
export const MIN_HISTORY_DAYS = 14;
export const MIN_FINISHED = 5;
// A run still going after ten years means the pace is too slow to say anything useful.
const MAX_DAYS = 3650;

const startOfDay = (t) => {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * A project's pace: how many backlog items (stories, PBIs, bugs: not tasks, features or epics,
 * the units the Epics roll-up counts) were finished on each of the last `days` days, oldest
 * first, today included; and how many people finished them, for "add a person".
 */
export function dailyThroughput(finished = [], { days = 90, now = Date.now() } = {}) {
  const first = startOfDay(now) - (days - 1) * DAY;
  const daily = new Array(days).fill(0);
  const people = new Set();
  const seen = new Set();
  for (const w of finished) {
    if (w.stateCategory !== 'Completed' || isContainer(w) || isTask(w)) continue;
    const key = `${w.org || ''}:${w.id}`;
    if (seen.has(key)) continue;
    const t = Date.parse(finishedAt(w));
    if (!Number.isFinite(t) || t < first || t > now) continue;
    seen.add(key);
    daily[Math.floor((t - first) / DAY)]++;
    const who = w.assignedTo?.uniqueName || w.assignedTo?.displayName;
    if (who) people.add(who.toLowerCase());
  }
  return { days, since: new Date(first).toISOString().slice(0, 10), daily, finished: seen.size, people: people.size };
}

/** A small seedable random generator (mulberry32): the same seed gives the same forecast. */
export function seededRandom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How many days `remaining` items take at the pace in `daily`, at each of ODDS, from `runs`
 * simulations. `scale` multiplies the pace (a share of the team, or people added). Answers
 * { ok: true, odds: [{ p, days, date }], … } or { ok: false, reason } with reason one of
 * 'nothing-left', 'too-little-history' (under MIN_HISTORY_DAYS days or MIN_FINISHED items) or
 * 'too-slow' (some runs never finish within ten years).
 */
export function forecast({ remaining, daily = [], now = Date.now(), runs = 2000, seed = 1, scale = 1 }) {
  const finished = daily.reduce((a, b) => a + b, 0);
  const base = { remaining, historyDays: daily.length, finished };
  if (!(remaining > 0)) return { ok: false, reason: 'nothing-left', ...base };
  if (daily.length < MIN_HISTORY_DAYS || finished < MIN_FINISHED) return { ok: false, reason: 'too-little-history', ...base };
  if (!(scale > 0)) return { ok: false, reason: 'too-slow', ...base };
  const random = seededRandom(seed);
  const results = new Array(runs);
  for (let r = 0; r < runs; r++) {
    let left = remaining;
    let day = 0;
    while (left > 0 && day < MAX_DAYS) {
      day++;
      left -= daily[Math.floor(random() * daily.length)] * scale;
    }
    results[r] = left > 0 ? Infinity : day;
  }
  results.sort((a, b) => a - b);
  const odds = ODDS.map((p) => {
    const days = results[Math.min(runs - 1, Math.ceil((p / 100) * runs) - 1)];
    return { p, days, date: Number.isFinite(days) ? new Date(startOfDay(now) + days * DAY).toISOString().slice(0, 10) : null };
  });
  if (odds.some((o) => !Number.isFinite(o.days))) return { ok: false, reason: 'too-slow', ...base };
  return { ok: true, odds, ...base };
}

/**
 * The work left under an epic or feature (a node of domain/epics.js buildEpicTree), counted the
 * way its roll-up counts: backlog items, and tasks hung straight on an epic or feature. Unfinished
 * only, each once.
 */
export function remainingUnder(node) {
  const out = new Map();
  const walk = (n) => {
    for (const c of n.children || []) {
      if (isContainer(c.item)) walk(c);
      else if ((!isTask(c.item) || isContainer(n.item)) && c.item.stateCategory !== 'Completed') out.set(c.item.id, c.item);
    }
  };
  walk(node);
  return [...out.values()];
}

/**
 * How much faster or slower the team goes: `share` of its pace on this work (0 to 1), with
 * `added` people joining the `people` who finished the work in the history (each at the
 * team's average rate per person).
 */
export function paceScale({ share = 1, added = 0, people = 0 } = {}) {
  const perPerson = people > 0 ? (people + added) / people : 1 + added;
  return Math.max(0, share * perPerson);
}
