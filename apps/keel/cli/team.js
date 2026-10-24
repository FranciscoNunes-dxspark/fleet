// The team in the terminal (ui/TeamView.jsx): who carries what, as the web app's Team page reads it.
// Pure, so the tests can check it. The data is service.team(), with the open work items and pull
// requests the other tabs already read.
import { prState, wiState } from './format.js';
import { theme } from './theme.js';
import { relTime } from './text.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const hours = (h) => (h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`);

const matches = (r, text) => {
  const q = text.trim().toLowerCase();
  return !q || [r.person.displayName, r.person.uniqueName, ...(r.person.teams ?? []).map((t) => t.teamName), ...(r.flags ?? [])].some((s) => String(s ?? '').toLowerCase().includes(q));
};

/** People with a flag first (too much in progress, stale PRs), then by how much they have open. Hidden people stay out. */
export function teamRows(data, filter = '') {
  const hidden = new Set(data?.hidden ?? []);
  return (data?.rows ?? [])
    .filter((r) => !hidden.has(r.person.id) && matches(r, filter))
    .sort((a, b) => Number(!!b.overloaded) - Number(!!a.overloaded) || (b.flags?.length ?? 0) - (a.flags?.length ?? 0) || b.openItems - a.openItems || a.person.displayName.localeCompare(b.person.displayName));
}

/** One person's numbers in a row: "6 in progress · 8 in the sprint, 14 pts · 5 reviews · 4 PRs". */
export function teamBrief(r) {
  return [
    `${r.inProgress} in progress`,
    r.sprintItems ? `${r.sprintItems} in the sprint${r.sprintPoints ? `, ${r.sprintPoints} pts` : ''}` : '',
    r.reviewsPending ? plural(r.reviewsPending, 'review') : '',
    r.prsAuthored ? plural(r.prsAuthored, 'PR') : '',
  ].filter(Boolean).join(' · ');
}

/** The pane beside the list: their teams, numbers, flags, then their open work items and pull requests. */
export function teamDetail(r, { workItems = [], prs = [], now = Date.now() } = {}) {
  const id = r.person.id;
  const mine = (workItems ?? []).filter((w) => w.assignedTo?.id === id);
  const authored = (prs ?? []).filter((p) => p.author?.id === id);
  const reviewing = (prs ?? []).filter((p) => p.author?.id !== id && (p.reviewers ?? []).some((v) => v.id === id && !v.vote && !v.hasDeclined));
  const lines = [
    [{ text: r.person.displayName, bold: true }],
    [{ text: (r.person.teams ?? []).map((t) => t.teamName).join(', ') || r.person.uniqueName || '', color: theme.dim }],
    '',
  ];
  for (const f of r.flags ?? []) lines.push([{ text: '⚠ ', color: theme.warn }, { text: f, color: theme.warn }]);
  if (r.flags?.length) lines.push('');
  lines.push(
    [{ text: 'Work  ', bold: true }, { text: `${r.openItems} open: ${r.inProgress} in progress, ${r.proposed} new, ${r.resolved} resolved${r.bugs ? ` · ${plural(r.bugs, 'bug')}` : ''}${r.blocked ? ` · ${r.blocked} blocked` : ''}` }],
    [{ text: 'Sprint  ', bold: true }, { text: `${plural(r.sprintItems, 'item')}${r.sprintPoints ? `, ${r.sprintPoints} points` : ''}${r.remainingWork ? `, ${r.remainingWork}h of work left` : ''}` }],
    [{ text: 'Code  ', bold: true }, { text: `${plural(r.prsAuthored, 'pull request')}${r.draftPrs ? ` (${r.draftPrs} draft)` : ''}${r.oldestPrHours ? `, the oldest open ${hours(r.oldestPrHours)}` : ''} · ${plural(r.reviewsPending, 'review')} waiting on them` }],
    '',
    [{ text: 'Their work items', bold: true }, { text: '  ↵ shows them in Work items', color: theme.dim }],
  );
  if (!mine.length) lines.push([{ text: '  None open', color: theme.dim }]);
  for (const w of mine.slice(0, 12)) {
    const st = wiState(w);
    lines.push([{ text: `  ${st.icon} `, color: st.color }, { text: `${w.id} `, color: theme.dim }, { text: w.title }, { text: `  ${w.state} · ${relTime(Date.parse(w.changedAt), now)}`, color: theme.dim }]);
  }
  if (mine.length > 12) lines.push([{ text: `  … and ${mine.length - 12} more`, color: theme.dim }]);
  lines.push('', [{ text: 'Their pull requests', bold: true }, { text: '  p shows them in Pull requests', color: theme.dim }]);
  if (!authored.length) lines.push([{ text: '  None open', color: theme.dim }]);
  for (const p of authored.slice(0, 8)) {
    const st = prState(p);
    lines.push([{ text: `  ${st.icon} `, color: st.color }, { text: `!${p.id} `, color: theme.dim }, { text: p.title }, { text: `  ${st.label} · ${hours(p.ageHours ?? 0)}`, color: theme.dim }]);
  }
  if (reviewing.length) {
    lines.push('', [{ text: 'Waiting on their review', bold: true }]);
    for (const p of reviewing.slice(0, 8)) lines.push([{ text: '  · ', color: theme.dim }, { text: `!${p.id} `, color: theme.dim }, { text: p.title }, { text: `  by ${p.author?.displayName ?? 'someone'} · ${hours(p.ageHours ?? 0)}`, color: theme.dim }]);
  }
  return lines;
}
