// What broke production? For a monitor that's down or degraded: when it turned bad, the deploys
// into its environment just before that, the release to go back to, and the incident's timeline.
// Pure: the service (service.js incident) reads the monitor, the environment's deploy history, what
// the latest suspect shipped and who approved it, and hands them here. The timeline's texts are
// templates (TIMELINE) the web app translates with t(text, params), like risk.js's reasons.

const HOUR = 3_600_000;

/** States that are an incident. Deploying and settling never are: failures are expected then. */
export const INCIDENT_STATES = new Set(['down', 'degraded']);

/** An hourly Application Insights bucket failing at this share of requests or more counts as bad. */
export const BAD_FAIL_RATE = 0.02;

/** How far before the incident a deploy is a suspect, and how many are listed. */
export const SUSPECT_LOOKBACK_MS = 24 * HOUR;
export const MAX_SUSPECTS = 3;
// A deploy that finished this soon after the first failure may still be its cause: the outage
// can begin while the new version starts.
const SUSPECT_GRACE_MS = 5 * 60_000;

export const TIMELINE = {
  merged: 'Pull request !{id} merged: {title}',
  deployStarted: '{label} started deploying to {env}',
  approved: '{name} approved {label}',
  rejected: '{name} rejected {label}',
  deployed: '{label} deployed to {env}',
  deployFailed: '{label} failed deploying to {env}',
  partly: '{label} partly deployed to {env}',
  down: '{monitor} went down',
  degraded: '{monitor} turned degraded',
  stillDown: '{monitor} is still down',
  stillDegraded: '{monitor} is still degraded',
};

/** A timeline text with its params filled in, in English (for tests and anything that isn't the web app). */
export const timelineText = (event) => event.text.replace(/\{(\w+)\}/g, (_, k) => String(event.params?.[k] ?? ''));

const ms = (iso) => Date.parse(iso);
const failRate = (b) => (b.total ? (b.failed || 0) / b.total : 0);

/**
 * When a monitor's incident began, as an ISO time, or null when it isn't down or degraded. The first
 * failed check after the last good one; the first of the trailing hourly buckets failing at
 * BAD_FAIL_RATE or more; whichever is earlier. With neither (a slow site, a platform's own
 * "degraded"), the last check: it's known to be bad since then at least.
 */
export function incidentStart(monitor, now = Date.now()) {
  if (!INCIDENT_STATES.has(monitor?.state)) return null;
  const starts = [];
  const checks = monitor.history || [];
  if (checks.length && !checks.at(-1).ok) {
    let i = checks.length - 1;
    while (i > 0 && !checks[i - 1].ok) i--;
    starts.push(checks[i].at);
  }
  const series = monitor.ai?.series || [];
  let j = series.length;
  while (j > 0 && series[j - 1].total && failRate(series[j - 1]) >= BAD_FAIL_RATE) j--;
  if (j < series.length) starts.push(series[j].at);
  if (!starts.length) starts.push(monitor.last?.at || monitor.ai?.at || new Date(now).toISOString());
  return starts.sort((a, b) => ms(a) - ms(b))[0];
}

/**
 * The deploys that may have caused it, newest first: those that finished in the day before it began
 * (or just after its first failure), at most MAX_SUSPECTS. With none that recent, the latest one before
 * it, so there's still something to compare with; `gapMs` says how long before the incident each was.
 */
export function suspectDeploys(history, start, { lookback = SUSPECT_LOOKBACK_MS, max = MAX_SUSPECTS } = {}) {
  if (!start) return [];
  const t = ms(start);
  const before = (history || [])
    .filter((d) => d.at && ms(d.at) <= t + SUSPECT_GRACE_MS)
    .sort((a, b) => ms(b.at) - ms(a.at));
  const recent = before.filter((d) => t - ms(d.at) <= lookback);
  return (recent.length ? recent.slice(0, max) : before.slice(0, 1)).map((d) => ({ ...d, gapMs: t - ms(d.at) }));
}

/**
 * The release to go back to: the newest successful deploy older than every suspect (older than the
 * incident when there are none). Null when the history has none.
 */
export function lastGoodDeploy(history, start, suspects = []) {
  const oldest = suspects.length ? Math.min(...suspects.map((d) => ms(d.at))) : ms(start);
  return (history || [])
    .filter((d) => d.status === 'succeeded' && d.at && ms(d.at) < oldest)
    .sort((a, b) => ms(b.at) - ms(a.at))[0] || null;
}

/**
 * How to go back to `lastGood`. A classic release stage can be redeployed from Keel when that release
 * is still listed (`releaseDefs`, the service's releases()): its release and environment ids. A pipeline
 * run can't be replayed safely from here (re-running a YAML run builds and deploys again, with today's
 * pipeline), so it's `manual`, with the run's link. Null with nothing to go back to.
 */
export function redeployPlan(target, lastGood, releaseDefs = []) {
  if (!target || !lastGood) return null;
  if (target.type !== 'release') return { kind: 'manual', reason: 'pipeline', label: lastGood.label, webUrl: lastGood.webUrl || null };
  const def = releaseDefs.find((d) => d.projectId === target.projectId && d.id === target.definitionId);
  const release = def?.releases?.find((r) => String(r.id) === String(lastGood.id));
  const stage = release?.stages?.find((s) => !target.stage || s.name === target.stage);
  if (!stage?.id) return { kind: 'manual', reason: 'notListed', label: lastGood.label, webUrl: lastGood.webUrl || null };
  return { kind: 'release', projectId: target.projectId, releaseId: release.id, environmentId: stage.id, label: lastGood.label, stage: stage.name, webUrl: lastGood.webUrl || null };
}

const event = (at, kind, params, extra = {}) => ({ at, kind, text: TIMELINE[kind], params, ...extra });

/**
 * The incident in order: the pull requests the latest suspect shipped, as they merged; each suspect's
 * deploy starting, being approved or rejected, and finishing; the monitor turning bad; and now.
 * `suspects` carry their `approvals` ({ by, at, status }); events with no time are left out.
 */
export function incidentTimeline({ monitor, start, suspects = [], pullRequests = [], env = '', now = Date.now() }) {
  const events = [];
  for (const p of pullRequests) if (p.mergedAt) events.push(event(p.mergedAt, 'merged', { id: p.id, title: p.title }, { pr: { projectId: p.projectId, repoId: p.repoId, id: p.id } }));
  for (const d of suspects) {
    if (d.startedAt) events.push(event(d.startedAt, 'deployStarted', { label: d.label, env }, { deployId: d.id }));
    for (const a of d.approvals || []) {
      if (a.at && (a.status === 'approved' || a.status === 'rejected')) events.push(event(a.at, a.status, { name: a.by || '?', label: d.label }, { deployId: d.id }));
    }
    const kind = d.status === 'succeeded' ? 'deployed' : d.status === 'partiallySucceeded' ? 'partly' : 'deployFailed';
    events.push(event(d.at, kind, { label: d.label, env }, { deployId: d.id }));
  }
  if (start) {
    const down = monitor.state === 'down';
    events.push(event(start, down ? 'down' : 'degraded', { monitor: monitor.name }, { bad: true }));
    events.push(event(new Date(now).toISOString(), down ? 'stillDown' : 'stillDegraded', { monitor: monitor.name }, { bad: true }));
  }
  return events.filter((e) => e.at && Number.isFinite(ms(e.at))).sort((a, b) => ms(a.at) - ms(b.at));
}
