// An incident (server/domain/incident.js, the route /production/incident/:id) as Markdown for a
// post-incident write-up: what happened and when, the deploys just before, what the latest shipped
// with each pull request's risk, the timeline and the release to go back to. Pure, so it loads in
// tests: `translate` is the web app's t, `serverText` its tx for the server's own
// sentences (the monitor's issues) and `when` formats a time.

const fill = (text, params = {}) => text.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ''));

/** The incident as Markdown, in the language `translate` speaks. */
export function incidentMarkdown(inc, { translate = fill, serverText = (text) => text, when = (iso) => iso } = {}) {
  const tr = translate;
  const m = inc.monitor;
  const lines = [
    `# ${tr('Incident: {monitor}', { monitor: m.name })}`,
    '',
    `- ${tr('State')}: ${tr(m.state === 'down' ? 'Down' : 'Degraded')}`,
    `- ${tr('Since')}: ${when(m.start)}`,
  ];
  if (inc.environment) lines.push(`- ${tr('Environment')}: ${inc.environment.name}`);
  for (const i of m.issues || []) if (i.severity !== 'low') lines.push(`- ${serverText(i.text)}`);
  lines.push('');

  if (inc.unlinked) lines.push(tr("This monitor isn't linked to what deploys it, so Keel can't tell which deploy came before."), '');
  if (inc.suspects?.length) {
    lines.push(`## ${tr('Deploys just before')}`, '');
    for (const d of inc.suspects) {
      const label = d.webUrl ? `[${d.label}](${d.webUrl})` : d.label;
      const approved = (d.approvals || []).filter((a) => a.status === 'approved').map((a) => a.by).filter(Boolean);
      lines.push(`- ${label} · ${when(d.at)}${d.by ? ` · ${d.by}` : ''}${approved.length ? ` · ${tr('approved by {names}', { names: approved.join(', ') })}` : ''}`);
    }
    lines.push('');
  } else if (!inc.unlinked) {
    lines.push(tr('No deploy before it in the last 90 days.'), '');
  }

  const shipped = inc.shipped;
  if (shipped?.pullRequests?.length) {
    lines.push(`## ${tr('What {label} shipped', { label: inc.suspects[0].label })}`, '');
    for (const p of shipped.pullRequests) {
      const id = p.webUrl ? `[!${p.id}](${p.webUrl})` : `!${p.id}`;
      const risk = p.risk ? ` · ${tr('risk {score}', { score: p.risk.score })}` : '';
      lines.push(`- ${id} ${p.title}${p.author ? ` _(${p.author})_` : ''}${risk}`);
      for (const r of (p.risk?.reasons || []).filter((x) => x.points > 0).slice(0, 3)) lines.push(`  - ${tr(r.text, r.params)}`);
    }
    lines.push('');
  }
  if (shipped?.workItems?.length) {
    lines.push(`## ${tr('Work items')}`, '', ...shipped.workItems.map((w) => `- ${w.title} (AB#${w.id})`), '');
  }

  if (inc.timeline?.length) {
    lines.push(`## ${tr('Timeline')}`, '', ...inc.timeline.map((e) => `- ${when(e.at)}: ${tr(e.text, e.params)}`), '');
  }
  if (inc.lastGood) {
    lines.push(`## ${tr('Last good release')}`, '', `- ${inc.lastGood.webUrl ? `[${inc.lastGood.label}](${inc.lastGood.webUrl})` : inc.lastGood.label} · ${when(inc.lastGood.at)}`, '');
  }
  lines.push(`## ${tr('Cause')}`, '', `_${tr('To be filled in.')}_`, '', `## ${tr('Follow-ups')}`, '', `_${tr('To be filled in.')}_`);
  return `${lines.join('\n').trim()}\n`;
}
