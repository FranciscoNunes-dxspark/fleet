import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitRefs, mergeCommits, waitingChanges } from '../server/domain/commits.js';

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

test('waiting changes: a PR counts once, timed from its merge', () => {
  const c = (id, authored, committed) => ({ id, author: { date: authored }, committedAt: committed });
  const pr = { id: 7, commits: [c('m', '2026-10-15T10:00:00Z', '2026-10-15T10:00:00Z'), c('a', '2026-09-01T00:00:00Z'), c('b', '2026-09-02T00:00:00Z')] };
  // A commit written earlier but rebased onto the branch later counts from when it landed.
  const direct = [c('d', '2026-10-01T00:00:00Z', '2026-10-16T08:00:00Z')];
  assert.deepEqual(waitingChanges({ pullRequests: [pr], directCommits: direct }), { waiting: 2, oldestAt: '2026-10-15T10:00:00.000Z' });
  assert.deepEqual(waitingChanges({}), { waiting: 0, oldestAt: null });
});
