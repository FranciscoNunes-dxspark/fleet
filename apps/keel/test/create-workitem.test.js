import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAzdoProvider } from '../server/azdo/provider.js';

test('create a work item: POST to workitems/$<type>, custom types included', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = new URL(url);
    calls.push([opts.method || 'GET', u.pathname]);
    return new Response(JSON.stringify({ id: 7, value: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const provider = createAzdoProvider({ orgUrl: 'https://dev.azure.com/acme', pat: 'x' });
  const created = await provider.createWorkItem('Fabrikam - MVC - WebShopSite', 'Error', { title: 'Crash on save' });
  assert.equal(created.id, 7);
  assert.deepEqual(calls.find(([method]) => method === 'POST'), ['POST', '/acme/Fabrikam%20-%20MVC%20-%20WebShopSite/_apis/wit/workitems/$Error']);
  await provider.createWorkItem('Shop', 'Product Backlog Item', { title: 'Refunds' });
  assert.equal(calls.filter(([method]) => method === 'POST').at(-1)[1], '/acme/Shop/_apis/wit/workitems/$Product%20Backlog%20Item');
});
