import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFlakyTests, shortTestName } from '../server/domain/tests.js';

const H = 3_600_000;
const NOW = Date.parse('2026-10-17T12:00:00Z');
const pipeline = { key: 'p:1', projectId: 'p', projectName: 'Shop', definition: { id: 1, name: 'shop-CI' }, branch: 'main' };
let n = 0;
const run = (result, commit, extra = {}) => {
  n += 1;
  return { id: n, projectId: 'p', definition: { id: 1 }, status: 'completed', result, reason: 'individualCI', sourceBranch: 'main', commit, buildNumber: `b${n}`, finishedAt: new Date(NOW - (100 - n) * H).toISOString(), ...extra };
};

test('flaky tests: re-run on the same commit, or failing on and off; broken ones are not flaky', () => {
  n = 0;
  // Oldest first: A fails then passes on the same commit; B fails, passes, fails; C fails from some point on.
  const builds = [
    run('failed', 'c1'), // 1: A
    run('succeeded', 'c1'), // 2: same commit, green
    run('failed', 'c2'), // 3: B
    run('succeeded', 'c3'), // 4
    run('failed', 'c4'), // 5: B, C
    run('failed', 'c5'), // 6: C
    run('failed', 'c6', { reason: 'pullRequest', sourceBranch: 'refs/pull/9/merge' }), // a PR run doesn't count
    run('failed', 'c7'), // 8: B, C
  ];
  const fail = (...names) => ({ failed: names.map((name) => ({ name: `Shop.Tests.${name}`, title: name, error: `${name} broke` })) });
  const failedTests = new Map([[1, fail('A')], [3, fail('B')], [5, fail('B', 'C')], [6, fail('C')], [8, fail('C', 'B')]]);
  const r = findFlakyTests({ pipelines: [pipeline], builds, failedTests });
  // B flipped five times; A once, but on a same-commit re-run (which counts double).
  assert.deepEqual(r.tests.map((x) => x.shortName), ['Tests.B', 'Tests.A']);
  const [b, a] = r.tests;
  assert.deepEqual([a.sameCommit, a.fails, a.runs, a.flips], [true, 1, 7, 1]);
  assert.deepEqual([b.sameCommit, b.fails, b.flips, b.failingNow, b.lastFailedRun.id], [false, 3, 5, true, 8]);
  assert.equal(b.error, 'B broke');
  assert.deepEqual(r.analyzed, { pipelines: 1, runs: 7, unreadable: 0 });

  // A red run whose tests can't be read is unknown, not a pass.
  const r2 = findFlakyTests({ pipelines: [pipeline], builds, failedTests: new Map([[3, fail('B')], [5, fail('B')]]) });
  assert.equal(r2.tests.find((x) => x.shortName === 'Tests.B').runs, 4);
  assert.equal(r2.analyzed.unreadable, 3);
  assert.equal(shortTestName('A.B.C.D'), 'C.D');
});
