import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAzdoProvider } from '../server/azdo/provider.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const item = (id, type) => ({ id, rev: 1, fields: { 'System.TeamProject': 'Shop', 'System.WorkItemType': type, 'System.Title': `Item ${id}`, 'System.State': 'New' } });

test('work items carry their type color from Azure DevOps', async () => {
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/_apis/wit/fields')) return json({ value: [{ referenceName: 'System.Title' }] });
    if (path.endsWith('/_apis/wit/workitemsbatch')) return json({ value: [item(1, 'Bug'), item(2, 'Incident'), item(3, 'Odd')] });
    if (path.endsWith('/_apis/wit/workitemtypes')) {
      return json({ value: [
        { name: 'Bug', color: 'CC293D', states: [{ name: 'New', category: 'Proposed' }] },
        { name: 'Incident', color: '#5c2d91', states: [{ name: 'New', category: 'Proposed' }] },
        { name: 'Odd', color: 'red;background:url(x)', states: [{ name: 'New', category: 'Proposed' }] },
      ] });
    }
    throw new Error(`unexpected ${path}`);
  };
  const items = await createAzdoProvider({ orgUrl: 'https://dev.azure.com/acme', pat: 'test-token' }).getWorkItems([1, 2, 3]);
  assert.deepEqual(items.map((w) => [w.type, w.typeColor]), [['Bug', '#CC293D'], ['Incident', '#5c2d91'], ['Odd', null]]);
});
