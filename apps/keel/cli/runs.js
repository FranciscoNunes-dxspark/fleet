// One pipeline run in full, for the viewer (l in Pipelines, /logs): its stages, jobs and steps as
// a tree, what failed with the last lines of its log, the tests and the commits it built. Pure,
// so the tests can check it. The data is service.runDetails(), as the web app's run panel shows.
import { branch, runState } from './format.js';
import { relTime } from './text.js';

const ago = (iso, now) => (iso ? `${relTime(Date.parse(iso), now)} ago` : '');
const RESULT = { succeeded: '✓', succeededWithIssues: '◐', partiallySucceeded: '◐', failed: '✗', canceled: '⊘', skipped: '⊘', abandoned: '⊘' };
// How many lines of a failed step's log to show: its end is where the error is.
const LOG_LINES = 40;

/** "3m 15s", "42s", "1h 5m": how long a record ran. */
export function took(from, to) {
  if (!from || !to) return '';
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const icon = (r) => (r.state === 'inProgress' ? '●' : r.state === 'pending' ? '○' : RESULT[r.result] ?? '·');
const status = (r) => (r.state === 'inProgress' ? 'running' : r.state === 'pending' ? 'waiting' : r.result === 'succeeded' ? '' : r.result ?? '');

/** The timeline as indented lines: every stage and job, and the steps of jobs that failed or are running. */
function tree(timeline, logs) {
  const kids = new Map();
  for (const r of timeline) {
    const k = r.parentId ?? null;
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(r);
  }
  for (const list of kids.values()) list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const out = [];
  const walk = (parent, depth) => {
    for (const r of kids.get(parent) ?? []) {
      const pad = '  '.repeat(depth);
      const s = status(r);
      out.push(`${pad}${icon(r)} ${r.name}${s ? `  ${s}` : ''}${r.result !== 'skipped' && took(r.startedAt, r.finishedAt) ? `  ${took(r.startedAt, r.finishedAt)}` : ''}`);
      for (const i of (r.issues ?? []).filter((x) => x.type === 'error').slice(0, 5)) out.push(`${pad}    ${i.type}: ${i.message}`);
      if (logs?.[r.id]) {
        const lines = String(logs[r.id]).replace(/\r/g, '').split('\n').filter((l) => l.trim());
        out.push(`${pad}    ── the last ${Math.min(LOG_LINES, lines.length)} lines of its log ──`);
        for (const l of lines.slice(-LOG_LINES)) out.push(`${pad}    ${l}`);
      }
      // A job's steps only matter when it failed or is running; a stage's jobs always show.
      const open = r.type !== 'Job' || r.result === 'failed' || r.state === 'inProgress' || r.result === 'partiallySucceeded' || r.result === 'succeededWithIssues';
      if (open) walk(r.id, depth + 1);
    }
  }
  walk(null, 0);
  return out;
}

/** The viewer's title and text for `run` of pipeline `row`, from service.runDetails(). */
export function runText(row, run, details, now = Date.now()) {
  const st = runState(run);
  const title = `${row.definition.name} ${run.buildNumber} · ${st.label}`;
  const who = run.requestedFor?.displayName;
  const out = [
    title,
    [`${row.projectName}${row.repoName ? ` / ${row.repoName}` : ''}`, branch(run.sourceBranch), who, run.reason, ago(run.finishedAt || run.startedAt || run.queuedAt, now), took(run.startedAt, run.finishedAt)].filter(Boolean).join(' · '),
  ];
  const t = details.tests;
  if (t?.total) out.push('', `Tests  ${t.total} · ${t.passed} passed${t.failed ? ` · ${t.failed} failed` : ''}${t.other ? ` · ${t.other} other` : ''}`);
  for (const a of details.approvals ?? []) out.push('', `‖ Waits for approval at ${a.stage}${a.instructions ? `: "${a.instructions}"` : ''} (a in the Inbox approves it)`);
  out.push('');
  if (details.timeline?.length) out.push(...tree(details.timeline, details.logs));
  else out.push(run.status === 'notStarted' ? 'Queued: nothing has run yet.' : 'Azure DevOps has no stages or steps for this run.');
  if (details.changes?.length) {
    out.push('', 'Commits in this run');
    for (const c of details.changes.slice(0, 20)) out.push(`  ${String(c.id).slice(0, 7)} ${String(c.message ?? '').split('\n')[0]}${c.author ? ` · ${c.author}` : ''}${c.at ? ` · ${ago(c.at, now)}` : ''}`);
  }
  if (run.webUrl) out.push('', run.webUrl);
  return { title, text: out.join('\n') };
}
