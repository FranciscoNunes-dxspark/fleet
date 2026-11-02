// DORA metrics per project and team: deployment frequency, lead time for changes, change failure
// rate and time to restore, over a period and the one before it, each with its DORA band and a
// "how" line saying what was counted, so a number can be checked rather than taken on trust.
//
// Production is configurable: environments (release stages, or what production monitors link to)
// named like one of the configured names, or by default like prod, production, prd or live.
//
// A change is a merged pull request, or a commit pushed without one, that a successful production
// deploy shipped. Its lead time runs from its first commit (or, when its commits aren't to hand,
// from when its pull request was opened) to that deploy.
//
// A successful deploy counts as a failed change when, within the failure window after it and
// before the next deploy that ships something new, production saw a failed deploy, a rollback (a
// redeploy of an older build) or a hotfix pull request merged into the branch it deploys from.
// Time to restore runs from that failure to the next successful production deploy.
import { DAY, HOUR, median, sameIdentity } from './prs.js';
import { FAILED, bands } from './delivery.js';

/** Stage names that are production when none are configured (as service.js PROD_STAGE). */
export const DEFAULT_PRODUCTION = /\b(prod|production|prd|live)\b/i;
export const DEFAULT_WINDOW_HOURS = 24;

// A pull request is a hotfix by its branch or title; it counts when it goes into a release branch
// or the branch production deploys from.
const HOTFIX = /\bhot-?fix/i;
const RELEASE_BRANCH = /^(release|releases|rel|hotfix|hotfixes)\//i;

// The "how" lines, as templates the web app translates (t(text, params)) and the terminal fills.
export const HOW = {
  frequencyNone: 'No successful production deploys in {days} days.',
  frequency: '{n} successful production deploys in {days} days ({perWeek} a week), to {envs}.',
  frequencyMore: '{n} successful production deploys in {days} days ({perWeek} a week), to {envs} and {more} more.',
  leadNone: 'No changes known to have reached production in {days} days: a deploy has to say which commit it shipped.',
  lead: 'Median of {n} changes, from the first commit to the production deploy that shipped it.',
  leadPr: 'Median of {n} changes, from the first commit to the production deploy that shipped it ({pr} timed from the pull request opening, their commits not being to hand).',
  failureNone: 'No successful production deploys to judge in {days} days.',
  failure: '{failed} of {n} production deploys were followed within {window}h by a failed deploy ({f}), a rollback or redeploy of an older build ({r}) or a hotfix pull request ({h}).',
  restoreNone: 'No failures in production in {days} days.',
  restore: 'Median of {n} restores, from a failed deploy, rollback or hotfix pull request to the next successful production deploy.',
  restoreOpen: 'Median of {n} restores, from a failed deploy, rollback or hotfix pull request to the next successful production deploy; {open} not restored yet.',
  restoreOnlyOpen: '{open} failures in production, none restored yet.',
};

/** A "how" line in English, its {placeholders} filled. */
export const howText = (how) => (how ? how.text.replace(/\{(\w+)\}/g, (m, k) => String(how.params?.[k] ?? m)) : '');

const namesOf = (names) => (Array.isArray(names) ? names : String(names ?? '').split(','))
  .map((s) => String(s).trim()).filter(Boolean);

/**
 * Whether an environment is production. `names` (a list, or comma-separated) are the configured
 * names: an environment is production when its stage or its name is one of them (case aside), or
 * one of the parts of a name like "Shop · Production". Without names, a stage named like
 * production is, and so is anything a production monitor is linked to (`monitored`).
 */
export function isProduction(env, names) {
  const list = namesOf(names).map((n) => n.toLowerCase());
  if (!list.length) return !!env.monitored || DEFAULT_PRODUCTION.test(env.stage || '') || (!env.stage && DEFAULT_PRODUCTION.test(env.name || ''));
  const parts = (s) => String(s || '').toLowerCase().split(/\s*[·|,]\s*/).map((x) => x.trim()).filter(Boolean);
  const candidates = [String(env.stage || '').toLowerCase(), String(env.name || '').toLowerCase(), ...parts(env.name)];
  return list.some((n) => candidates.includes(n));
}

const at = (x) => Date.parse(x);
const isOk = (d) => d.status === 'succeeded';

/** A hotfix pull request into the branch this environment deploys from (or a release branch). */
export function isHotfix(pr, env) {
  if (pr.status && pr.status !== 'completed') return false;
  if (!HOTFIX.test(pr.sourceBranch || '') && !HOTFIX.test(pr.title || '')) return false;
  if (pr.projectId && env.projectId && pr.projectId !== env.projectId) return false;
  if (pr.repoId && env.repoId && pr.repoId !== env.repoId) return false;
  const target = String(pr.targetBranch || '').replace(/^refs\/heads\//, '');
  const deployed = String(env.branch || '').replace(/^refs\/heads\//, '');
  return RELEASE_BRANCH.test(target) || (!!deployed && target.toLowerCase() === deployed.toLowerCase());
}

/**
 * One environment's history, oldest first, with what DORA needs on each deploy: whether it is a
 * rollback, the failure signals after it, and the incidents (failure → restore) in it.
 */
export function readHistory(env, pullRequests = [], windowHours = DEFAULT_WINDOW_HOURS) {
  const deploys = [...(env.deploys || [])].filter((d) => Number.isFinite(at(d.at))).sort((a, b) => at(a.at) - at(b.at));
  const repoId = [...deploys].reverse().find((d) => d.repoId)?.repoId || null;
  const branch = env.branch || [...deploys].reverse().find((d) => d.branch)?.branch || null;
  const where = { projectId: env.projectId, repoId, branch };
  const out = deploys.map((d) => ({ ...d, rollback: false, signals: [] }));

  // A rollback: a successful deploy of something older than what the previous one shipped. Release
  // ids grow with time, so a lower one than the last deploy's is an older release; a commit production
  // already ran before the last deploy says the same for pipelines (a stage of an old run re-run).
  const byId = env.type !== 'pipeline';
  let prev = null;
  const seen = new Set();
  for (const d of out) {
    if (!isOk(d)) continue;
    if (prev) {
      const olderId = byId && Number.isFinite(Number(d.id)) && Number.isFinite(Number(prev.id)) && Number(d.id) < Number(prev.id);
      const olderCommit = !!d.commit && !!prev.commit && d.commit !== prev.commit && seen.has(d.commit);
      d.rollback = olderId || olderCommit;
      d.rolledBack = d.rollback ? prev : null;
    }
    if (prev?.commit) seen.add(prev.commit);
    prev = d;
  }

  const hotfixes = pullRequests.filter((p) => p.closedAt && isHotfix(p, where)).sort((a, b) => at(a.closedAt) - at(b.closedAt));
  const signals = [
    ...out.filter((d) => FAILED.has(d.status)).map((d) => ({ kind: 'failed', at: at(d.at), deploy: d })),
    ...out.filter((d) => d.rollback).map((d) => ({ kind: 'rollback', at: at(d.at), deploy: d })),
    ...hotfixes.map((p) => ({ kind: 'hotfix', at: at(p.closedAt), pr: p })),
  ].sort((a, b) => a.at - b.at);

  // Each deploy that shipped something new owns the signals after it, up to the window or the next such deploy.
  const shipped = out.filter((d) => isOk(d) && !d.rollback);
  shipped.forEach((d, i) => {
    const until = Math.min(at(d.at) + windowHours * HOUR, i + 1 < shipped.length ? at(shipped[i + 1].at) : Infinity);
    d.signals = signals.filter((s) => s.at > at(d.at) && s.at <= until && s.deploy !== d).map((s) => s.kind);
  });

  // Incidents: a run of failed deploys from its first, a rollback from the deploy it undid, and a
  // hotfix from its pull request's opening; each restored by the next successful deploy.
  const nextOk = (ms) => out.find((d) => isOk(d) && at(d.at) > ms && !d.rollback) || null;
  const lastShipped = (ms) => [...shipped].reverse().find((d) => at(d.at) <= ms) || null;
  const incidents = [];
  out.forEach((d, i) => {
    if (FAILED.has(d.status) && !(i > 0 && FAILED.has(out[i - 1].status))) {
      const end = out.slice(i + 1).find(isOk);
      incidents.push({ kind: 'failed', start: at(d.at), end: end ? at(end.at) : null, after: lastShipped(at(d.at)) });
    }
    if (d.rollback) incidents.push({ kind: 'rollback', start: at(d.rolledBack.at), end: at(d.at), after: d.rolledBack });
  });
  for (const p of hotfixes) {
    const start = at(p.createdAt) || at(p.closedAt);
    const end = nextOk(at(p.closedAt));
    incidents.push({ kind: 'hotfix', start, end: end ? at(end.at) : null, after: lastShipped(start) });
  }
  return { env, deploys: out, incidents };
}

/** A change's lead time in hours, and whether it was timed from its pull request rather than a commit. */
function leadOf(change, deployAt) {
  const from = at(change.firstCommitAt) || at(change.prCreatedAt);
  if (!Number.isFinite(from)) return null;
  const h = (deployAt - from) / HOUR;
  return h >= 0 ? { hours: h, fromPr: !at(change.firstCommitAt) } : null;
}

const perWeekText = (n) => (n >= 10 ? String(Math.round(n)) : n.toFixed(1));

/**
 * The four measures over [from, to) for one scope: `histories` (readHistory's) of its
 * environments, and `owns(change)` saying which changes are the scope's (a team's are its
 * members'; a project's, all of them). A deploy is the scope's when it shipped one of its changes.
 */
function measure(histories, { from, to, days, windowHours, owns = null }) {
  const inPeriod = (ms) => ms >= from && ms < to;
  const mine = (d) => !owns || (d.changes || []).some(owns);
  const deploys = [];
  const judged = [];
  const leads = [];
  const restores = [];
  let open = 0;
  const kinds = { failed: 0, rollback: 0, hotfix: 0 };
  const envNames = new Set();
  for (const h of histories) {
    for (const d of h.deploys) {
      if (!isOk(d) || !inPeriod(at(d.at)) || !mine(d)) continue;
      deploys.push(d);
      envNames.add(h.env.name);
      if (d.rollback) continue;
      judged.push(d);
      for (const c of d.changes || []) {
        if (owns && !owns(c)) continue;
        const lead = leadOf(c, at(d.at));
        if (lead) leads.push(lead);
      }
    }
    for (const inc of h.incidents) {
      if (!inPeriod(inc.start)) continue;
      if (owns && !(inc.after && mine(inc.after))) continue;
      if (inc.end == null) open++;
      else restores.push((inc.end - inc.start) / HOUR);
    }
  }
  const failedChanges = judged.filter((d) => d.signals.length);
  for (const d of failedChanges) for (const k of new Set(d.signals)) kinds[k]++;

  const perWeek = (deploys.length / days) * 7;
  const envs = [...envNames].sort();
  const leadHours = median(leads.map((l) => l.hours));
  const rate = judged.length ? failedChanges.length / judged.length : null;
  const restoreHours = median(restores);
  const fromPr = leads.filter((l) => l.fromPr).length;
  return {
    frequency: {
      deploys: deploys.length,
      perWeek,
      band: bands.frequency(deploys.length / days),
      how: !deploys.length ? { text: HOW.frequencyNone, params: { days } }
        : envs.length > 3 ? { text: HOW.frequencyMore, params: { n: deploys.length, days, perWeek: perWeekText(perWeek), envs: envs.slice(0, 3).join(', '), more: envs.length - 3 } }
          : { text: HOW.frequency, params: { n: deploys.length, days, perWeek: perWeekText(perWeek), envs: envs.join(', ') } },
    },
    leadTime: {
      hours: leadHours,
      changes: leads.length,
      fromPr,
      band: bands.leadTime(leadHours),
      how: !leads.length ? { text: HOW.leadNone, params: { days } }
        : { text: fromPr ? HOW.leadPr : HOW.lead, params: { n: leads.length, pr: fromPr } },
    },
    failureRate: {
      rate,
      failed: failedChanges.length,
      deploys: judged.length,
      kinds,
      band: bands.failureRate(rate),
      how: !judged.length ? { text: HOW.failureNone, params: { days } }
        : { text: HOW.failure, params: { failed: failedChanges.length, n: judged.length, window: windowHours, f: kinds.failed, r: kinds.rollback, h: kinds.hotfix } },
    },
    restore: {
      hours: restoreHours,
      incidents: restores.length,
      open,
      band: bands.recovery(restoreHours),
      how: !restores.length && !open ? { text: HOW.restoreNone, params: { days } }
        : !restores.length ? { text: HOW.restoreOnlyOpen, params: { open } }
          : { text: open ? HOW.restoreOpen : HOW.restore, params: { n: restores.length, open } },
    },
  };
}

// Which way a measure moved against the period before: more deploys is better, more of the rest worse.
// Within a tenth either way (or one deploy) is the same.
function direction(now, before, higherIsBetter) {
  if (now == null || before == null) return null;
  const close = higherIsBetter ? Math.abs(now - before) <= Math.max(1, Math.abs(before) * 0.1) : Math.abs(now - before) <= Math.abs(before) * 0.1;
  if (close) return 'same';
  return (now > before) === higherIsBetter ? 'better' : 'worse';
}
function trendOf(current, previous) {
  return {
    frequency: { previous: previous.frequency.deploys, direction: direction(current.frequency.deploys, previous.frequency.deploys, true) },
    leadTime: { previous: previous.leadTime.hours, direction: direction(current.leadTime.hours, previous.leadTime.hours, false) },
    failureRate: { previous: previous.failureRate.rate, direction: direction(current.failureRate.rate, previous.failureRate.rate, false) },
    restore: { previous: previous.restore.hours, direction: direction(current.restore.hours, previous.restore.hours, false) },
  };
}

/** Whether a change is one of these people's: by its author's identity, else by commit email or name. */
const authoredBy = (members) => (c) => !!c.author && members.some((m) => sameIdentity(m, c.author)
  || (c.author.email && [m.uniqueName, m.email].some((x) => x && String(x).toLowerCase() === String(c.author.email).toLowerCase()))
  || (!c.author.id && !c.author.email && c.author.displayName && c.author.displayName === m.displayName));

/**
 * environments: [{ key, name, stage?, monitored?, projectId, projectName, org?, branch?,
 *   deploys: [{ id, label, at, status, commit?, repoId?, branch?,
 *     changes?: [{ kind: 'pr' | 'commit', id, firstCommitAt?, prCreatedAt?, author: { id?, uniqueName?, email?, displayName } }] }] }]
 * (deploys over at least the two periods); pullRequests: completed pull requests over the same
 * time (for hotfixes); teams: [{ key, name, projectId, projectName, members: [person] }].
 * production: the configured production names (none: the default); days: 30 or 90.
 */
export function buildDora({ environments = [], pullRequests = [], teams = [], days = 30, now = Date.now(), windowHours = DEFAULT_WINDOW_HOURS, production = [] }) {
  const names = namesOf(production);
  const prod = environments.filter((e) => isProduction(e, names));
  const histories = prod.map((e) => readHistory(e, pullRequests, windowHours));
  const current = { from: now - days * DAY, to: now + 1, days, windowHours };
  const previous = { from: now - 2 * days * DAY, to: now - days * DAY, days, windowHours };
  const scope = (kind, key, name, list, extra = {}, owns = null) => {
    const cur = measure(list, { ...current, owns });
    const prev = measure(list, { ...previous, owns });
    return { kind, key, name, ...extra, environments: list.map((h) => h.env.name), current: cur, previous: prev, trend: trendOf(cur, prev) };
  };

  const scopes = [scope('all', 'all', 'Everything', histories)];
  const projects = new Map();
  for (const h of histories) {
    const k = `${h.env.org || ''}:${h.env.projectId}`;
    if (!projects.has(k)) projects.set(k, { name: h.env.projectName || h.env.projectId, org: h.env.org, list: [] });
    projects.get(k).list.push(h);
  }
  // With one project, its row is the same as everything's.
  if (projects.size > 1) {
    for (const [k, p] of [...projects.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      scopes.push(scope('project', k, p.name, p.list, p.org ? { org: p.org } : {}));
    }
  }
  for (const t of [...teams].sort((a, b) => a.name.localeCompare(b.name))) {
    const list = histories.filter((h) => h.env.projectId === t.projectId && (!t.org || !h.env.org || t.org === h.env.org));
    scopes.push(scope('team', t.key, t.name, list, { projectName: t.projectName, ...(t.org ? { org: t.org } : {}) }, authoredBy(t.members || [])));
  }
  return {
    days,
    windowHours,
    production: { names, environments: prod.map((e) => ({ key: e.key, name: e.name, projectName: e.projectName, ...(e.org ? { org: e.org } : {}) })) },
    scopes,
  };
}
