const isBug = (w) => /bug|defect|issue/i.test(w.type);
const isTask = (w) => /task/i.test(w.type);

/**
 * Release notes from merged PRs in a date range, grouped by repo, with the
 * work items each PR delivered.
 */
export function buildChangelog({ prs, workItemsByPr, from, to, title }) {
  const groups = new Map();
  const delivered = new Map();
  for (const pr of [...prs].sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt))) {
    const key = `${pr.projectName} / ${pr.repoName}`;
    if (!groups.has(key)) groups.set(key, { key, projectName: pr.projectName, repoName: pr.repoName, prs: [] });
    const wis = (workItemsByPr.get(pr.key) || []).map(({ id, type, title: t, state, webUrl }) => ({ id, type, title: t, state, webUrl }));
    groups.get(key).prs.push({
      id: pr.id, title: pr.title, author: pr.author?.displayName, closedAt: pr.closedAt, webUrl: pr.webUrl,
      targetBranch: pr.targetBranch, workItems: wis,
    });
    for (const w of wis) delivered.set(w.id, w);
  }

  const items = [...delivered.values()].filter((w) => !isTask(w));
  const features = items.filter((w) => !isBug(w));
  const fixes = items.filter(isBug);
  const sorted = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));

  const lines = [`# ${title || 'Release notes'}`, '', `_${from} → ${to} · ${prs.length} pull request${prs.length === 1 ? '' : 's'} merged_`, ''];
  if (features.length) {
    lines.push('## Features & improvements', '', ...features.map((w) => `- ${w.title} (AB#${w.id})`), '');
  }
  if (fixes.length) {
    lines.push('## Bug fixes', '', ...fixes.map((w) => `- ${w.title} (AB#${w.id})`), '');
  }
  lines.push('## Pull requests by repository', '');
  for (const g of sorted) {
    lines.push(`### ${g.key}`, '');
    for (const pr of g.prs) {
      const refs = pr.workItems.length ? ` — ${pr.workItems.map((w) => `AB#${w.id}`).join(', ')}` : '';
      lines.push(`- [!${pr.id}](${pr.webUrl}) ${pr.title} _(${pr.author})_${refs}`);
    }
    lines.push('');
  }

  return { groups: sorted, features, fixes, markdown: lines.join('\n').trim() + '\n' };
}
