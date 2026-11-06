// The Line: every change in flight, placed at the stage it has reached, from planned
// to live. Pure: it takes what the API already sends (/workitems, /prs, /deploys/pending,
// /pipelines, /approvals, /production) and returns the stages with their cards, so the
// rules can be tested without a browser. Words are codes here; the page translates them.

const HOUR = 36e5;
const DAY = 24 * HOUR;

/** The stages in the order change moves through them. */
export const STAGES = ['planned', 'building', 'review', 'merged', 'deploying', 'live'];

/** How long things may sit before they count as stuck (Settings → When to flag things). */
export const DEFAULT_LIMITS = { stalePrDays: 5, itemStuckDays: 5, p1WaitDays: 2, shipWarnDays: 3, shipBadDays: 7 };

// What's on the line is each project's requirement level (stories, backlog items, and bugs
// where the process keeps them there), as its team's backlog settings say (`levels`). Without
// them (a project with no team), it falls back to leaving out the server's default task type and
// the usual portfolio levels, which aren't pieces of change themselves.
const OFF_LINE_TYPES = ['Task', 'Epic', 'Feature'];
const onLine = (w, levels) => {
  const types = levels?.[w.projectId];
  return types?.length ? types.includes(w.type) : !OFF_LINE_TYPES.includes(w.type);
};

const since = (iso, now) => (iso ? Math.max(0, now - Date.parse(iso)) : 0);
const rank = { bad: 0, warn: 1, null: 2 };
// Most stuck first, then what needs you, then the oldest.
const byUrgency = (a, b) => rank[a.stuck] - rank[b.stuck] || Number(b.mine) - Number(a.mine) || b.age - a.age;

function workCard(w, stage, now, limits) {
  const age = since(stage === 'planned' ? w.createdAt : (w.activatedAt || w.stateChangedAt || w.createdAt), now);
  const quiet = since(w.changedAt, now);
  let stuck = null;
  let reason = null;
  if (stage === 'planned' && w.priority === 1 && age > limits.p1WaitDays * DAY) { stuck = 'bad'; reason = { code: 'p1-waiting', days: Math.floor(age / DAY) }; }
  if (stage === 'building' && w.blocked) { stuck = 'bad'; reason = { code: 'blocked' }; }
  else if (stage === 'building' && quiet > limits.itemStuckDays * DAY) { stuck = 'warn'; reason = { code: 'quiet', days: Math.floor(quiet / DAY) }; }
  return {
    key: `wi:${w.org || ''}:${w.id}`, stage, kind: 'workitem', title: w.title,
    sub: `${w.type} ${w.id} · ${w.projectName}`, type: w.type, typeColor: w.typeColor,
    person: w.assignedTo || null, projectId: w.projectId, age, stuck, reason, mine: false, state: w.state,
    open: { type: 'workitem', id: w.id, org: w.org },
  };
}

function prCard(p, now, limits) {
  const age = since(p.createdAt, now);
  let stuck = null;
  let reason = { code: `pr-${p.reviewState}` };
  if (p.hasConflicts) { stuck = 'bad'; reason = { code: 'conflicts' }; }
  else if (p.reviewState === 'rejected') stuck = 'bad';
  else if (age > limits.stalePrDays * DAY) { stuck = 'warn'; reason = { code: 'stale', days: Math.floor(age / DAY) }; }
  return {
    key: `pr:${p.key}`, stage: 'review', kind: 'pr', title: p.title,
    sub: `${p.repoName} · !${p.id}`, person: p.author || null, projectId: p.projectId, age, stuck, reason,
    // Who it waits on: reviewers who haven't voted, for the per-person line (people.js).
    waitingOn: (p.reviewers || []).filter((r) => !r.isContainer && !r.vote).map(({ id, displayName, uniqueName }) => ({ id, displayName, uniqueName })),
    mine: !!p.needsMyReview, draft: !!p.isDraft, reviewState: p.reviewState, readyToMerge: !!p.readyToMerge, autoComplete: !!p.autoComplete,
    open: { type: 'pr', projectId: p.projectId, repoId: p.repoId, id: p.id },
  };
}

function shipCard(t, now, limits) {
  const age = since(t.oldestAt, now);
  return {
    key: `ship:${t.key}`, stage: 'merged', kind: 'ship', title: t.name, projectId: t.projectId,
    sub: t.lastDeploy ? t.lastDeploy.label : t.projectName, count: t.waiting, age,
    stuck: age > limits.shipBadDays * DAY ? 'bad' : age > limits.shipWarnDays * DAY ? 'warn' : null,
    reason: { code: 'waiting-changes', n: t.waiting, days: Math.floor(age / DAY) },
    mine: false, link: '/ship',
  };
}

/** A project's limits: its own where Settings sets them, the defaults for the rest. */
export function limitsFor(projectId, limits = {}) {
  const own = limits.projects?.[projectId] || {};
  const merged = { ...DEFAULT_LIMITS, ...(limits.default || {}) };
  for (const [k, v] of Object.entries(own)) if (Number(v) > 0) merged[k] = Number(v);
  return merged;
}

/**
 * The Line's stages from the API's answers (any may be missing while it loads).
 * Each stage: { id, cards, count, stuck: { warn, bad }, tone }.
 * `options.limits` = { default, projects: { [projectId]: own limits } }; `options.levels` =
 * { [projectId]: work item types on the line } (the server knows both; see server/line.js).
 */
export function buildLine({ workitems, prs, pending, pipelines, approvals, production } = {}, now = Date.now(), { limits = {}, levels = null } = {}) {
  const cards = Object.fromEntries(STAGES.map((s) => [s, []]));
  const lim = (projectId) => limitsFor(projectId, limits);

  for (const w of workitems?.items || []) {
    if (!onLine(w, levels)) continue;
    if (w.stateCategory === 'Proposed') cards.planned.push(workCard(w, 'planned', now, lim(w.projectId)));
    else if (w.stateCategory === 'InProgress' || w.stateCategory === 'Resolved') cards.building.push(workCard(w, 'building', now, lim(w.projectId)));
  }

  for (const p of prs?.prs || []) if (p.status === 'active') cards.review.push(prCard(p, now, lim(p.projectId)));

  for (const t of pending?.targets || []) if (t.waiting > 0) cards.merged.push(shipCard(t, now, lim(t.projectId)));

  // Deploying: decisions waiting on someone, deploys under way, and red pipelines, which hold the line up.
  for (const a of approvals || []) {
    cards.deploying.push({
      key: `appr:${a.key}`, stage: 'deploying', kind: 'approval', title: `${a.pipeline} → ${a.stage}`,
      sub: a.run?.name || a.projectName, age: since(a.createdOn, now), stuck: 'warn',
      reason: { code: a.canDecide ? 'approval-yours' : 'approval' }, mine: !!a.canDecide, link: '/pipelines', projectId: a.projectId,
      // What deciding it from the card needs (orgs.js approvalPath).
      approval: { kind: a.kind, id: a.id, org: a.org, canDecide: !!a.canDecide },
    });
  }
  for (const t of pending?.targets || []) {
    if (!t.deploy || t.deploy.state === 'approval') continue;
    cards.deploying.push({
      key: `dep:${t.key}`, stage: 'deploying', kind: 'deploy', title: t.name, sub: t.deploy.label,
      age: since(t.deploy.startedAt, now), stuck: null, reason: { code: 'deploying' }, mine: false, link: '/ship',
    });
  }
  for (const p of pipelines || []) {
    const running = p.running?.length > 0;
    if (p.health !== 'failing' && !running) continue;
    cards.deploying.push({
      key: `pipe:${p.key}`, stage: 'deploying', kind: 'pipeline', title: p.definition.name,
      sub: `${p.repoName || p.projectName} · ${p.branch || ''}`.replace(/ · $/, ''),
      age: since(p.health === 'failing' ? p.lastGreenAt : p.running[0]?.startedAt, now),
      stuck: p.health === 'failing' ? 'bad' : null,
      reason: p.health === 'failing' ? { code: 'red', n: p.failStreak } : { code: 'running' },
      runs: (p.recent || []).slice(0, 10).map((r) => r.result || r.status),
      mine: false, open: { type: 'pipeline', key: p.key }, projectId: p.projectId,
      // Running it again from the card, on the branch it's judged on.
      rerun: p.health === 'failing' && !running && p.definition.id != null ? { projectId: p.projectId, definitionId: p.definition.id, branch: p.branch } : null,
    });
  }

  for (const m of production?.monitors || []) {
    cards.live.push({
      key: `mon:${m.id}`, stage: 'live', kind: 'monitor', title: m.name, sub: m.url?.replace(/^https?:\/\//, ''),
      state: m.state, age: since(m.downSince, now), latency: m.last?.ms != null ? Math.round(m.last.ms) : null, uptime: m.uptime24h ?? null,
      stuck: m.state === 'down' ? 'bad' : m.state === 'degraded' ? 'warn' : null,
      reason: { code: `monitor-${m.state}` }, mine: false, link: '/production',
      // Down or degraded: "What broke?" opens its incident (IncidentDetail.jsx) from the card.
      incident: m.state === 'down' || m.state === 'degraded' ? m.id : null,
    });
  }

  return STAGES.map((id) => {
    const list = cards[id].sort(byUrgency);
    const warn = list.filter((c) => c.stuck === 'warn').length;
    const bad = list.filter((c) => c.stuck === 'bad').length;
    return { id, cards: list, count: list.length, stuck: { warn, bad }, tone: stageTone(id, list.length, bad, warn) };
  });
}

/**
 * How jammed a stage is. A few stuck cards in a busy stage are normal, so the tone follows
 * the share that's stuck (a badly stuck card counting twice): red from half, amber from a
 * quarter. Production is the exception: one app down is red and one degraded is amber, however
 * many others are fine.
 */
export function stageTone(id, count, bad, warn) {
  if (!count) return null;
  if (id === 'live') return bad ? 'bad' : warn ? 'warn' : null;
  const pressure = (bad * 2 + warn) / (count * 2);
  return pressure >= 0.5 ? 'bad' : pressure >= 0.25 ? 'warn' : null;
}

/**
 * How well change passes from one stage to the next: the track between two stations is
 * as troubled as the stage it leads into, since that's where work is piling up.
 */
export function trackTones(stages) {
  return stages.slice(1).map((s) => (!s.count ? 'idle' : s.tone || 'ok'));
}
