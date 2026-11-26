// Stacked pull requests: one whose target branch is another active pull request's source branch,
// in the same repository, builds on it (X → A on A → B), so the list shows it nested under that
// one. Pure, so the list, the panel and the tests share one rule.

const repoOf = (p) => `${p.org || ''}\u0000${p.projectId}\u0000${p.repoId}`;

/**
 * Each pull request's base: the active one it builds on, by key (Map key → pr). Where two share
 * the source branch it builds on, the older one; a loop of branches (A → B and B → A) nests neither.
 */
export function stackBases(prs) {
  const bySource = new Map();
  for (const p of [...prs].sort((a, b) => a.id - b.id)) {
    const k = `${repoOf(p)}\u0000${p.sourceBranch}`;
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(p);
  }
  const base = new Map();
  for (const p of prs) {
    const under = (bySource.get(`${repoOf(p)}\u0000${p.targetBranch}`) || []).find((q) => q.key !== p.key);
    if (under) base.set(p.key, under);
  }
  // Found first and cut after, so every pull request in a loop is left at the top.
  const inLoop = prs.filter((p) => {
    const seen = new Set();
    for (let q = base.get(p.key); q && !seen.has(q.key); q = base.get(q.key)) {
      if (q.key === p.key) return true;
      seen.add(q.key);
    }
    return false;
  });
  for (const p of inLoop) base.delete(p.key);
  return base;
}

/**
 * The rows in the order given, each followed by the pull requests built on it, nested:
 * [{ pr, depth, on, stacked }]. `on` is the one it builds on (also when that one is filtered out,
 * so the row can still say so), `stacked` how many active ones build on it directly.
 */
export function stackRows(rows, prs = rows) {
  const base = stackBases(prs);
  const shown = new Set(rows.map((p) => p.key));
  const kids = new Map();
  const roots = [];
  for (const p of rows) {
    const on = base.get(p.key);
    if (on && shown.has(on.key)) {
      if (!kids.has(on.key)) kids.set(on.key, []);
      kids.get(on.key).push(p);
    } else roots.push(p);
  }
  const stacked = new Map();
  for (const on of base.values()) stacked.set(on.key, (stacked.get(on.key) || 0) + 1);
  const out = [];
  const visit = (p, depth) => {
    out.push({ pr: p, depth, on: base.get(p.key) || null, stacked: stacked.get(p.key) || 0 });
    for (const k of kids.get(p.key) || []) visit(k, depth + 1);
  };
  for (const p of roots) visit(p, 0);
  return out;
}
