import { DAY, HOUR } from './prs.js';

const RANK = { high: 0, medium: 1, low: 2 };
const worst = (reasons) => reasons.reduce((s, r) => (RANK[r.severity] < RANK[s] ? r.severity : s), 'low');

export function fmtAge(hours) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

// Blocked can be the CMMI flag, a tag, or a custom state with the same name.
export const isBlocked = (w, blockedTag) => {
  const name = String(blockedTag || '').toLowerCase();
  return w.blocked || (!!name && (w.state?.toLowerCase() === name || w.tags.some((t) => t.toLowerCase() === name)));
};
const isP1Bug = (w) => w.type === 'Bug' && (Number(w.priority) === 1 || String(w.severity || '').startsWith('1'));

/**
 * The lead's inbox: one entry per PR / work item / pipeline / person with
 * every reason it needs attention, ranked by the worst reason.
 */
export function buildAttention({ prs, items, pipelines, workload, settings, currentIterationPaths = [], releases = [], approvals = [], production = [], now = Date.now() }) {
  const t = settings.thresholds;
  const out = [];

  // Production first: an outage or a bad deploy outranks everything else.
  for (const m of production) {
    const issues = m.issues.filter((i) => i.severity !== 'low');
    if (!issues.length) continue;
    out.push({
      key: `prod:${m.id}:${issues.map((i) => i.code).sort().join(',')}`,
      kind: 'production',
      severity: worst(issues),
      title: `${m.name} is ${m.state === 'down' ? 'down' : 'degraded'}`,
      context: m.url || 'Application Insights',
      reasons: issues.map(({ code, severity, text }) => ({ code, severity, text })),
      at: m.downSince || m.last?.at || m.ai?.at || null,
      target: { type: 'production' },
      webUrl: m.url || null,
    });
  }

  // Deployments waiting on an approval you can give: these block a release.
  for (const a of approvals.filter((x) => x.canDecide)) {
    out.push({
      key: `approval:${a.kind}:${a.id}`,
      kind: 'approval',
      severity: 'high',
      title: `Approve ${a.pipeline}${a.stage ? ` → ${a.stage}` : ''}`,
      context: `${a.projectName}${a.run ? ` · ${a.run.name}` : ''} · ${a.kind === 'yaml' ? 'pipeline check' : 'release approval'}`,
      reasons: [{
        code: 'approval',
        severity: 'high',
        text: `${a.forMe ? 'Waiting on you' : 'Waiting on your team'} for ${fmtAge((now - Date.parse(a.createdOn)) / HOUR)}${a.instructions ? `: "${a.instructions.slice(0, 80)}"` : ''}`,
      }],
      at: a.createdOn,
      target: { type: 'approval', key: `${a.kind}:${a.id}` },
      webUrl: a.run?.webUrl || null,
    });
  }

  for (const d of releases) {
    for (const s of d.stages.filter((x) => x.latest?.status === 'rejected')) {
      out.push({
        key: `release:${d.key}:${s.id}:${s.latest.releaseId}`,
        kind: 'pipeline',
        severity: 'high',
        title: `${d.name}: ${s.name} deployment failed`,
        context: `${d.projectName} · ${s.latest.releaseName}`,
        reasons: [{ code: 'release-failed', severity: 'high', text: `Last deployment to ${s.name} failed or was rejected ${fmtAge((now - Date.parse(s.latest.at)) / HOUR)} ago` }],
        at: s.latest.at,
        target: { type: 'release', key: d.key },
        webUrl: s.latest.webUrl,
      });
    }
  }

  for (const pr of prs.filter((p) => p.status === 'active')) {
    const reasons = [];
    const h = pr.ageHours;
    if (pr.needsMyReview) {
      reasons.push({ code: 'my-review', severity: h >= t.myReviewHours ? 'high' : 'medium', text: `Waiting on your review for ${fmtAge(h)}` });
    }
    if (!pr.isDraft) {
      if (!pr.reviewers.length) reasons.push({ code: 'no-reviewers', severity: 'high', text: 'No reviewers assigned' });
      else if (!pr.approvals && h >= t.prNoReviewHours && !pr.needsMyReview) {
        reasons.push({ code: 'no-approvals', severity: 'medium', text: `No approvals after ${fmtAge(h)}` });
      }
      if (pr.reviewState === 'rejected') {
        reasons.push({ code: 'rejected', severity: 'medium', text: `Rejected by ${pr.reviewers.filter((r) => r.vote === -10).map((r) => r.displayName).join(', ')}` });
      }
      if (h >= t.stalePrDays * 24) {
        reasons.push({ code: 'stale', severity: h >= t.stalePrDays * 48 ? 'high' : 'medium', text: `Open ${fmtAge(h)} (stale)` });
      }
      if (pr.readyToMerge && !pr.autoComplete && h >= 24) {
        reasons.push({ code: 'ready', severity: 'low', text: 'Approved but not merged — set auto-complete or nudge author' });
      }
    } else if (h >= t.stalePrDays * 48) {
      reasons.push({ code: 'stale-draft', severity: 'low', text: `Draft open ${fmtAge(h)}` });
    }
    if (pr.hasConflicts) reasons.push({ code: 'conflicts', severity: 'medium', text: 'Merge conflicts' });
    if (pr.isMine && pr.reviewState === 'waiting-author') reasons.push({ code: 'mine-waiting', severity: 'medium', text: 'Reviewers are waiting on you (your PR)' });

    if (reasons.length) {
      out.push({
        key: `pr:${pr.key}`,
        kind: pr.needsMyReview ? 'review' : 'pr',
        severity: worst(reasons),
        title: pr.title,
        context: `${pr.projectName} / ${pr.repoName} · !${pr.id} · ${pr.author?.displayName}`,
        reasons,
        at: pr.createdAt,
        target: { type: 'pr', projectId: pr.projectId, repoId: pr.repoId, id: pr.id },
        webUrl: pr.webUrl,
      });
    }
  }

  const inSprint = (w) => currentIterationPaths.some((path) => w.iterationPath === path || w.iterationPath?.startsWith(`${path}\\`));
  for (const w of items.filter((x) => x.stateCategory !== 'Completed' && x.stateCategory !== 'Removed')) {
    const reasons = [];
    if (isBlocked(w, settings.blockedTag)) reasons.push({ code: 'blocked', severity: 'high', text: 'Blocked' });
    if (isP1Bug(w)) {
      if (!w.assignedTo) reasons.push({ code: 'p1-unassigned', severity: 'high', text: 'P1 bug with no owner' });
      else if (w.stateCategory === 'Proposed') reasons.push({ code: 'p1-not-started', severity: 'high', text: 'P1 bug not started' });
    }
    const idleDays = (now - Date.parse(w.changedAt)) / DAY;
    if (w.stateCategory === 'InProgress' && idleDays >= t.itemStuckDays && !reasons.some((r) => r.code === 'blocked')) {
      reasons.push({ code: 'stuck', severity: 'medium', text: `In "${w.state}" with no updates for ${Math.floor(idleDays)}d` });
    }
    if (!w.assignedTo && inSprint(w) && !reasons.some((r) => r.code === 'p1-unassigned')) {
      reasons.push({ code: 'sprint-unassigned', severity: 'low', text: 'In current sprint but unassigned' });
    }
    if (reasons.length) {
      out.push({
        key: `wi:${w.id}`,
        kind: 'work',
        workItemType: w.type,
        severity: worst(reasons),
        title: w.title,
        context: `${w.projectName} · ${w.type} ${w.id} · ${w.assignedTo?.displayName || 'Unassigned'}`,
        reasons,
        at: w.changedAt,
        target: { type: 'workitem', id: w.id },
        webUrl: w.webUrl,
      });
    }
  }

  for (const p of pipelines) {
    if (p.health === 'failing') {
      out.push({
        key: `build:${p.key}:${p.latest?.id}`,
        kind: 'pipeline',
        severity: 'high',
        title: `${p.definition.name} is failing on ${p.branch}`,
        context: `${p.projectName}${p.repoName ? ` / ${p.repoName}` : ''} · ${p.failStreak} consecutive failure${p.failStreak === 1 ? '' : 's'}`,
        reasons: [{ code: 'failing', severity: 'high', text: p.lastGreenAt ? `Last green ${fmtAge((now - Date.parse(p.lastGreenAt)) / HOUR)} ago` : 'No green run in the lookback window' }],
        at: p.latest?.finishedAt,
        target: { type: 'pipeline', key: p.key },
        webUrl: p.latest?.webUrl,
      });
    } else if (p.health === 'unstable' && p.passRate !== null && p.passRate < 0.8) {
      out.push({
        key: `build-flaky:${p.key}`,
        kind: 'pipeline',
        severity: 'low',
        title: `${p.definition.name} is unstable`,
        context: `${p.projectName}${p.repoName ? ` / ${p.repoName}` : ''}`,
        reasons: [{ code: 'flaky', severity: 'low', text: `${Math.round(p.passRate * 100)}% pass rate over ${p.runCount} runs` }],
        at: p.latest?.finishedAt,
        target: { type: 'pipeline', key: p.key },
        webUrl: p.latest?.webUrl,
      });
    }
  }

  for (const row of workload.filter((r) => r.overloaded)) {
    out.push({
      key: `person:${row.person.id}:${row.flags.join('|')}`,
      kind: 'team',
      severity: 'low',
      title: `${row.person.displayName} may be overloaded`,
      context: 'Team load',
      reasons: row.flags.map((text) => ({ code: 'load', severity: 'low', text })),
      at: null,
      target: { type: 'person', id: row.person.id },
      webUrl: null,
    });
  }

  const snoozed = settings.snoozed || {};
  const visible = out.filter((i) => !(snoozed[i.key] && Date.parse(snoozed[i.key]) > now));
  visible.sort((a, b) => RANK[a.severity] - RANK[b.severity]
    || (a.at && b.at ? Date.parse(a.at) - Date.parse(b.at) : 0));

  return {
    items: visible,
    snoozedCount: out.length - visible.length,
    summary: {
      myReviews: prs.filter((p) => p.needsMyReview).length,
      myPrsBlocked: prs.filter((p) => p.isMine && (p.reviewState === 'rejected' || p.reviewState === 'waiting-author' || p.hasConflicts)).length,
      stalePrs: prs.filter((p) => !p.isDraft && p.ageHours >= t.stalePrDays * 24).length,
      activePrs: prs.length,
      failingPipelines: pipelines.filter((p) => p.health === 'failing').length + releases.filter((d) => d.health === 'failing').length,
      approvals: approvals.filter((x) => x.canDecide).length,
      productionIssues: production.filter((m) => m.state === 'down' || m.state === 'degraded').length,
      blockedItems: items.filter((w) => w.stateCategory !== 'Completed' && isBlocked(w, settings.blockedTag)).length,
      p1Bugs: items.filter((w) => w.stateCategory !== 'Completed' && isP1Bug(w)).length,
      high: visible.filter((i) => i.severity === 'high').length,
    },
  };
}
