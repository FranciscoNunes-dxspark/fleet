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
      .map(({ r, s }) => ({ at: s.at, label: r.name, status: s.status, by: s.requestedFor?.displayName || null, webUrl: r.webUrl }))
      .filter((d) => Date.parse(d.at) >= since)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }
  // Pipeline link: completed runs on the pipeline's own branch (see pipelines.js).
  const row = pipelines.find((p) => p.projectId === link.projectId && p.definition.id === link.definitionId);
  return builds
    .filter((b) => b.projectId === link.projectId && b.definition.id === link.definitionId && b.status === 'completed'
      && b.reason !== 'pullRequest' && (!row?.branch || b.sourceBranch === row.branch) && Date.parse(b.finishedAt) >= since)
    .map((b) => ({ at: b.finishedAt, label: b.buildNumber, status: b.result, by: b.requestedFor?.displayName || null, webUrl: b.webUrl }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
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
 * Health verdict for one monitor: state (up/degraded/down/unknown) and the
 * issues behind it, each with a severity for the inbox.
 */
export function evaluateMonitor(m, markers = [], now = Date.now()) {
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

  let state = 'unknown';
  if (issues.some((i) => i.code === 'down')) state = 'down';
  // A failed poll that isn't an outage yet (an ISM site restarting) still shows as degraded, without alerting.
  else if (issues.some((i) => i.severity !== 'low') || (last && !last.ok)) state = 'degraded';
  else if (last?.ok || ai) state = 'up';
  return { state, issues };
}
