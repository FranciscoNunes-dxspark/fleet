import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stackBases, stackRows } from '../client/src/prstack.js';

const pr = (id, source, target, repoId = 'r1') => ({ key: `p/${repoId}/${id}`, id, projectId: 'p', repoId, sourceBranch: source, targetBranch: target });

test('a pull request into another one\'s source branch nests under it, at any depth', () => {
  const ab = pr(1, 'A', 'B');
  const cb = pr(2, 'C', 'B');
  const xa = pr(3, 'X', 'A');
  const yx = pr(4, 'Y', 'X');
  const rows = stackRows([cb, yx, xa, ab]);
  assert.deepEqual(rows.map((r) => [r.pr.id, r.depth, r.on?.id ?? null, r.stacked]), [
    [2, 0, null, 0],
    [1, 0, null, 1],
    [3, 1, 1, 1],
    [4, 2, 3, 0],
  ]);
});

test('a base filtered out leaves its stacked one at the top, still saying what it builds on', () => {
  const ab = pr(1, 'A', 'B');
  const xa = pr(3, 'X', 'A');
  assert.deepEqual(stackRows([xa], [ab, xa]).map((r) => [r.pr.id, r.depth, r.on?.id]), [[3, 0, 1]]);
});

test('other repositories, loops and shared source branches', () => {
  // The same branch names in another repository are another story.
  assert.equal(stackBases([pr(1, 'A', 'B'), pr(2, 'X', 'A', 'r2')]).size, 0);
  // A → B and B → A build on each other: neither nests, and neither goes missing.
  const loop = stackRows([pr(1, 'A', 'B'), pr(2, 'B', 'A')]);
  assert.deepEqual(loop.map((r) => [r.pr.id, r.depth]), [[1, 0], [2, 0]]);
  // Two pull requests from A: what goes into A builds on the older one.
  assert.equal(stackBases([pr(5, 'A', 'C'), pr(1, 'A', 'B'), pr(3, 'X', 'A')]).get('p/r1/3').id, 1);
});
