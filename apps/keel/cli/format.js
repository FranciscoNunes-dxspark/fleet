// How Inbox items, pull requests and pipelines read in the terminal: icons, colours, the
// order of lists and the lines of the detail panes. Pure, so the tests can check it.
import { theme } from './theme.js';
import { fit, relTime } from './text.js';

export const branch = (ref) => String(ref ?? '').replace(/^refs\/heads\//, '');
const ago = (iso, now) => (iso ? relTime(Date.parse(iso), now) : '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const SEVERITY = {
  high: { icon: '●', color: theme.del, label: 'act now' },
  medium: { icon: '●', color: theme.warn, label: 'soon' },
  low: { icon: '●', color: theme.dim, label: 'when you can' },
};

export const KIND = { pr: 'PR', review: 'Review', work: 'Work', pipeline: 'Pipeline', approval: 'Approval', team: 'Team', production: 'Prod' };

export const REVIEW_STATE = {
  draft: { icon: '◌', color: theme.draft, label: 'draft' },
  rejected: { icon: '✗', color: theme.del, label: 'rejected' },
  'waiting-author': { icon: '‖', color: theme.warn, label: 'waiting on the author' },
  'no-reviewers': { icon: '○', color: theme.dim, label: 'no reviewers' },
  approved: { icon: '✓', color: theme.ok, label: 'approved' },
  'in-review': { icon: '●', color: theme.info, label: 'in review' },
};

/** A pull request's state; merge conflicts win, since nothing merges until they're fixed. */
export const prState = (pr) => (pr.hasConflicts ? { icon: '△', color: theme.del, label: 'merge conflicts' } : REVIEW_STATE[pr.reviewState] ?? REVIEW_STATE['in-review']);

export const VOTES = {
  10: { icon: '✓', color: theme.ok, label: 'approved' },
  5: { icon: '✓', color: theme.ok, label: 'approved with suggestions' },
  0: { icon: '·', color: theme.dim, label: 'no vote yet' },
  '-5': { icon: '‖', color: theme.warn, label: 'waiting for the author' },
  '-10': { icon: '✗', color: theme.del, label: 'rejected' },
};

export const HEALTH = {
  failing: { icon: '✗', color: theme.del, label: 'failing' },
  unstable: { icon: '◐', color: theme.warn, label: 'unstable' },
  healthy: { icon: '✓', color: theme.ok, label: 'healthy' },
  unknown: { icon: '?', color: theme.dim, label: 'no recent runs' },
};

/** A run's outcome: its result once finished, otherwise queued or running. */
export function runState(run) {
  if (run.status && run.status !== 'completed') return run.status === 'notStarted' ? { icon: '○', color: theme.dim, label: 'queued' } : { icon: '●', color: theme.accent, label: 'running' };
  return {
    succeeded: { icon: '✓', color: theme.ok, label: 'succeeded' },
    partiallySucceeded: { icon: '◐', color: theme.warn, label: 'partially succeeded' },
    failed: { icon: '✗', color: theme.del, label: 'failed' },
    canceled: { icon: '⊘', color: theme.dim, label: 'canceled' },
    // An approval said no: not a failure (see domain/pipelines.js wasDeclined).
    declined: { icon: '⊘', color: theme.dim, label: 'declined' },
  }[run.result] ?? { icon: '?', color: theme.dim, label: run.result || 'unknown' };
}

const GROUPS = [
  { id: 'review', title: 'Waiting on your review', test: (p) => p.needsMyReview },
  { id: 'mine', title: 'Yours', test: (p) => p.isMine },
  { id: 'other', title: 'Everyone else', test: () => true },
];

/** Does a pull request match the typed filter (title, repo, branch, author or !id)? */
export function prMatches(pr, text) {
  const q = text.trim().toLowerCase().replace(/^!/, '');
  if (!q) return true;
  return [pr.title, pr.repoName, pr.projectName, branch(pr.sourceBranch), pr.author?.displayName, String(pr.id)].some((s) => String(s ?? '').toLowerCase().includes(q));
}

/**
 * The pull requests list: those waiting on your review, then yours, then everyone else's, oldest
 * first in each, under a header row (`header: true`, not selectable). `show` narrows it to one group.
 */
export function prRows(prs, { show = 'all', filter = '' } = {}) {
  const left = prs.filter((p) => prMatches(p, filter));
  const rows = [];
  for (const g of GROUPS) {
    const mine = left.filter(g.test).sort((a, b) => b.ageHours - a.ageHours);
    for (const p of mine) left.splice(left.indexOf(p), 1);
    if (!mine.length || (show !== 'all' && show !== g.id)) continue;
    rows.push({ header: true, title: `${g.title} (${mine.length})` });
    rows.push(...mine.map((pr) => ({ pr })));
  }
  return rows;
}

/** A GitHub pull request: the only kind that says whether its branch requires a review. */
export const isGithubPr = (pr) => pr?.reviewRequired !== undefined;

/** What a pull request's current step waits on (server/domain/prs.js prFlow), in a sentence. */
export function flowWaiting(flow, github = false) {
  const w = flow?.waiting;
  const names = (w?.names ?? []).join(', ');
  if (!flow || flow.step === 'publish') return "A draft: p publishes it when it's ready for review.";
  if (flow.step === 'approval') {
    if (w?.kind === 'rejected') return `Rejected by ${names}.`;
    if (w?.kind === 'waiting-author') return `${names} ${w.names.length > 1 ? 'are' : 'is'} waiting for the author.`;
    // GitHub doesn't take the author's own approval, and its reviewers are asked for on GitHub.
    if (flow.own) return "Waiting for someone else's review: GitHub doesn't let you approve your own. Ask for one on GitHub (o).";
    if (w?.kind === 'no-reviewers') return github ? 'No reviewers yet: request them on GitHub (o).' : 'No reviewers yet: add some on the web, or m sets auto-complete.';
    if (w?.kind === 'required') return `Waiting on ${names} (required).`;
    return 'Waiting for an approval.';
  }
  const approved = flow.approval === 'not-required' ? 'This branch needs no review.' : 'Approved.';
  if (w?.kind === 'conflicts') return `${approved} Fix the merge conflicts to complete it.`;
  if (w?.kind === 'policies') return `${approved} Waiting on ${names}.`;
  if (w?.kind === 'auto') return `${approved} It completes by itself once its checks pass.`;
  return `${approved} Ready: c completes it.`;
}

const FLOW_STEPS = [['publish', 'Publish'], ['approval', 'Approval'], ['complete', 'Complete']];

/** "✓ Publish → ● Approval → ○ Complete": where a pull request is on its way, as segments. */
export function flowSegments(flow) {
  const at = FLOW_STEPS.findIndex(([id]) => id === flow?.step);
  const blocked = ['rejected', 'waiting-author', 'conflicts'].includes(flow?.waiting?.kind);
  return FLOW_STEPS.flatMap(([id, label], i) => {
    // A GitHub branch that asks for no review skips approval.
    const skipped = id === 'approval' && flow?.approval === 'not-required';
    const seg = skipped ? { text: `– ${label} (not required)`, color: theme.dim } : i < at ? { text: `✓ ${label}`, color: theme.ok } : i === at ? { text: `● ${label}`, color: blocked ? theme.del : theme.accent, bold: true } : { text: `○ ${label}`, color: theme.dim };
    return i ? [{ text: ' → ', color: theme.dim }, seg] : [seg];
  });
}

/** The detail pane of a pull request, as lines of segments. */
export function prDetail(pr, now = Date.now()) {
  const st = prState(pr);
  const lines = [
    [{ text: pr.title, bold: true }],
    [{ text: `!${pr.id} · ${pr.projectName} / ${pr.repoName}`, color: theme.dim }],
    [{ text: `${branch(pr.sourceBranch)} → ${branch(pr.targetBranch)}`, color: theme.info }],
    [{ text: `${pr.author?.displayName ?? 'Someone'} opened it ${ago(pr.createdAt, now)} ago`, color: theme.dim }],
    '',
    [{ text: `${st.icon} ${st.label}`, color: st.color, bold: true }, ...(pr.autoComplete ? [{ text: ' · auto-complete on', color: theme.ok }] : []), ...(pr.completesAt ? [{ text: ` · completes ${new Date(pr.completesAt).toLocaleString()}`, color: theme.info }] : [])],
  ];
  if (pr.labels?.length) lines.push([{ text: pr.labels.map((l) => `#${l}`).join(' '), color: theme.draft }]);
  if (pr.flow && pr.status === 'active') lines.push('', flowSegments(pr.flow), [{ text: flowWaiting(pr.flow, isGithubPr(pr)), color: theme.dim }]);
  lines.push('', [{ text: 'Reviewers', bold: true }]);
  if (!pr.reviewers.length) lines.push([{ text: '  none yet', color: theme.dim }]);
  for (const r of pr.reviewers) {
    const v = VOTES[r.vote] ?? VOTES[0];
    lines.push([
      { text: `  ${v.icon} `, color: v.color },
      { text: r.displayName, color: r.isContainer ? theme.dim : undefined },
      { text: `  ${v.label}${r.isRequired ? ' · required' : ''}`, color: theme.dim },
    ]);
  }
  if (pr.myVote != null) lines.push('', [{ text: `Your vote: ${(VOTES[pr.myVote] ?? VOTES[0]).label}`, color: theme.dim }]);
  return lines;
}

/** The detail pane of an Inbox item, as lines of segments. */
export function inboxDetail(item) {
  const sev = SEVERITY[item.severity] ?? SEVERITY.low;
  const lines = [
    [{ text: item.title, bold: true }],
    [{ text: item.context ?? '', color: theme.dim }],
    '',
    [{ text: `${sev.icon} ${KIND[item.kind] ?? item.kind} · ${sev.label}`, color: sev.color }],
    '',
    ...item.reasons.map((r) => [{ text: '  • ', color: (SEVERITY[r.severity] ?? SEVERITY.low).color }, { text: r.text }]),
  ];
  if (item.webUrl) lines.push('', [{ text: item.webUrl, color: theme.info }]);
  return lines;
}

/** One line about a pipeline's last runs: "64% green · failing 2 in a row · last green 2d ago". */
export function pipelineSummary(row, now = Date.now()) {
  const parts = [];
  if (row.passRate != null) parts.push(`${Math.round(row.passRate * 100)}% green`);
  if (row.failStreak > 1) parts.push(`failing ${row.failStreak} in a row`);
  if (row.health !== 'healthy' && row.lastGreenAt) parts.push(`last green ${ago(row.lastGreenAt, now)} ago`);
  if (row.medianDurationMin) parts.push(`~${Math.round(row.medianDurationMin)} min a run`);
  return parts.join(' · ');
}

/** The detail pane of a pipeline: its health, what's running, then its latest runs once they load. */
export function pipelineDetail(row, runs, { now = Date.now(), error = null } = {}) {
  const h = HEALTH[row.health] ?? HEALTH.unknown;
  const lines = [
    [{ text: row.definition.name, bold: true }],
    [{ text: `${row.projectName}${row.repoName ? ` / ${row.repoName}` : ''}${row.branch ? ` · ${branch(row.branch)}` : ''}`, color: theme.dim }],
    '',
    [{ text: `${h.icon} ${h.label}`, color: h.color, bold: true }, { text: `  ${pipelineSummary(row, now)}`, color: theme.dim }],
  ];
  for (const r of row.running ?? []) {
    const s = runState(r);
    lines.push([{ text: `${s.icon} ${s.label} `, color: s.color }, { text: `${r.buildNumber} on ${branch(r.sourceBranch)}`, color: theme.dim }]);
  }
  lines.push('', [{ text: 'Latest runs', bold: true }]);
  if (error) lines.push([{ text: `  Couldn't read them: ${error}`, color: theme.del }]);
  else if (!runs) lines.push([{ text: '  Loading…', color: theme.dim }]);
  else if (!runs.length) lines.push([{ text: '  None yet', color: theme.dim }]);
  else {
    for (const r of runs.slice(0, 15)) {
      const s = runState(r);
      lines.push([
        { text: `  ${s.icon} `, color: s.color },
        { text: `${r.buildNumber} `, color: theme.dim },
        { text: branch(r.sourceBranch) },
        { text: `  ${s.label} · ${ago(r.finishedAt || r.startedAt || r.queuedAt, now)} ago${r.requestedFor?.displayName ? ` · ${r.requestedFor.displayName}` : ''}`, color: theme.dim },
      ]);
    }
  }
  return lines;
}

/** "3 PRs · 2 waiting on you" for a tab or panel title. */
export const countLabel = (n, word, extra) => `${plural(n, word)}${extra ? ` · ${extra}` : ''}`;

const POLICY = { approved: '✓', rejected: '✗', running: '●', queued: '○', broken: '✗' };

/** A pull request in full (service.pullRequest), as plain text for the viewer. */
export function prFullText(pr, now = Date.now()) {
  const out = [
    pr.title,
    `!${pr.id} · ${pr.projectName} / ${pr.repoName} · ${branch(pr.sourceBranch)} → ${branch(pr.targetBranch)}`,
    `${pr.author?.displayName ?? 'Someone'} opened it ${ago(pr.createdAt, now)} ago · ${prState(pr).label}${pr.autoComplete ? ' · auto-complete on' : ''}`,
    ...(pr.flow && pr.status === 'active' ? [`${flowSegments(pr.flow).map((s) => s.text).join('')}  ${flowWaiting(pr.flow, isGithubPr(pr))}`] : []),
    '',
    ...(pr.description?.trim() ? pr.description.trim().split('\n') : ['(No description.)']),
  ];
  if (pr.policies?.length) {
    out.push('', 'Policies');
    for (const p of pr.policies) out.push(`  ${POLICY[p.status] ?? '·'} ${p.name}${p.isBlocking ? '' : ' (optional)'}  ${p.status}`);
  }
  out.push('', 'Reviewers');
  for (const r of pr.reviewers) out.push(`  ${(VOTES[r.vote] ?? VOTES[0]).icon} ${r.displayName}  ${(VOTES[r.vote] ?? VOTES[0]).label}${r.isRequired ? ' · required' : ''}`);
  if (pr.workItems?.length) {
    out.push('', 'Work items');
    for (const w of pr.workItems) out.push(`  ${w.type} ${w.id}  ${w.title}  (${w.state})`);
  }
  if (pr.files?.total) {
    out.push('', `Files (${pr.files.total}${pr.files.truncated ? '+' : ''})`);
    for (const f of pr.files.items.slice(0, 40)) out.push(`  ${fit(f.kind ?? '', 8)} ${f.path}${f.originalPath ? ` (was ${f.originalPath})` : ''}`);
    if (pr.files.items.length > 40) out.push(`  … ${pr.files.items.length - 40} more`);
  }
  if (pr.threads?.recent?.length) {
    out.push('', `Comments (${pr.threads.active} of ${pr.threads.total} threads active)`);
    for (const c of pr.threads.recent) {
      out.push(`  ${c.author?.displayName ?? 'Someone'}, ${ago(c.publishedAt, now)} ago${c.filePath ? ` on ${c.filePath}` : ''}${c.status === 'active' ? ' · active' : ''}`);
      out.push(...String(c.content).trim().split('\n').slice(0, 6).map((l) => `    ${l}`), '');
    }
  }
  return out.join('\n');
}

// ---- Work items

/** A work item's state, by its state category (never its name: processes differ). */
export const WI_STATE = {
  Proposed: { icon: '○', color: theme.dim },
  InProgress: { icon: '●', color: theme.info },
  Resolved: { icon: '◐', color: theme.warn },
  Completed: { icon: '✓', color: theme.ok },
  Removed: { icon: '⊘', color: theme.dim },
};
export const wiState = (w) => WI_STATE[w.stateCategory] ?? WI_STATE.Proposed;

/** Blocked, as the web app and the Inbox say it: the CMMI flag, a tag, or a state named like the tag. */
export function isBlocked(w, blockedTag) {
  const name = String(blockedTag || '').toLowerCase();
  return !!w.blocked || (!!name && (w.state?.toLowerCase() === name || (w.tags ?? []).some((t) => t.toLowerCase() === name)));
}

const DAY = 86_400_000;
const CATEGORY_ORDER = ['InProgress', 'Resolved', 'Proposed'];

/**
 * The web app's work item views, in its order: [{ id, label, test }]. `data` is service.workItems(),
 * `meta` service.meta() (the blocked tag and the "no update in N days" threshold).
 */
export function wiViews(data, meta, now = Date.now()) {
  const sprint = data?.currentIterationPaths ?? [];
  const stuckDays = meta?.thresholds?.itemStuckDays ?? 5;
  return [
    { id: 'all', label: 'all open', test: () => true },
    { id: 'sprint', label: 'current sprint', test: (w) => sprint.some((p) => w.iterationPath === p || w.iterationPath?.startsWith(`${p}\\`)) },
    { id: 'bugs', label: 'bugs', test: (w) => w.type === 'Bug' },
    { id: 'blocked', label: 'blocked', test: (w) => isBlocked(w, meta?.blockedTag) },
    { id: 'stuck', label: `no update in ${stuckDays}d`, test: (w) => w.stateCategory === 'InProgress' && now - Date.parse(w.changedAt) >= stuckDays * DAY },
    { id: 'unassigned', label: 'unassigned', test: (w) => !w.assignedTo },
    { id: 'mine', label: 'mine', test: (w) => !!data?.me && w.assignedTo?.id === data.me.id },
  ];
}
export const WI_VIEW_IDS = ['all', 'sprint', 'bugs', 'blocked', 'stuck', 'unassigned', 'mine'];

/** Does a work item match the typed filter (id, title, type, state, tag, person or project)? */
export function wiMatches(w, text) {
  const q = text.trim().toLowerCase().replace(/^#/, '');
  if (!q) return true;
  return [String(w.id), w.title, w.type, w.state, w.projectName, w.assignedTo?.displayName, ...(w.tags ?? [])].some((s) => String(s ?? '').toLowerCase().includes(q));
}

/** The list for a view: in progress first, then resolved, then new; by priority within each, then newest change. */
export function wiRows(data, meta, { view = 'all', filter = '' } = {}, now = Date.now()) {
  const v = wiViews(data, meta, now).find((x) => x.id === view) ?? wiViews(data, meta, now)[0];
  const cat = (w) => (CATEGORY_ORDER.indexOf(w.stateCategory) + 4) % 4;
  return (data?.items ?? [])
    .filter((w) => v.test(w) && wiMatches(w, filter))
    .sort((a, b) => cat(a) - cat(b) || (a.priority ?? 9) - (b.priority ?? 9) || Date.parse(b.changedAt) - Date.parse(a.changedAt));
}

/** The detail pane of a work item from the list, as lines of segments. */
export function wiDetail(w, meta, now = Date.now()) {
  const st = wiState(w);
  const lines = [
    [{ text: w.title, bold: true }],
    [{ text: `${w.type} ${w.id} · ${w.projectName}`, color: w.typeColor || theme.dim }],
    '',
    [{ text: `${st.icon} ${w.state}`, color: st.color, bold: true }, ...(isBlocked(w, meta?.blockedTag) ? [{ text: '  blocked', color: theme.del, bold: true }] : [])],
    [{ text: `Assigned to `, color: theme.dim }, { text: w.assignedTo?.displayName ?? 'nobody', color: w.assignedTo ? undefined : theme.warn }],
  ];
  const facts = [
    w.priority != null ? `priority ${w.priority}` : null,
    w.storyPoints != null ? `${w.storyPoints} points` : null,
    w.remainingWork != null ? `${w.remainingWork}h left` : null,
  ].filter(Boolean);
  if (facts.length) lines.push([{ text: facts.join(' · '), color: theme.dim }]);
  if (w.iterationPath) lines.push([{ text: w.iterationPath.split('\\').pop(), color: theme.dim }]);
  const tags = (w.tags ?? []).filter((t) => t.toLowerCase() !== String(meta?.blockedTag || '').toLowerCase());
  if (tags.length) lines.push([{ text: tags.map((t) => `#${t}`).join(' '), color: theme.draft }]);
  lines.push('', [{ text: `Changed ${ago(w.changedAt, now)} ago${w.stateChangedAt ? ` · in ${w.state} for ${ago(w.stateChangedAt, now)}` : ''}`, color: theme.dim }]);
  return lines;
}

/** A work item in full (service.workItem), as plain text for the viewer. */
export function wiFullText(w, now = Date.now()) {
  const out = [
    w.title,
    `${w.type} ${w.id} · ${w.projectName} · ${w.state} · ${w.assignedTo?.displayName ?? 'unassigned'}${w.priority != null ? ` · priority ${w.priority}` : ''}`,
    `${w.iterationPath ?? ''}${w.tags?.length ? ` · ${w.tags.map((t) => `#${t}`).join(' ')}` : ''}`,
    '',
    ...(w.description?.trim() ? w.description.trim().split('\n') : ['(No description.)']),
  ];
  if (w.acceptanceCriteria?.trim()) out.push('', 'Acceptance criteria', ...w.acceptanceCriteria.trim().split('\n').map((l) => `  ${l}`));
  if (w.parent) out.push('', 'Parent', `  ${w.parent.type} ${w.parent.id}  ${w.parent.title}  (${w.parent.state})`);
  if (w.children?.length) {
    out.push('', `Children (${w.children.length})`);
    for (const c of w.children) out.push(`  ${c.type} ${c.id}  ${c.title}  (${c.state}${c.assignedTo ? ` · ${c.assignedTo.displayName}` : ''})`);
  }
  if (w.pullRequests?.length) out.push('', 'Pull requests', ...w.pullRequests.map((p) => `  !${p.id}${p.title ? `  ${p.title}` : ''}${p.status ? `  (${p.status})` : ''}`));
  if (w.attachments?.length) out.push('', 'Attachments', ...w.attachments.map((f) => `  ${f.name}`));
  if (w.comments?.length) {
    out.push('', `Comments (${w.comments.length})`);
    for (const c of w.comments) {
      out.push(`  ${c.author?.displayName ?? 'Someone'}, ${ago(c.createdAt, now)} ago`);
      out.push(...String(c.text ?? '').trim().split('\n').slice(0, 8).map((l) => `    ${l}`), '');
    }
  }
  return out.join('\n');
}

// ---- The weekly summary (the web app's Weekly summary, and its "Copy as text")

const weekDay = (iso, year = false) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC', ...(year ? { year: 'numeric' } : {}) });

/** One week's summary (service.summary) as plain text: for the viewer, and to paste into an email or chat. */
export function summaryText(s) {
  const tot = s.totals;
  const lines = [
    `Week of ${weekDay(s.from)} – ${weekDay(s.to, true)}${s.current ? ' (this week, so far)' : ''}`,
    '',
    `• ${plural(tot.finished, 'item')} finished (${tot.features} features and stories, ${plural(tot.bugs, 'bug')} fixed)`,
    `• ${plural(tot.merged, 'pull request')} merged`,
    `• ${plural(tot.deploys, 'deploy')} to production${tot.failedDeploys ? ` (${tot.failedDeploys} failed)` : ''}`,
    `• ${plural(tot.blocked, 'item')} blocked right now · ${tot.inProgress} in progress`,
  ];
  const list = (heading, items) => {
    if (!items?.length) return;
    lines.push('', heading);
    for (const w of items) lines.push(`- ${w.title} (${w.projectName}, ${w.type} #${w.id}${w.assignedTo ? `, ${w.assignedTo}` : ''})`);
  };
  list('Finished', s.features);
  list('Bugs fixed', s.bugs);
  if (s.mergedByRepo?.length) {
    lines.push('', 'Merged, by repository');
    for (const r of s.mergedByRepo) lines.push(`- ${r.repoName} (${r.projectName}): ${plural(r.count, 'pull request')}`);
  }
  if (s.deploys?.length) {
    lines.push('', 'Deployed to production');
    const groups = new Map();
    for (const d of s.deploys) {
      const key = `${d.org ?? ''}:${d.target}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    for (const list of groups.values()) {
      const ok = list.filter((d) => d.status === 'succeeded').length;
      const failed = list.length - ok;
      lines.push(`- ${list[0].target}: ${plural(ok, 'deploy')}${failed ? `, ${failed} failed` : ''} (latest ${list[0].label}, ${weekDay(list[0].at)})`);
    }
  }
  list('Blocked right now', s.blocked);
  return lines.join('\n');
}

/**
 * Which week `/summary` means, as a day in it: nothing for this week, "last" (or -1) for the one
 * before, -N for N weeks back (up to 26, as the web app goes), or a date (YYYY-MM-DD). Null otherwise.
 */
export function summaryWeek(text, now = Date.now()) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s || s === 'this') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s))) return s;
  const back = s === 'last' ? 1 : /^-\d{1,2}$/.test(s) ? -Number(s) : null;
  if (back == null || back > 26) return null;
  return new Date(now - back * 7 * 86_400_000).toISOString().slice(0, 10);
}

// ---- Production (the web app's Production page and Waiting to ship)

export const MONITOR_STATE = {
  down: { icon: '✗', color: theme.del, label: 'down' },
  degraded: { icon: '◐', color: theme.warn, label: 'degraded' },
  deploying: { icon: '●', color: theme.info, label: 'deploying' },
  settling: { icon: '●', color: theme.info, label: 'just deployed' },
  up: { icon: '✓', color: theme.ok, label: 'up' },
  unknown: { icon: '?', color: theme.dim, label: 'no data yet' },
};
export const monitorState = (m) => MONITOR_STATE[m.state] ?? MONITOR_STATE.unknown;
const RANK = { down: 0, degraded: 1, deploying: 2, settling: 3, up: 4, unknown: 5 };

/** Monitors that need you first (down, degraded, deploying), the rest in their order from Settings. */
export const monitorRows = (monitors, filter = '') => {
  const q = filter.trim().toLowerCase();
  return (monitors ?? [])
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !q || [m.name, m.url, m.state].some((s) => String(s ?? '').toLowerCase().includes(q)))
    .sort((a, b) => (RANK[a.m.state] ?? 5) - (RANK[b.m.state] ?? 5) || a.i - b.i)
    .map(({ m }) => m);
};

const pct = (x) => (x == null ? '—' : x < 0.01 && x > 0 ? `${(x * 100).toFixed(1)}%` : `${Math.round(x * 100)}%`);
const ms = (n) => (n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);

/** A list row's short version: the response time, and the failure rate (or the uptime, without Application Insights). */
export function monitorBrief(m) {
  const second = m.ai ? `${pct(m.ai.failRate)} failing` : m.uptime24h != null ? `${pct(m.uptime24h)} up` : null;
  return [m.last ? ms(m.last.ms) : null, second].filter(Boolean).join(' · ');
}

/** "200ms · 100% up · 0.4% failing": a monitor's numbers on one line. */
export function monitorNumbers(m) {
  return [
    m.last ? ms(m.last.ms) : null,
    m.uptime24h != null ? `${pct(m.uptime24h)} up` : null,
    m.ai ? `${pct(m.ai.failRate)} failing` : null,
  ].filter(Boolean).join(' · ');
}

const DEPLOY_STATE = { running: 'Deploying now', approval: 'Waiting for approval', queued: 'Queued' };

/** What a production environment has waiting (service.undeployed's target), as lines. */
function waitingLines(t, now) {
  if (!t) return [];
  const lines = ['', [{ text: 'Waiting to ship', bold: true }]];
  if (t.deploy) lines.push([{ text: `  ● ${DEPLOY_STATE[t.deploy.state] ?? 'Deploying'}: ${t.deploy.label}${t.deploy.startedAt ? `, since ${ago(t.deploy.startedAt, now)} ago` : ''}`, color: theme.info }]);
  if (t.lastFailed) lines.push([{ text: `  ✗ Last deploy failed (${t.lastFailed.label ?? ''}); production is still on ${t.lastDeploy?.label ?? 'an earlier one'}`, color: theme.del }]);
  if (!t.waiting) lines.push([{ text: `  Nothing: ${t.branch ?? 'its branch'} is all deployed${t.lastDeploy ? ` (${t.lastDeploy.label}, ${ago(t.lastDeploy.at, now)} ago)` : ''}.`, color: theme.ok }]);
  else {
    const old = t.oldestAt && now - Date.parse(t.oldestAt) > 7 * 86_400_000;
    lines.push([{ text: `  ${plural(t.waiting, 'change')} on ${t.branch ?? 'its branch'}`, bold: true }, { text: t.oldestAt ? `  oldest merged ${ago(t.oldestAt, now)} ago` : '', color: old ? theme.warn : theme.dim }]);
    for (const p of (t.pullRequests ?? []).slice(0, 5)) lines.push([{ text: `  !${p.id} `, color: theme.dim }, { text: p.title }]);
    for (const c of (t.directCommits ?? []).slice(0, Math.max(0, 5 - (t.pullRequests?.length ?? 0)))) lines.push([{ text: `  ${c.id.slice(0, 7)} `, color: theme.dim }, { text: c.subject ?? c.message }]);
    const more = t.waiting - Math.min(5, t.waiting);
    if (more > 0) lines.push([{ text: `  … ${more} more (↵ lists them all)`, color: theme.dim }]);
  }
  if (t.upcoming?.length) lines.push([{ text: `  Coming next: ${plural(t.upcoming.length, 'open pull request')}`, color: theme.dim }]);
  return lines;
}

/** The detail pane of a monitor, as lines of segments; `target` is what's waiting to ship to its environment. */
export function monitorDetail(m, target, now = Date.now()) {
  const st = monitorState(m);
  const lines = [
    [{ text: m.name, bold: true }],
    [{ text: m.url || 'No URL to check', color: theme.dim }],
    '',
    [{ text: `${st.icon} ${st.label}`, color: st.color, bold: true }, { text: `  ${monitorNumbers(m)}`, color: theme.dim }],
  ];
  for (const i of m.issues ?? []) lines.push([{ text: '  • ', color: (SEVERITY[i.severity] ?? SEVERITY.low).color }, { text: i.text }]);
  if (m.ai) lines.push([{ text: `p95 ${ms(m.ai.p95)} · ${m.ai.exceptions} exceptions · ${m.ai.total} requests in the last hour`, color: theme.dim }]);
  if (m.markers?.length) {
    lines.push('', [{ text: 'Deploys', bold: true }]);
    for (const d of m.markers.slice(0, 3)) {
      const s = runState({ status: d.status === 'inProgress' ? 'inProgress' : 'completed', result: d.status });
      lines.push([{ text: `  ${s.icon} `, color: s.color }, { text: d.label }, { text: `  ${ago(d.at, now)} ago${d.by ? ` · ${d.by}` : ''}`, color: theme.dim }]);
    }
  }
  if (!m.targetKey) return [...lines, '', [{ text: "It isn't linked to the release stage or pipeline that deploys it, so Keel can't say what's waiting to ship (link it in the web app: Settings → Production monitors).", color: theme.dim }]];
  if (target === undefined) return [...lines, '', [{ text: 'Waiting to ship', bold: true }], [{ text: '  Reading…', color: theme.dim }]];
  return [...lines, ...waitingLines(target, now)];
}

/** A monitor in full, with everything waiting to ship to its environment, as plain text for the viewer. */
export function monitorFullText(m, target, now = Date.now()) {
  const out = [m.name, m.url || '', '', `${monitorState(m).label}  ${monitorNumbers(m)}`];
  for (const i of m.issues ?? []) out.push(`  • ${i.text}`);
  if (m.ai?.topFailures?.length) out.push('', 'Failing most (last hour)', ...m.ai.topFailures.map((f) => `  ${f.count}× ${f.name}${f.code ? ` (${f.code})` : ''}`));
  if (m.ai?.topNotFound?.length) out.push('', 'Missing pages asked for (404s, not counted as failures)', ...m.ai.topNotFound.map((f) => `  ${f.count}× ${f.name}`));
  if (m.markers?.length) out.push('', 'Deploys', ...m.markers.map((d) => `  ${d.label}  ${d.status} · ${ago(d.at, now)} ago${d.by ? ` · ${d.by}` : ''}`));
  if (target) {
    out.push('', `Waiting to ship to ${target.name} (${target.branch ?? 'its branch'})`);
    if (target.deploy) out.push(`  ${DEPLOY_STATE[target.deploy.state] ?? 'Deploying'}: ${target.deploy.label}`);
    if (!target.waiting) out.push('  Nothing: all deployed.');
    for (const p of target.pullRequests ?? []) {
      out.push(`  !${p.id} ${p.title}${p.author ? ` · ${p.author}` : ''}${p.mergedAt ? ` · merged ${ago(p.mergedAt, now)} ago` : ''}`);
    }
    for (const c of target.directCommits ?? []) out.push(`  ${c.id.slice(0, 7)} ${c.subject ?? c.message}${c.author?.name ? ` · ${c.author.name}` : ''} (pushed without a pull request)`);
    if (target.workItems?.length) out.push('', 'Work items it delivers', ...target.workItems.map((w) => `  ${w.type} ${w.id}  ${w.title}  (${w.state})`));
    if (target.upcoming?.length) out.push('', 'Coming next (open pull requests into that branch)', ...target.upcoming.map((p) => `  !${p.id} ${p.title} · ${p.author} · ${(REVIEW_STATE[p.reviewState] ?? REVIEW_STATE['in-review']).label}${p.hasConflicts ? ' · conflicts' : ''}`));
  }
  return out.join('\n');
}
