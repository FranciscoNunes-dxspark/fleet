// The Desk's queues and the Control room's tiles and timeline, from what the API already
// sends. Pure, like stages.js, so the rules can be tested without a browser; words are codes
// here and the pages translate them.

const HOUR = 36e5;

/**
 * The Desk's queues, in the order they're listed (and numbered, for the keys 1–8): what to do
 * now, then by kind. "Broken" puts production and pipelines together: both are things on fire.
 */
export const DESK_QUEUES = [
  { id: 'now', holds: (i) => i.severity === 'high' },
  { id: 'review', holds: (i) => i.kind === 'review' },
  { id: 'approval', holds: (i) => i.kind === 'approval' },
  { id: 'broken', holds: (i) => i.kind === 'production' || i.kind === 'pipeline' },
  { id: 'pr', holds: (i) => i.kind === 'pr' },
  { id: 'work', holds: (i) => i.kind === 'work' },
  { id: 'team', holds: (i) => i.kind === 'team' },
  { id: 'all', holds: () => true },
];

/** Each queue with its entries, in the Inbox's own order (most urgent, then oldest). */
export function deskQueues(items = []) {
  return DESK_QUEUES.map((q) => {
    const list = items.filter(q.holds);
    return { id: q.id, items: list, count: list.length, high: list.filter((i) => i.severity === 'high').length };
  });
}

/** The monitor an Inbox production entry is about (its key is prod:<monitor id>:<codes>). */
export const monitorIdOf = (item) => (item?.kind === 'production' ? String(item.key).split(':')[1] : null);

/**
 * One tile per production monitor, with what's on its way to it: its state and response, the
 * last day's checks (for the sparkline), its latest deploy, a deploy under way, and how many
 * merged changes wait to ship to it (from the deploy target the monitor is linked to).
 */
export function serviceTiles({ production, pending } = {}, now = Date.now()) {
  const targets = new Map((pending?.targets || []).map((t) => [t.key, t]));
  const rank = { down: 0, degraded: 1, deploying: 2, settling: 3, up: 4 };
  return (production?.monitors || []).map((m) => {
    const target = m.targetKey ? targets.get(m.targetKey) : null;
    const last = m.markers?.[0] || target?.lastDeploy || null;
    return {
      id: m.id, name: m.name, url: m.url, state: m.state || 'unknown',
      latency: m.last?.ms != null ? Math.round(m.last.ms) : null, uptime: m.uptime24h ?? null, p95: m.p95ms ?? null,
      checks: (m.history || []).filter((h) => now - Date.parse(h.at) <= 24 * HOUR).map((h) => ({ ok: h.ok, ms: h.ms })),
      lastDeploy: last ? { label: last.label, at: last.at, by: last.by || null } : null,
      deploying: m.deploy ? { label: m.deploy.label, at: m.deploy.startedAt } : null,
      waiting: target?.waiting ?? null, oldestAt: target?.oldestAt ?? null,
      issues: (m.issues || []).length,
      db: m.ai?.db ? { p95: m.ai.db.p95 ?? null, failRate: m.ai.db.failRate ?? 0, calls: m.ai.db.calls ?? 0 } : null,
    };
  }).sort((a, b) => (rank[a.state] ?? 5) - (rank[b.state] ?? 5) || a.name.localeCompare(b.name));
}

/**
 * What happened in the last `hours`, newest first: pipeline runs finishing, deploys reaching
 * production, apps going down, approvals starting to wait and pull requests merging. Each
 * event: { key, at, code, tone, … the names its sentence needs, open | link }.
 */
export function buildTimeline({ pipelines, pending, production, approvals, closed } = {}, now = Date.now(), hours = 24) {
  const since = now - hours * HOUR;
  const within = (iso) => iso && Date.parse(iso) >= since && Date.parse(iso) <= now;
  const events = [];

  for (const p of pipelines || []) {
    for (const r of p.recent || []) {
      if (!within(r.finishedAt) || !r.result) continue;
      events.push({
        key: `run:${p.key}:${r.id}`, at: r.finishedAt, code: 'run', result: r.result,
        tone: r.result === 'succeeded' ? 'ok' : r.result === 'failed' ? 'bad' : r.result === 'partiallySucceeded' ? 'warn' : 'idle',
        name: p.definition.name, label: r.buildNumber, open: { type: 'pipeline', key: p.key, buildId: r.id },
      });
    }
  }

  // Deploys: each monitor's markers, and the latest deploy of targets no monitor watches; once each.
  const seen = new Set();
  const names = new Map();
  for (const m of production?.monitors || []) {
    if (m.targetKey) names.set(m.targetKey, m.name);
    for (const d of m.markers || []) {
      const id = `${m.targetKey || m.id}:${d.label}`;
      if (!within(d.at) || seen.has(id)) continue;
      seen.add(id);
      events.push({ key: `dep:${id}`, at: d.at, code: 'deploy', tone: d.status === 'failed' ? 'bad' : 'info', name: m.name, label: d.label, by: d.by || null, link: '/production' });
    }
    if (m.downSince && within(m.downSince)) {
      events.push({ key: `down:${m.id}`, at: m.downSince, code: 'down', tone: 'bad', name: m.name, link: '/production' });
    }
    for (const issue of m.issues || []) {
      if (issue.code === 'deploy-regression' && within(issue.deploy?.at)) {
        events.push({ key: `reg:${m.id}:${issue.deploy.label}`, at: issue.deploy.at, code: 'regression', tone: 'warn', name: m.name, label: issue.deploy.label, link: '/production' });
      }
    }
  }
  for (const t of pending?.targets || []) {
    const d = t.lastDeploy;
    const id = `${t.key}:${d?.label}`;
    if (!d || !within(d.at) || seen.has(id)) continue;
    seen.add(id);
    events.push({ key: `dep:${id}`, at: d.at, code: 'deploy', tone: 'info', name: names.get(t.key) || t.name, label: d.label, by: d.by || null, link: '/ship' });
  }

  for (const a of approvals || []) {
    if (!within(a.createdOn)) continue;
    events.push({ key: `appr:${a.key}`, at: a.createdOn, code: 'approval', tone: 'warn', name: `${a.pipeline}${a.stage ? ` → ${a.stage}` : ''}`, mine: !!a.canDecide, link: '/line/deploying' });
  }

  const merged = Array.isArray(closed) ? closed : Array.isArray(closed?.prs) ? closed.prs : [];
  for (const p of merged) {
    if (p.status !== 'completed' || !within(p.closedAt)) continue;
    events.push({
      key: `merge:${p.key}`, at: p.closedAt, code: 'merged', tone: 'accent', name: p.title, repo: p.repoName,
      by: p.closedBy?.displayName || p.author?.displayName || null, open: { type: 'pr', projectId: p.projectId, repoId: p.repoId, id: p.id },
    });
  }

  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
