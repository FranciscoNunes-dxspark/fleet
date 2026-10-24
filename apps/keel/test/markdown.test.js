import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAzdoProvider } from '../server/azdo/provider.js';

// A stand-in for Azure DevOps: records requests and answers from a handler.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubAzdo(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method || 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const [status, body] = handler(call) || [200, {}];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}
const provider = () => createAzdoProvider({ orgUrl: 'https://dev.azure.com/acme', pat: 'test-token' });
const workItem = (fields, extra = {}) => ({ id: 7, fields: { 'System.Title': 'T', 'System.WorkItemType': 'Task', 'System.TeamProject': 'Shop', 'System.State': 'New', ...fields }, relations: [], _links: {}, ...extra });

test('comments are posted as Markdown', async () => {
  const calls = stubAzdo(() => [200, { id: 1 }]);
  await provider().commentWorkItem('Shop', 7, '**done**\n- a');
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.query.format, 'markdown');
  assert.equal(post.body.text, '**done**\n- a');
});

test('comments fall back to HTML where Markdown is refused', async () => {
  const calls = stubAzdo((c) => (c.query.format === 'markdown' ? [400, { message: 'The format parameter is not supported' }] : [200, { id: 1 }]));
  await provider().commentWorkItem('Shop', 7, '**done**');
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.match(posts[1].body.text, /<strong>done<\/strong>/);
});

test('new work item descriptions are stored as Markdown', async () => {
  const calls = stubAzdo((c) => (c.method === 'POST' ? [200, { id: 9, _links: {} }] : [200, { value: [] }]));
  await provider().createWorkItem('Shop', 'User Story', { title: 'T', description: '# Goal' });
  const ops = calls.find((c) => c.method === 'POST').body;
  assert.deepEqual(ops.find((o) => o.path === '/fields/System.Description').value, '# Goal');
  assert.deepEqual(ops.find((o) => o.path.startsWith('/multilineFieldsFormat/')), { op: 'add', path: '/multilineFieldsFormat/System.Description', value: 'Markdown' });
});

test('new work item descriptions fall back to HTML where Markdown is refused', async () => {
  const calls = stubAzdo((c) => {
    if (c.method !== 'POST') return [200, { value: [] }];
    return c.body.some((o) => o.path.startsWith('/multilineFieldsFormat/')) ? [400, { message: 'Unknown path multilineFieldsFormat' }] : [200, { id: 9, _links: {} }];
  });
  await provider().createWorkItem('Shop', 'User Story', { title: 'T', description: '# Goal' });
  const retry = calls.filter((c) => c.method === 'POST')[1].body;
  assert.match(retry.find((o) => o.path === '/fields/System.Description').value, /<h1>Goal<\/h1>/);
  assert.ok(!retry.some((o) => o.path.startsWith('/multilineFieldsFormat/')));
});

test('Markdown fields and comments come back as Markdown, HTML ones keep their HTML', async () => {
  stubAzdo((c) => {
    if (c.path.endsWith('/comments')) {
      return [200, { comments: [
        { text: '**md**', format: 'markdown', createdBy: { displayName: 'A' }, createdDate: '2026-10-01T00:00:00Z' },
        { text: '<div>old <b>html</b></div>', format: 'html', createdBy: { displayName: 'B' }, createdDate: '2026-10-01T00:00:00Z' },
      ] }];
    }
    if (/workitems\/7$/i.test(c.path)) {
      return [200, workItem(
        { 'System.Description': '## Plan\n- one', 'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>works</li></ul>' },
        { multilineFieldsFormat: { 'System.Description': 'Markdown' } },
      )];
    }
    return [200, { value: [workItem({ 'System.Description': '## Plan\n- one' })], count: 1 }];
  });
  const w = await provider().getWorkItem(7);
  assert.equal(w.description, '## Plan\n- one');
  assert.equal(w.descriptionHtml, null);
  assert.equal(w.acceptanceCriteriaHtml, '<ul><li>works</li></ul>');
  assert.match(w.acceptanceCriteria, /works/);
  assert.deepEqual(w.comments.map((c) => [c.text, c.html]), [['**md**', null], ['old html', '<div>old <b>html</b></div>']]);
});
