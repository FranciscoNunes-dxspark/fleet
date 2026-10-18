// A bug report for a production problem, written from what Keel already knows:
// the monitor's issue, its top failing operations, and (for a regression after
// a deploy) what that deploy shipped. Opens the New work item panel filled in.
import { dateTime } from './format.js';
import { t, tx } from './i18n.js';

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * monitor: a Production monitor (with ai, issues, link); issue: one of its
 * issues; changes: what the deploy shipped (GET /deploys/:project/changes), or null.
 */
export function regressionBug(monitor, issue, changes = null) {
  const deploy = changes?.deploy || issue.deploy || null;
  const regression = issue.code === 'deploy-regression';
  const title = regression && deploy
    ? t('{name}: failures up since {label}', { name: monitor.name, label: deploy.label })
    : issue.code === 'down' ? t('{name} is down', { name: monitor.name }) : t('{name}: {problem}', { name: monitor.name, problem: tx(issue.text) });

  const lines = [`**${tx(issue.text)}**`, ''];
  lines.push(`- ${t('Monitor')}: ${monitor.url ? `[${monitor.name}](${monitor.url})` : monitor.name}`);
  if (monitor.ai) lines.push(`- ${t('Last hour')}: ${t('{failed} of {total} requests failed', { failed: monitor.ai.failed, total: monitor.ai.total })}, ${t('{n} exceptions', { n: monitor.ai.exceptions })}`);
  if (monitor.last && !monitor.last.ok) lines.push(`- ${t('Last check')}: ${tx(monitor.last.error || '') || monitor.last.status} (${dateTime(monitor.last.at)})`);
  if (deploy) {
    const link = deploy.webUrl ? `[${deploy.label}](${deploy.webUrl})` : deploy.label;
    lines.push(`- ${t('Deploy')}: ${link}, ${dateTime(deploy.at)}${deploy.by ? ` · ${deploy.by}` : ''}${changes?.previous ? ` (${t('after {label}', { label: changes.previous.label })})` : ''}`);
  }

  const failing = monitor.ai?.topFailures || [];
  if (failing.length) {
    lines.push('', `### ${t('Top failing operations, 1h')}`, '', `| ${t('Operation')} | HTTP | ${t('Count')} |`, '|---|---|---|');
    for (const f of failing) lines.push(`| ${cell(f.name)} | ${cell(f.code)} | ${f.count} |`);
  }

  if (changes && regression) {
    lines.push('', `### ${t('What {label} shipped', { label: deploy.label })}`, '');
    for (const p of changes.pullRequests || []) lines.push(`- ${p.webUrl ? `[!${p.id}](${p.webUrl})` : `!${p.id}`} ${p.title}${p.author ? ` (${p.author})` : ''}`);
    for (const c of changes.directCommits || []) lines.push(`- ${c.webUrl ? `[${c.id.slice(0, 8)}](${c.webUrl})` : c.id.slice(0, 8)} ${c.subject}${c.author?.name ? ` (${c.author.name})` : ''}`);
    if (changes.workItems?.length) lines.push('', `${t('Work items')}: ${changes.workItems.map((w) => `#${w.id} ${w.title}`).join('; ')}`);
    if (!changes.pullRequests?.length && !changes.directCommits?.length) lines.push(t('No code changes were found for this deploy.'));
    if (changes.authors?.length) lines.push('', `${t('People')}: ${changes.authors.join(', ')}`);
  }
  lines.push('', `_${t('Filed from Keel.')}_`);

  return {
    type: 'newworkitem',
    kicker: monitor.name,
    projectId: monitor.link?.projectId,
    workItemType: 'Bug',
    title: title.slice(0, 255),
    description: lines.join('\n').slice(0, 19_000),
    priority: issue.severity === 'high' ? 1 : 2,
    tags: ['production', ...(regression ? ['regression'] : [])],
    relatedIds: (changes?.workItems || []).map((w) => w.id).slice(0, 20),
  };
}
