// The plan as Markdown, for a pull request's comment or a ticket. Pure.
import { diffLines } from './diff.js';
import { summarize, summaryLine } from './plan.js';
import { ACTION_MARK, ACTION_WORD, changeRows } from './rows.js';

/** `plan` (plan.js's) as Markdown: what it does in a line, the destroyed and replaced first, each change's attributes folded away. */
export function markdownReport(plan, { label = 'the plan', when = new Date() } = {}) {
  const rows = changeRows(plan.changes);
  const s = summarize(plan.changes);
  const lines = [`# ${plan.tool === 'terraform' ? 'Terraform plan' : 'What-if'}: ${label}`, '', `${summaryLine(s) || 'No changes.'} (${when.toISOString().slice(0, 16).replace('T', ' ')} UTC${plan.version ? `, Terraform ${plan.version}` : ''})`, ''];
  const lost = rows.filter((c) => c.action === 'delete' || c.action === 'replace');
  if (lost.length) lines.push(`> **${lost.length} resource${lost.length === 1 ? ' is' : 's are'} destroyed:** ${lost.map((c) => `\`${c.address}\``).join(', ')}`, '');
  if (rows.length) {
    lines.push('| | Resource | Action | Why |', '| --- | --- | --- | --- |');
    for (const c of rows) lines.push(`| \`${ACTION_MARK[c.action]}\` | \`${c.address}\` | ${ACTION_WORD[c.action]} | ${c.reason ?? ''} |`);
    lines.push('');
    for (const c of rows.filter((x) => x.diff.length)) {
      lines.push(`<details><summary><code>${ACTION_MARK[c.action]} ${c.address}</code></summary>`, '', '```diff', ...diffLines(c.diff).map((l) => l.replace(/^~/, '!')), '```', '</details>', '');
    }
  }
  if (plan.drift.length) {
    lines.push('## Changed outside Terraform', '');
    for (const c of plan.drift) lines.push(`- \`${c.address}\`: ${diffLines(c.diff).map((l) => l.slice(2)).join('; ')}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
