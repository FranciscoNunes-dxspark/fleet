// Standup mode: the team one person at a time, with what moved for each since the previous
// working day, what they hold on the Line now, what of it is stuck and the reviews waiting on
// them, then the team's blockers. Pure; the web app walks through it (line/Standup.jsx) and the
// channels' morning post writes it out (server/channels.js, domain/messages.js standupMessage).
import { keyOf, peopleLine } from './people.js';

const DAY = 86_400_000;
const rank = { bad: 0, warn: 1 };
const LISTS = ['finished', 'changed', 'opened', 'merged', 'reviewed'];
const empty = () => Object.fromEntries(LISTS.map((k) => [k, []]));

/** Local midnight at the start of the previous working day: Friday on a Monday and at weekends. */
export function previousWorkingDay(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  do d.setDate(d.getDate() - 1); while (d.getDay() === 0 || d.getDay() === 6);
  return d;
}

/**
 * The same for a post sent at `ms` on a `weekday` (1 = Monday … 7 = Sunday, as channels.js
 * localTime gives it in the channel's time zone): back to that time on the previous working day.
 */
export function standupSinceMs(ms, weekday) {
  const back = weekday === 1 ? 3 : weekday === 7 ? 2 : 1;
  return ms - back * DAY;
}

/**
 * What moved for each person since `since` (ms): personKey -> { person, finished, changed, opened,
 * merged, reviewed }, newest first. `raw` is the server's standup answer (service.standupData):
 * work items finished, open ones whose state changed, pull requests opened and completed, each
 * { person, at, … }. A completed pull request's `reviewers` ({ person, vote }) who voted count as
 * reviews done (Azure DevOps doesn't say when a vote was cast, so only completed ones count).
 */
export function movedSince(raw = {}, since = 0) {
  const out = new Map();
  const add = (person, list, entry) => {
    const key = person ? keyOf(person) : '';
    if (!key) return;
    if (!out.has(key)) out.set(key, { person, ...empty() });
    if (!out.get(key)[list].some((x) => x.key === entry.key)) out.get(key)[list].push(entry);
  };
  const recent = (x) => Number.isFinite(Date.parse(x.at)) && Date.parse(x.at) >= since;
  for (const w of (raw.finished || []).filter(recent)) add(w.person, 'finished', w);
  for (const w of (raw.changed || []).filter(recent)) add(w.person, 'changed', w);
  for (const p of (raw.opened || []).filter(recent)) add(p.person, 'opened', p);
  for (const p of (raw.merged || []).filter(recent)) {
    add(p.person, 'merged', p);
    for (const r of p.reviewers || []) if (r.vote && r.person && keyOf(r.person) !== keyOf(p.person)) add(r.person, 'reviewed', p);
  }
  for (const m of out.values()) for (const list of LISTS) m[list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return out;
}

const byName = (a, b) => String(a.person?.displayName || '').localeCompare(String(b.person?.displayName || ''));

/**
 * One slide per person, by name: { key, person, moved, holding: { planned, building, review },
 * stuck (their stuck cards, worst and oldest first), reviews (pull requests waiting on their
 * vote), quiet (nothing moved, held or owed) }. `members`: the people to walk through (a team),
 * each given a slide even with nothing to say; without it, everyone with something on the Line
 * or something that moved. Work nobody holds isn't a person: it shows in the blockers.
 */
export function standupSlides({ stages = [], raw = {}, since = 0, members = null } = {}) {
  const rows = new Map(peopleLine(stages).filter((r) => r.person).map((r) => [r.key, r]));
  const moved = movedSince(raw, since);
  const people = new Map();
  if (members) {
    for (const p of members) if (keyOf(p)) people.set(keyOf(p), p);
  } else {
    for (const r of rows.values()) people.set(r.key, r.person);
    for (const [key, m] of moved) if (!people.has(key)) people.set(key, m.person);
  }
  return [...people.entries()].map(([key, person]) => {
    const row = rows.get(key);
    const holding = { planned: row?.stages.planned?.cards || [], building: row?.stages.building?.cards || [], review: row?.stages.review?.cards || [] };
    const stuck = Object.values(holding).flat().filter((c) => c.stuck).sort((a, b) => rank[a.stuck] - rank[b.stuck] || b.age - a.age);
    const m = moved.get(key) || empty();
    const did = LISTS.reduce((n, k) => n + m[k].length, 0);
    const held = Object.values(holding).reduce((n, l) => n + l.length, 0);
    const reviews = row?.reviews || [];
    return {
      key,
      person: row?.person || person,
      moved: Object.fromEntries(LISTS.map((k) => [k, m[k]])),
      holding,
      stuck,
      reviews,
      quiet: !did && !held && !reviews.length,
    };
  }).sort(byName);
}

/**
 * The closing slide: everything stuck on the Line, worst and oldest first, each with its
 * `stageId`. With `members`, work items and pull requests are only the team's (and those nobody
 * holds); pipelines, deploys, approvals and production are everyone's.
 */
export function teamBlockers(stages = [], members = null) {
  const team = members ? new Set(members.map(keyOf).filter(Boolean)) : null;
  const ours = (c) => !team || (c.kind !== 'workitem' && c.kind !== 'pr') || !c.person || team.has(keyOf(c.person));
  return stages
    .flatMap((s) => s.cards.filter((c) => c.stuck && ours(c)).map((c) => ({ ...c, stageId: s.id })))
    .sort((a, b) => rank[a.stuck] - rank[b.stuck] || b.age - a.age);
}

/** A slide as counts, for the post and the people strip: { finished, changed, opened, merged, reviewed, holding, stuck, reviews }. */
export function slideCounts(slide) {
  return {
    ...Object.fromEntries(LISTS.map((k) => [k, slide.moved[k].length])),
    holding: Object.values(slide.holding).reduce((n, l) => n + l.length, 0),
    stuck: slide.stuck.length,
    reviews: slide.reviews.length,
  };
}
