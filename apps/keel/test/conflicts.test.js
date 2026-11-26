import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAzdoProvider } from '../server/azdo/provider.js';
import { conflictChoices, hasMarkers, mergeWithMarkers, resolutionProblem } from '../server/domain/conflicts.js';
import { createMockProvider } from '../server/mock/provider.js';
import { createService } from '../server/service.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pick = ({ text, conflicts }) => ({ text, conflicts });
const memoryStore = () => {
  let current = { ...structuredClone(DEFAULT_SETTINGS), projects: { 'p-commerce': { name: 'Commerce', tracked: true, repos: 'all', teams: [] } } };
  return { load: async () => current, save: async (patch) => (current = { ...current, ...patch }) };
};
const provider = () => createAzdoProvider({ orgUrl: 'https://dev.azure.com/acme', pat: 'test-token' });

test('pull request conflicts: names or numbers, unresolved first', async () => {
  let asked;
  globalThis.fetch = async (url) => {
    asked = new URL(url);
    return json(200, { value: [
      { conflictId: 3, conflictPath: '/src/b.ts', conflictType: 'editEdit', resolutionStatus: 'resolved' },
      { conflictId: 1, conflictPath: '/src/a.ts', conflictType: 7, resolutionStatus: 0 },
      { conflictId: 2, conflictPath: '/README.md', conflictType: 'DeleteEdit', resolutionStatus: 'unresolved' },
    ] });
  };
  const list = await provider().listPullRequestConflicts('proj', 'repo', 42);
  assert.equal(asked.pathname, '/acme/proj/_apis/git/repositories/repo/pullRequests/42/conflicts');
  assert.equal(asked.searchParams.get('api-version'), '7.1-preview.1');
  assert.deepEqual(list, [
    { id: 2, path: '/README.md', type: 'deleteEdit', status: 'unresolved' },
    { id: 1, path: '/src/a.ts', type: 'editDelete', status: 'unresolved' },
    { id: 3, path: '/src/b.ts', type: 'editEdit', status: 'resolved' },
  ]);
});

test('restart merge queues the merge, else re-applies the merge options', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', body });
    if (init.method === 'PATCH' && body.mergeStatus) return json(400, { message: 'InvalidArgumentValueException: mergeStatus' });
    if (init.method === 'PATCH') return json(200, {});
    return json(200, { pullRequestId: 42, mergeOptions: { disableRenames: true } });
  };
  await provider().restartMerge('proj', 'repo', 42);
  assert.deepEqual(calls.map((c) => [c.method, c.body]), [
    ['PATCH', { mergeStatus: 'queued' }],
    ['GET', null],
    ['PATCH', { mergeOptions: { disableRenames: true } }],
  ]);
});

test('a conflict reads its three versions from its blobs', async () => {
  const asked = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    asked.push(u.pathname + (u.searchParams.get('$format') ? `?${u.searchParams.get('$format')}` : ''));
    if (u.pathname.endsWith('/conflicts/5')) {
      return json(200, { conflictId: 5, conflictPath: '/a.txt', conflictType: 'editEdit', resolutionStatus: 'unresolved', baseBlob: { objectId: 'b0' }, sourceBlob: { objectId: 's1' }, targetBlob: { objectId: 't2' } });
    }
    return new Response(`text of ${u.pathname.split('/').pop()}`, { status: 200 });
  };
  const c = await provider().getPullRequestConflict('proj', 'repo', 42, 5);
  assert.deepEqual(c, { id: 5, path: '/a.txt', type: 'editEdit', status: 'unresolved', base: 'text of b0', source: 'text of s1', target: 'text of t2' });
  assert.ok(asked.includes('/acme/proj/_apis/git/repositories/repo/blobs/s1?text'));
});

test('resolving a conflict PATCHes the resolution Azure DevOps takes for its kind', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ path: new URL(url).pathname, method: init.method, body: JSON.parse(init.body) });
    return json(200, {});
  };
  await provider().resolvePullRequestConflict('proj', 'repo', 42, 5, 'editEdit', { keep: 'target' });
  await provider().resolvePullRequestConflict('proj', 'repo', 42, 6, 'deleteEdit', { keep: 'source' });
  await provider().resolvePullRequestConflict('proj', 'repo', 42, 7, 'addAdd', { content: 'hé\n' });
  assert.equal(calls[0].path, '/acme/proj/_apis/git/repositories/repo/pullRequests/42/conflicts/5');
  assert.deepEqual(calls.map((c) => [c.method, c.body]), [
    ['PATCH', { conflictId: 5, conflictType: 'editEdit', resolution: { mergeType: 'takeTargetContent' }, resolutionStatus: 'resolved' }],
    ['PATCH', { conflictId: 6, conflictType: 'deleteEdit', resolution: { action: 'pickSourceAction' }, resolutionStatus: 'resolved' }],
    ['PATCH', { conflictId: 7, conflictType: 'addAdd', resolution: { mergeType: 'userMerged', userMergedContent: [104, 195, 169, 10] }, resolutionStatus: 'resolved' }],
  ]);
});

test('three-way merge: one-sided changes merge, overlapping ones are marked', () => {
  const base = 'a\nb\nc\nd\ne\n';
  const source = 'A\nb\nc\nd2\ne\n';
  const target = 'a\nb\nC\nd3\ne\nf\n';
  const { text, conflicts } = mergeWithMarkers(base, source, target, { source: 'feature', target: 'main' });
  assert.equal(conflicts, 1);
  assert.equal(text, 'A\nb\n<<<<<<< feature\nc\nd2\n=======\nC\nd3\n>>>>>>> main\ne\nf\n');
  assert.ok(hasMarkers(text));
  // Both branches making the same change isn't a conflict.
  assert.deepEqual(pick(mergeWithMarkers(base, source, source)), { text: source, conflicts: 0 });
  assert.deepEqual(pick(mergeWithMarkers(base, 'a\nb2\nc\nd\ne\n', 'a\nb\nc\nd\ne2\n')), { text: 'a\nb2\nc\nd\ne2\n', conflicts: 0 });
  // Added on both sides with nothing in common: one conflict, the whole file.
  assert.equal(mergeWithMarkers('', 'x\n', 'y\n').conflicts, 1);
});

test('which kinds Keel resolves, and what it refuses', () => {
  assert.deepEqual(conflictChoices('editEdit'), { keep: true, edit: true });
  assert.deepEqual(conflictChoices('deleteEdit'), { keep: true, edit: false });
  assert.deepEqual(conflictChoices('renameRename'), { keep: false, edit: false });
  assert.equal(resolutionProblem('editEdit', { keep: 'source' }), null);
  assert.equal(resolutionProblem('editEdit', { content: 'fine\n' }), null);
  assert.match(resolutionProblem('editEdit', { content: '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n' }), /markers/);
  assert.match(resolutionProblem('deleteEdit', { content: 'x' }), /keep one branch/);
  assert.match(resolutionProblem('renameRename', { keep: 'source' }), /rename or folder/);
  assert.match(resolutionProblem('editEdit', {}), /which side/);
});

test('demo organization: resolve each conflict, and the merge runs again once none is left', async () => {
  const service = createService({ provider: createMockProvider(), settings: memoryStore() });
  const { prs } = await service.pullRequests();
  const conflicted = await Promise.all(prs.filter((p) => p.hasConflicts).map(async (pr) => ({ pr, ...(await service.pullRequestConflicts(pr.projectId, pr.repoId, pr.id)) })));
  const withRename = conflicted.find((x) => x.conflicts.some((c) => !conflictChoices(c.type).keep));
  const clean = conflicted.find((x) => x.conflicts.every((c) => conflictChoices(c.type).keep));
  assert.ok(withRename && clean, 'the demo has both kinds of conflicted pull request');

  // The editor starts from the three-way merge, and a file still marked is refused.
  const { pr, conflicts } = clean;
  const editable = conflicts.find((c) => c.type === 'editEdit');
  const one = await service.pullRequestConflict(pr.projectId, pr.repoId, pr.id, editable.id);
  assert.equal(one.merged.conflicts, 2);
  assert.equal(one.merged.chunks.filter((x) => !x.same).length, 2);
  assert.match(one.merged.text, new RegExp(`<<<<<<< ${pr.sourceBranch}\n`));
  assert.match(one.merged.text, /kept in sync with the pricing service/, 'the target\'s one-sided change is merged');
  await assert.rejects(service.resolveConflict(pr.projectId, pr.repoId, pr.id, editable.id, { content: one.merged.text }), /markers/);
  const settled = one.merged.text.replace(/<<<<<<< .*\n([\s\S]*?)=======\n[\s\S]*?>>>>>>> .*\n/g, '$1');
  let last = await service.resolveConflict(pr.projectId, pr.repoId, pr.id, editable.id, { content: settled });
  assert.equal(last.merging, last.left === 0);
  for (const c of conflicts.filter((x) => x.id !== editable.id)) last = await service.resolveConflict(pr.projectId, pr.repoId, pr.id, c.id, { keep: 'target' });
  assert.deepEqual([last.left, last.merging], [0, true]);
  assert.equal((await service.pullRequest(pr.projectId, pr.repoId, pr.id)).mergeStatus, 'queued');

  // A rename stays for the person to fix, so the merge isn't run again.
  const w = withRename;
  for (const c of w.conflicts) {
    if (conflictChoices(c.type).keep) last = await service.resolveConflict(w.pr.projectId, w.pr.repoId, w.pr.id, c.id, { keep: 'source' });
    else await assert.rejects(service.resolveConflict(w.pr.projectId, w.pr.repoId, w.pr.id, c.id, { keep: 'source' }), /rename or folder/);
  }
  assert.deepEqual([last.left, last.merging], [1, false]);
});

test('picking lines from either side of each conflict', async () => {
  const { initialPicks, toggleLine, takeAll, swapOrder, undecided, pickedText } = await import('../client/src/conflictpick.js');
  const { chunks } = mergeWithMarkers('a\nb\nc\nd\ne\n', 'a\nB1\nB2\nc\nd\nE1\n', 'a\nX\nc\nd\nE2\nE3\n');
  assert.equal(chunks.filter((c) => !c.same).length, 2);
  let picks = initialPicks(chunks);
  assert.equal(undecided(picks), 2);
  assert.equal(pickedText(chunks, picks, { source: 'f', target: 'main' }), 'a\n<<<<<<< f\nB1\nB2\n=======\nX\n>>>>>>> main\nc\nd\n<<<<<<< f\nE1\n=======\nE2\nE3\n>>>>>>> main\n');
  // The first: the source's second line, then the target's line, target first.
  const first = chunks.findIndex((c) => !c.same);
  const second = chunks.findLastIndex((c) => !c.same);
  picks = toggleLine(picks, first, 'source', 1);
  picks = toggleLine(picks, first, 'target', 0);
  picks = swapOrder(picks, first);
  assert.equal(undecided(picks), 1);
  // The second: all of both; then neither is a choice too.
  picks = takeAll(picks, second, 'both');
  assert.equal(pickedText(chunks, picks), 'a\nX\nB2\nc\nd\nE1\nE2\nE3\n');
  picks = takeAll(picks, second, 'none');
  assert.equal(undecided(picks), 0);
  assert.equal(pickedText(chunks, picks), 'a\nX\nB2\nc\nd\n');
});
