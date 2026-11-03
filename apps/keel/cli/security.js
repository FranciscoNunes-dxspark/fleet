// /security in the terminal app: the security review of Azure DevOps projects
// (server/domain/devopssecurity.js) as a list, worst first, and one finding in full. Pure, so the
// tests can check it; ui/SecurityView.jsx draws it.
import { findingsLine } from '@fleet/kit/findings.js';

/** How a severity reads in the list, and its colour's name in the theme. */
export const SEVERITY_TAG = {
  critical: { label: 'CRIT', color: 'del' },
  high: { label: 'HIGH', color: 'del' },
  medium: { label: 'MED', color: 'warn' },
  low: { label: 'LOW', color: 'dim' },
  unknown: { label: '?', color: 'dim' },
};

/** What was reviewed: the project's name, or how many. */
export const reviewScope = (review) => (review.projects.length === 1 ? review.projects[0].projectName : `${review.projects.length} projects`);

/** What was reviewed and how much it found, for the activity line. */
export const reviewSummary = (review) => `${reviewScope(review)}: ${findingsLine(review.counts) || 'nothing found'}`;

/** Whether a finding matches /find text (its title, where, rule or severity). */
export const findingMatches = (f, text) => {
  const q = String(text ?? '').trim().toLowerCase();
  return !q || [f.title, f.where, f.rule, f.severity].some((s) => String(s ?? '').toLowerCase().includes(q));
};

/** One finding in full: what, where, why, how to fix it, what was seen (redacted already) and its link. */
export function findingDetail(f) {
  const out = [`${SEVERITY_TAG[f.severity]?.label ?? '?'}  ${f.title}`, '', `Where: ${f.where}${f.org ? ` (${f.org})` : ''}`];
  if (f.excerpt) out.push(`Seen:  ${f.excerpt}`);
  if (f.why) out.push('', `Why:   ${f.why}`);
  if (f.fix) out.push('', `Fix:   ${f.fix}`);
  out.push('', `Rule:  ${f.rule}`);
  if (f.webUrl) out.push(`Open:  ${f.webUrl} (o)`);
  return out.join('\n');
}

/** What couldn't be read, a line each, for the bottom of the detail pane and the list's empty state. */
export const gapNotes = (review) => (review?.gaps ?? []).map((g) => `${g.projectName ? `${g.projectName}: ` : ''}couldn't read ${g.what} (${String(g.error).split('\n')[0]})`);
