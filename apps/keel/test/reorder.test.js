import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAzdoProvider } from '../server/azdo/provider.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('reordering moves the item between its neighbours in the team backlog', async () => {
  let asked;
  globalThis.fetch = async (url, init) => {
    asked = { url: new URL(url), method: init.method, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ count: 1, value: [{ id: 7, order: 1000102770.5 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const provider = createAzdoProvider({ orgUrl: 'https://dev.azure.com/acme', pat: 'test-token' });
  const result = await provider.reorderWorkItems('proj-id', 'team-id', { ids: [7], previousId: 4, nextId: 5 });
  assert.equal(asked.method, 'PATCH');
  assert.equal(asked.url.pathname, '/acme/proj-id/team-id/_apis/work/workitemsorder');
  assert.equal(asked.url.searchParams.get('api-version'), '7.1');
  assert.deepEqual(asked.body, { ids: [7], previousId: 4, nextId: 5, parentId: 0 });
  assert.deepEqual(result, [{ id: 7, order: 1000102770.5 }]);
});

test('the board sorts by backlog order (Stack Rank or Backlog Priority)', async () => {
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const body = path.endsWith('/_apis/wit/fields')
      ? { value: [{ referenceName: 'Microsoft.VSTS.Common.StackRank' }, { referenceName: 'Microsoft.VSTS.Common.BacklogPriority' }] }
      : path.endsWith('/workitemsbatch')
        ? { value: [
          { id: 1, fields: { 'System.TeamProject': 'P', 'System.WorkItemType': 'Bug', 'Microsoft.VSTS.Common.StackRank': 20 } },
          { id: 2, fields: { 'System.TeamProject': 'P', 'System.WorkItemType': 'Product Backlog Item', 'Microsoft.VSTS.Common.BacklogPriority': 5 } },
          { id: 3, fields: { 'System.TeamProject': 'P', 'System.WorkItemType': 'Task' } },
        ] }
        : { value: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const items = await createAzdoProvider({ orgUrl: 'https://dev.azure.com/acme', pat: 'test-token' }).getWorkItems([1, 2, 3]);
  assert.deepEqual(items.map((w) => [w.id, w.backlogOrder]), [[1, 20], [2, 5], [3, null]]);
});
