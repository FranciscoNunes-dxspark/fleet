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
