import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitRefs, mergeCommits } from '../server/domain/commits.js';

test('commits: work items and pull requests from messages, merged newest first', () => {
  assert.deepEqual(commitRefs('Fix VAT rounding (AB#4107) and #12, again #4107'), { workItemIds: [4107, 12], prId: null });
  assert.deepEqual(commitRefs('Merged PR 815: Add PDF invoices\n\nRelated work items: #4101'), { workItemIds: [4101], prId: 815 });
  assert.deepEqual(commitRefs('Bump to v2 #1'), { workItemIds: [], prId: null });

  const repo = (id) => ({ id, name: id, projectId: 'p', projectName: 'P' });
  const c = (id, date, message = 'x') => ({ id, message, author: { name: 'A', email: 'a@x', date } });
  const merged = mergeCommits([
    { repo: repo('web'), commits: [c('a', '2026-10-03T00:00:00Z', 'Subject line\n\nBody'), c('b', '2026-10-01T00:00:00Z')] },
    { repo: repo('api'), commits: [c('c', '2026-10-02T00:00:00Z')] },
  ]);
  assert.deepEqual(merged.map((x) => [x.id, x.repoName]), [['a', 'web'], ['c', 'api'], ['b', 'web']]);
  assert.equal(merged[0].subject, 'Subject line');
  assert.equal(mergeCommits([{ repo: repo('web'), commits: [c('a', '2026-10-03'), c('b', '2026-10-02')] }], { limit: 1 }).length, 1);
});
