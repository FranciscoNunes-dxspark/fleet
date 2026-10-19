import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSchedules, notReady } from '../server/schedules.js';
import { diffSnapshots } from '../server/domain/changes.js';

const MIN = 60_000;
const ready = { id: 7, projectId: 'p1', repoId: 'r1', title: 'Add refunds', status: 'active', isDraft: false, mergeStatus: 'succeeded', reviewState: 'approved', policies: [] };

test('ready to complete: active, not a draft, no conflicts, approved, required checks passed', () => {
  assert.equal(notReady(ready), null);
  assert.equal(notReady({ ...ready, status: 'completed' }), 'It was already completed');
  assert.equal(notReady({ ...ready, isDraft: true }), 'It is still a draft');
  assert.equal(notReady({ ...ready, mergeStatus: 'conflicts' }), 'It has merge conflicts');
  assert.equal(notReady({ ...ready, reviewState: 'in-review' }), "It isn't approved yet");
  assert.equal(notReady({ ...ready, reviewState: 'rejected' }), 'A reviewer rejected it');
  const policies = [{ name: 'Build', isBlocking: true, status: 'running' }, { name: 'Comments', isBlocking: false, status: 'rejected' }, { name: 'Lint', isBlocking: true, status: 'notApplicable' }];
  assert.equal(notReady({ ...ready, policies }), "Required checks haven't passed: Build");
});

test('scheduled completion: checked when set, done at its time as its owner, or skipped saying why', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-schedules-'));
  let pr = { ...ready };
  const done = [];
  const service = {
    invalidate: () => {},
    pullRequest: async () => pr,
    prAction: async (projectId, repoId, id, action) => done.push([id, action]),
  };
  const asked = [];
  const schedules = createSchedules({ dataDir: dir, mock: false, every: 3_600_000, resolveService: (ownerId) => (asked.push(ownerId), ownerId === 'gone' ? null : service) });
  try {
    const now = Date.now();
    const at = new Date(now + 60 * MIN).toISOString();
    assert.throws(() => schedules.add({ pr, at: new Date(now - MIN).toISOString() }, now), /at least a minute/);
    assert.throws(() => schedules.add({ pr, at: new Date(now + 31 * 24 * 60 * MIN).toISOString() }, now), /30 days/);
    assert.throws(() => schedules.add({ pr: { ...pr, isDraft: true }, at }, now), /draft/);

    const owner = { id: 'u1', name: 'Ana' };
    schedules.add({ pr, at, options: { mergeStrategy: 'squash', deleteSourceBranch: true }, owner }, now);
    // Scheduling again replaces it rather than completing twice.
    const s = schedules.add({ pr, at, options: { mergeStrategy: 'noFastForward', bypassPolicy: true }, owner }, now);
    assert.equal(schedules.forOwner('u1').length, 1);
    assert.equal(schedules.upcoming().get('p1/r1/7'), at);
    assert.equal(schedules.forPr('p1', 'r1', 7).status, 'scheduled');
    assert.throws(() => schedules.cancel(s.id, { ownerId: 'someone-else' }), /Only the person/);

    await schedules.tick(now); // not due yet
    assert.equal(done.length, 0);
    await schedules.tick(now + 61 * MIN);
    assert.deepEqual(asked, ['u1'], 'acts as the person who scheduled it');
    assert.equal(done.length, 1);
    assert.equal(done[0][1].type, 'complete');
    assert.equal(done[0][1].mergeStrategy, 'noFastForward');
    assert.equal(done[0][1].bypassPolicy, undefined, 'policies are never overridden');
    assert.equal(schedules.forPr('p1', 'r1', 7).status, 'done');

    // Not approved by then: skipped, saying why.
    pr = { ...ready, id: 8, reviewState: 'in-review' };
    schedules.add({ pr, at, owner }, now);
    await schedules.tick(now + 61 * MIN);
    assert.deepEqual([schedules.forPr('p1', 'r1', 8).status, schedules.forPr('p1', 'r1', 8).reason], ['skipped', "It isn't approved yet"]);

    // The server was down at the time: not done hours late.
    pr = { ...ready, id: 9 };
    schedules.add({ pr, at, owner }, now);
    await schedules.tick(now + 3 * 60 * MIN);
    assert.equal(schedules.forPr('p1', 'r1', 9).reason, "Keel wasn't running at the time");

    // Its owner has no working token: failed.
    pr = { ...ready, id: 10 };
    schedules.add({ pr, at, owner: { id: 'gone', name: 'Old' } }, now);
    await schedules.tick(now + 61 * MIN);
    assert.equal(schedules.forPr('p1', 'r1', 10).status, 'failed');
    assert.equal(done.length, 1, 'only the first one was completed');

    // Canceled by its owner: gone.
    pr = { ...ready, id: 11 };
    const c = schedules.add({ pr, at, owner }, now);
    schedules.cancel(c.id, { ownerId: 'u1' });
    assert.equal(schedules.forPr('p1', 'r1', 11), null);
  } finally {
    schedules.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('notifications: a scheduled completion that ran, done or not', () => {
  const base = { attention: [], myPrs: [], runs: [] };
  const s = { id: 's1', prId: 7, projectId: 'p1', repoId: 'r1', title: 'Add refunds', status: 'scheduled' };
  const prev = { ...base, schedules: [s, { ...s, id: 's2', prId: 8 }] };
  const next = { ...base, schedules: [{ ...s, status: 'done' }, { ...s, id: 's2', prId: 8, status: 'skipped', reason: 'It has merge conflicts' }] };
  const notes = diffSnapshots(prev, next);
  assert.deepEqual(notes.map((n) => [n.title, n.severity]), [
    ['Pull request !7 completed as scheduled', 'medium'],
    ["Pull request !8 wasn't completed as scheduled", 'high'],
  ]);
  assert.equal(notes[1].body, 'Add refunds: It has merge conflicts');
  assert.deepEqual(notes[0].target, { type: 'pr', projectId: 'p1', repoId: 'r1', id: 7 });
  assert.deepEqual(diffSnapshots(next, next), [], 'once');
});
