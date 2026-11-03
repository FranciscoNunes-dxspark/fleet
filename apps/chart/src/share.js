// The plan as Markdown, for a pull request's comment or a ticket. Pure.
import { diffLines } from './diff.js';
import { summarize, summaryLine } from './plan.js';
import { ACTION_MARK, ACTION_WORD, changeRows } from './rows.js';
import { HOURS_A_MONTH, costWords, totalWords } from './costs.js';
import { countFindings, findingsLine, sortFindings } from '@fleet/kit/findings.js';

/** `plan` (plan.js's) as Markdown: what it does in a line, the destroyed and replaced first, each change's attributes folded away. */
export function markdownReport(plan, { label = 'the plan', when = new Date(), costs = null } = {}) {
  const rows = changeRows(plan.changes);
  const s = summarize(plan.changes);
  const lines = [`# ${plan.tool === 'terraform' ? 'Terraform plan' : 'What-if'}: ${label}`, '', `${summaryLine(s) || 'No changes.'} (${when.toISOString().slice(0, 16).replace('T', ' ')} UTC${plan.version ? `, Terraform ${plan.version}` : ''})`, ''];
  // Only costs that were worked out: still pricing, or failed, the report says nothing about them.
  const priced = costs?.byAddress ? costs : null;
  if (priced && totalWords(priced)) lines.push(`**Monthly cost: ${totalWords(priced)}**, from Azure's retail prices in ${priced.currency} (pay-as-you-go, ${HOURS_A_MONTH} hours a month).`, '');
  const lost = rows.filter((c) => c.action === 'delete' || c.action === 'replace');
  if (lost.length) lines.push(`> **${lost.length} resource${lost.length === 1 ? ' is' : 's are'} destroyed:** ${lost.map((c) => `\`${c.address}\``).join(', ')}`, '');
  if (rows.length) {
    lines.push(`| | Resource | Action | Why |${priced ? ' Cost a month |' : ''}`, `| --- | --- | --- | --- |${priced ? ' --- |' : ''}`);
    for (const c of rows) lines.push(`| \`${ACTION_MARK[c.action]}\` | \`${c.address}\` | ${ACTION_WORD[c.action]} | ${c.reason ?? ''} |${priced ? ` ${costWords(priced.byAddress[c.address], priced.currency).replace(/\/month$/, '')} |` : ''}`);
    lines.push('');
    for (const c of rows.filter((x) => x.diff.length)) {
      lines.push(`<details><summary><code>${ACTION_MARK[c.action]} ${c.address}</code></summary>`, '', '```diff', ...diffLines(c.diff).map((l) => l.replace(/^~/, '!')), '```', '</details>', '');
    }
  }
  // What it would deploy that security.js's judges found insecure: in the pull request, before the apply.
  const security = sortFindings(plan.security ?? []);
  if (security.length) {
    lines.push('## Security', '', `${findingsLine(countFindings(security))} in what the plan would deploy.`, '', '| Severity | Resource | Finding | Fix |', '| --- | --- | --- | --- |');
    for (const f of security) lines.push(`| ${f.severity} | \`${f.resource ?? f.where}\` | ${f.title}${f.excerpt ? ` (\`${f.excerpt.replace(/\|/g, '\\|')}\`)` : ''} | ${(f.fix ?? '').replace(/\|/g, '\\|')} |`);
    lines.push('');
  }
  if (plan.drift.length) {
    lines.push('## Changed outside Terraform', '');
    for (const c of plan.drift) lines.push(`- \`${c.address}\`: ${diffLines(c.diff).map((l) => l.slice(2)).join('; ')}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
