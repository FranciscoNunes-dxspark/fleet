// Turns monitor readings plus deployment history into what a lead needs to
// know about production: is it up, is it healthy, did the last deploy hurt it.

const HOUR = 3_600_000;
const pct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
const ago = (ms) => (ms < HOUR ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 48 * HOUR ? `${Math.round(ms / HOUR)}h` : `${Math.round(ms / (24 * HOUR))}d`);

/**
 * Deployments into the environment a monitor watches, newest first:
 * a classic release stage, or a (YAML) pipeline's runs on its branch.
 */
export function deployMarkers(monitor, { releases = [], pipelines = [], builds = [] }, since = Date.now() - 7 * 24 * HOUR) {
  const link = monitor.link;
  if (!link) return [];
  if (link.type === 'release') {
    const def = releases.find((d) => d.projectId === link.projectId && d.id === link.definitionId);
    if (!def) return [];
    return def.releases
      .map((r) => ({ r, s: r.stages.find((x) => !link.stage || x.name === link.stage) }))
      .filter(({ s }) => s && s.at && !['notStarted', 'undefined', 'canceled'].includes(s.status))
      .map(({ r, s }) => ({ id: r.id, at: s.at, label: r.name, status: s.status, by: s.requestedFor?.displayName || null, webUrl: r.webUrl }))
      .filter((d) => Date.parse(d.at) >= since)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }
  // Pipeline link: completed runs on its production branch.
  const branch = linkBranch(link, pipelines);
  return builds
    .filter((b) => b.projectId === link.projectId && b.definition.id === link.definitionId && b.status === 'completed'
      && b.reason !== 'pullRequest' && (!branch || b.sourceBranch === branch) && Date.parse(b.finishedAt) >= since)
    .map((b) => ({ id: b.id, at: b.finishedAt, label: b.buildNumber, status: b.result, by: b.requestedFor?.displayName || null, webUrl: b.webUrl }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** A stable key for the environment a monitor link points at (see service.js productionTargets). */
export function targetKeyOf(link) {
  if (!link) return null;
  return link.type === 'release'
    ? `release:${link.projectId}:${link.definitionId}:${link.stage || ''}`
    : `pipeline:${link.projectId}:${link.definitionId}`;
}

/**
 * The branch a linked pipeline's deploy runs come from: as service.js settled it (`deployBranch`, the
 * Production branch when the pipeline runs on it), else the one it's learned to run on (see pipelines.js).
 */
const linkBranch = (link, pipelines) => ('deployBranch' in link ? link.deployBranch
  : pipelines.find((p) => p.projectId === link.projectId && p.definition.id === link.definitionId)?.branch || null);

// A deploy running longer than this no longer hides an outage.
export const DEPLOY_GRACE_MS = 60 * 60_000;

/**
 * The deploy running right now into the monitor's environment, if any: a
 * release stage that is deploying (not waiting on an approval), or a run of
 * the linked pipeline. Older than DEPLOY_GRACE_MS counts as not deploying.
 */
export function runningDeploy(monitor, { releases = [], pipelines = [], builds = [] }, now = Date.now()) {
  const link = monitor.link;
  if (!link) return null;
  let found = [];
  if (link.type === 'release') {
    const def = releases.find((d) => d.projectId === link.projectId && d.id === link.definitionId);
    found = (def?.releases || [])
      .map((r) => ({ r, s: r.stages.find((x) => !link.stage || x.name === link.stage) }))
      .filter(({ s }) => s?.deploying)
      .map(({ r, s }) => ({ label: r.name, startedAt: s.startedAt || s.at, by: s.requestedFor?.displayName || null, webUrl: r.webUrl }));
  } else {
    const branch = linkBranch(link, pipelines);
    found = builds
      .filter((b) => b.projectId === link.projectId && b.definition.id === link.definitionId && b.status === 'inProgress'
        && b.reason !== 'pullRequest' && (!branch || b.sourceBranch === branch))
      .map((b) => ({ label: b.buildNumber, startedAt: b.startedAt || b.queuedAt, by: b.requestedFor?.displayName || null, webUrl: b.webUrl }));
  }
  return found
    .filter((d) => d.startedAt && now - Date.parse(d.startedAt) < DEPLOY_GRACE_MS)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] || null;
}

/**
 * An environment's next deploy while it's under way: deploying now, or
 * waiting on an approval (a release stage's pre-deployment approval or gate,
 * a pipeline run's approval check). Only deploys started after `since` (the
 * last successful one) count, and a deploy running longer than
 * DEPLOY_GRACE_MS is taken as stuck, not deploying.
 */
export function deployUnderWay(target, { releases = [], builds = [], approvals = [] }, { since = null, now = Date.now() } = {}) {
  let found = [];
  if (target.type === 'release') {
    const def = releases.find((d) => d.projectId === target.projectId && d.id === target.definitionId);
    found = (def?.releases || [])
      .map((r) => ({ r, s: r.stages.find((x) => !target.stage || x.name === target.stage) }))
      .filter(({ s }) => s?.deploying || s?.waiting)
      .map(({ r, s }) => ({ state: s.deploying ? 'deploying' : 'approval', label: r.name, startedAt: s.startedAt || s.at, by: s.requestedFor?.displayName || null, webUrl: r.webUrl }));
  } else {
    found = builds
      .filter((b) => b.projectId === target.projectId && b.definition?.id === target.definitionId && b.status === 'inProgress'
        && b.reason !== 'pullRequest' && (!target.branch || b.sourceBranch === target.branch))
      .map((b) => ({
        state: approvals.some((a) => a.kind === 'yaml' && a.run?.id === b.id) ? 'approval' : 'deploying',
        label: b.buildNumber,
        startedAt: b.startedAt || b.queuedAt,
        by: b.requestedFor?.displayName || null,
        webUrl: b.webUrl,
      }));
  }
  return found
    .filter((d) => d.startedAt && (!since || Date.parse(d.startedAt) > Date.parse(since))
      && (d.state === 'approval' || now - Date.parse(d.startedAt) < DEPLOY_GRACE_MS))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] || null;
}

/** Failure rate over the Application Insights buckets in [from, to). */
function failRate(series, from, to) {
  const inRange = series.filter((b) => {
    const t = Date.parse(b.at);
    return t >= from && t < to;
  });
  const total = inRange.reduce((s, b) => s + (b.total || 0), 0);
  const failed = inRange.reduce((s, b) => s + (b.failed || 0), 0);
  return { total, rate: total ? failed / total : 0 };
}

/**
 * Health verdict for one monitor: state (up/degraded/down/deploying/unknown)
 * and the issues behind it, each with a severity for the inbox. While a deploy
 * is running (see runningDeploy) failed checks and errors are expected: the
 * state is "deploying" and nothing alerts.
 */
export function evaluateMonitor(m, markers = [], now = Date.now(), running = null) {
  const issues = [];
  const last = m.last;

  if (m.url && last) {
    // ISM sites answer an "platform/v1" envelope (see server/platform.js). Its "down" is the
    // site's own verdict, so it counts at once; no envelope at all (restarting, error page) only
    // counts after 3 polls in a row, as the platform contract asks.
    const envelope = last.platform?.status || null;
    const platformSite = !!m.platform;
    const downAfter = platformSite ? 3 : 2;
    const reason = last.error || 'no response';
    if (envelope === 'down' || (!last.ok && m.consecutiveFailures >= downAfter)) {
      issues.push({ code: 'down', severity: 'high', text: `Down for ${ago(now - Date.parse(m.downSince || last.at))}: ${reason}` });
    } else if (!last.ok) {
      issues.push({ code: 'check-failed', severity: platformSite ? 'low' : 'medium', text: `Last check failed: ${reason}` });
    } else if (envelope === 'degraded') {
      const failing = last.platform.failing?.[0];
      issues.push({ code: 'degraded', severity: 'medium', text: `Degraded: ${failing?.message || failing?.name || 'a check failed'}` });
    } else if (last.ms > m.latencyWarnMs) {
      issues.push({ code: 'slow', severity: 'medium', text: `Slow: ${(last.ms / 1000).toFixed(1)}s (limit ${(m.latencyWarnMs / 1000).toFixed(1)}s)` });
    }
  }

  const ai = m.ai;
  if (ai && ai.total >= 50 && ai.failRate >= 0.05) {
    issues.push({ code: 'failures', severity: ai.failRate >= 0.1 ? 'high' : 'medium', text: `${pct(ai.failRate)} of requests failing in the last hour (${ai.failed} of ${ai.total})` });
  }

  // Did the latest deploy make things worse? Compare the 6h before it with what came after.
  const deploy = markers.find((d) => now - Date.parse(d.at) < 24 * HOUR && Date.parse(d.at) < now - 30 * 60_000);
  if (ai?.series?.length && deploy) {
    const t = Date.parse(deploy.at);
    const before = failRate(ai.series, t - 6 * HOUR, t);
    const after = failRate(ai.series, t, now + 1);
    if (after.total >= 50 && after.rate >= 0.02 && after.rate >= Math.max(before.rate * 2, before.rate + 0.02)) {
      issues.push({
        code: 'deploy-regression',
        severity: 'high',
        text: `Failures up from ${pct(before.rate)} to ${pct(after.rate)} since ${deploy.label} (${ago(now - t)} ago)`,
        deploy,
      });
    }
  }

  if (m.aiError) issues.push({ code: 'ai-error', severity: 'low', text: m.aiError });
  if (m.totalsError) issues.push({ code: 'totals-error', severity: 'low', text: `Platform totals: ${m.totalsError}` });

  if (running) {
    const expected = new Set(['down', 'check-failed', 'degraded', 'slow', 'failures']);
    return {
      state: 'deploying',
      issues: [
        { code: 'deploying', severity: 'low', text: `Deploying ${running.label}, started ${ago(now - Date.parse(running.startedAt))} ago` },
        ...issues.filter((i) => !expected.has(i.code)),
      ],
    };
  }

  let state = 'unknown';
  if (issues.some((i) => i.code === 'down')) state = 'down';
  // A failed poll that isn't an outage yet (an ISM site restarting) still shows as degraded, without alerting.
  else if (issues.some((i) => i.severity !== 'low') || (last && !last.ok)) state = 'degraded';
  else if (last?.ok || ai) state = 'up';
  return { state, issues };
}
