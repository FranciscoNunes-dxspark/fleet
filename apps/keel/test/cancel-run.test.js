import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAzdoProvider } from '../server/azdo/provider.js';
import { createService } from '../server/service.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';

test('cancel a run: PATCH its status to cancelling; refused says which permission', async (t) => {
  const calls = [];
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = new URL(url);
    calls.push([opts.method, u.pathname, opts.body ? JSON.parse(opts.body) : null]);
    if (status !== 200) return new Response('{"message":"Access denied"}', { status, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 42, status: 'cancelling' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const provider = createAzdoProvider({ orgUrl: 'https://dev.azure.com/acme', pat: 'x' });
  assert.deepEqual(await provider.cancelBuild('p1', 42), { id: 42, status: 'cancelling' });
  assert.deepEqual(calls[0], ['PATCH', '/acme/p1/_apis/build/builds/42', { status: 'cancelling' }]);
  status = 403;
  await assert.rejects(provider.cancelBuild('p1', 42), /Stop builds permission/);
});

test('cancel a run: only in tracked projects, and the run lists are read again', async () => {
  const cancelled = [];
  let listed = 0;
  const provider = {
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [],
    listBuilds: async () => (listed++, []),
    listDefinitions: async () => [],
    cancelBuild: async (projectId, id) => (cancelled.push([projectId, id]), { id, status: 'cancelling' }),
  };
  const settings = { ...structuredClone(DEFAULT_SETTINGS), projects: { p1: { name: 'Shop', tracked: true, repos: 'all', teams: [] } } };
  const service = createService({ provider, settings: { load: async () => settings, save: async () => settings } });
  await assert.rejects(service.cancelBuild('other', 7), /Unknown project/);
  await service.pipelines();
  await service.cancelBuild('p1', 7);
  await service.pipelines();
  assert.deepEqual(cancelled, [['p1', 7]]);
  assert.equal(listed, 2, 'runs read again after cancelling');
});
