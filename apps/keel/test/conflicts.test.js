import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAzdoProvider } from '../server/azdo/provider.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
