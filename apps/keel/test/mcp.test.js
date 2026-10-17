import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleMessage, resolveProject, TOOLS } from '../server/mcp.js';
import { createMcpTokens } from '../server/mcptokens.js';
import { commitRefs, mergeCommits } from '../server/domain/commits.js';

const PROJECTS = [
  { id: 'p-1', name: 'Commerce', types: ['User Story', 'Bug'], teams: [{ id: 't-1', name: 'Commerce Team', iteration: { name: 'Sprint 42', path: 'Commerce\\Sprint 42' } }] },
  { id: 'p-2', name: 'Mobile', org: 'other', types: ['Product Backlog Item', 'Bug'], teams: [] },
];

// A stand-in for the signed-in person's service: records what Claude asked for.
function fakeSession(role = 'pm') {
  const calls = [];
  const service = {
    async newWorkItemOptions() { return PROJECTS; },
    async createWorkItem(body) {
      calls.push(['create', body]);
      return { id: 4300, webUrl: 'https://dev.azure.com/x/Commerce/_workitems/edit/4300' };
    },
    async workItems() {
      return {
        me: { uniqueName: 'pat@x.com' },
        items: [
          { id: 7, projectId: 'p-1', projectName: 'Commerce', type: 'Bug', title: 'Safari checkout broken', state: 'New', tags: ['web'], assignedTo: { displayName: 'Pat', uniqueName: 'pat@x.com' }, changedAt: '2026-10-01T00:00:00Z' },
          { id: 8, projectId: 'p-1', projectName: 'Commerce', type: 'User Story', title: 'Guest checkout', state: 'Active', tags: [], assignedTo: null, changedAt: '2026-10-02T00:00:00Z' },
        ],
      };
    },
    async workItemAction(id, action, org) { calls.push(['action', id, action, org]); },
  };
  return { session: { ctx: { service, role } }, calls };
}

const call = (session, name, args = {}) => handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, session);
const json = (res) => JSON.parse(res.result.content[0].text);

test('mcp: initialize, tools/list, ping and notifications', async () => {
  const { session } = fakeSession();
  const init = await handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, session);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'keel');
  assert.ok(init.result.capabilities.tools);
  const unknownVersion = await handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, session);
  assert.match(unknownVersion.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);

  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
  assert.deepEqual(list.result.tools.map((x) => x.name), TOOLS.map((x) => x.name));
  for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, 'object');

  assert.deepEqual((await handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' }, session)).result, {});
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, session), null);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, session)).error.code, -32601);
  assert.equal((await handleMessage({ id: 5, method: 'ping' }, session)).error.code, -32600);
});

test('mcp: create_work_item resolves names, then files it as the person', async () => {
  const { session, calls } = fakeSession();
  const res = await call(session, 'create_work_item', { project: 'commerce', type: 'bug', title: '  Checkout fails  ', priority: 2, tags: ['web'], current_sprint: true });
  assert.equal(res.result.isError, undefined);
  assert.deepEqual(json(res), {
    id: 4300, url: 'https://dev.azure.com/x/Commerce/_workitems/edit/4300', project: 'Commerce', type: 'Bug', title: 'Checkout fails', team: 'Commerce Team', placedIn: 'Sprint 42',
  });
  const [, body] = calls[0];
  assert.equal(body.projectId, 'p-1');
  assert.equal(body.type, 'Bug');
  assert.equal(body.teamId, 't-1');
  assert.equal(body.iteration, 'sprint');

  const wrongType = await call(session, 'create_work_item', { project: 'Commerce', type: 'Epic', title: 'x' });
  assert.equal(wrongType.result.isError, true);
  assert.match(wrongType.result.content[0].text, /User Story, Bug/);
  const wrongTeam = await call(session, 'create_work_item', { project: 'Commerce', type: 'Bug', title: 'x', team: 'Nope' });
  assert.match(wrongTeam.result.content[0].text, /No team "Nope"/);
  assert.equal(calls.length, 1);
});

test('mcp: tools a role may not use are hidden and refused', async () => {
  const { session, calls } = fakeSession('viewer');
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
  assert.ok(!list.result.tools.some((x) => x.name === 'create_work_item'));
  assert.ok(list.result.tools.some((x) => x.name === 'search_work_items'));
  const res = await call(session, 'create_work_item', { project: 'Commerce', type: 'Bug', title: 'x' });
  assert.equal(res.result.isError, true);
  assert.equal(calls.length, 0);
});

test('mcp: search_work_items and comments', async () => {
  const { session, calls } = fakeSession();
  assert.deepEqual(json(await call(session, 'search_work_items', { query: 'checkout' })).items.map((w) => w.id), [8, 7]);
  assert.deepEqual(json(await call(session, 'search_work_items', { query: 'checkout', type: 'bug' })).items.map((w) => w.id), [7]);
  assert.deepEqual(json(await call(session, 'search_work_items', { assigned_to: 'me' })).items.map((w) => w.id), [7]);
  assert.deepEqual(json(await call(session, 'add_work_item_comment', { id: 7, text: 'Client approved', org: 'other' })), { ok: true, id: 7 });
  assert.deepEqual(calls[0], ['action', 7, { type: 'comment', text: 'Client approved' }, 'other']);
  assert.equal((await call(session, 'add_work_item_comment', { id: 7, text: '  ' })).result.isError, true);
  assert.equal((await call(session, 'nope')).error.code, -32602);
});

test('mcp: projects by id, name or org/name', () => {
  assert.equal(resolveProject(PROJECTS, 'p-2').name, 'Mobile');
  assert.equal(resolveProject(PROJECTS, 'other/mobile').id, 'p-2');
  assert.throws(() => resolveProject(PROJECTS, 'Retail'), /No tracked project called "Retail"\. Tracked projects: Commerce, other\/Mobile/);
  assert.throws(() => resolveProject([...PROJECTS, { id: 'p-3', name: 'Commerce', org: 'b' }], 'Commerce'), /matches several projects/);
});

test('mcp tokens: shown once, stored hashed, per person, revocable', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keel-mcp-')), 'mcp-tokens.json');
  const tokens = createMcpTokens(file);
  const { token, entry } = tokens.create('u1', 'Laptop');
  assert.match(token, /^keel_[A-Za-z0-9_-]{43}$/);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(token), 'the token itself is never written');
  assert.equal(entry.hash, undefined);
  assert.deepEqual(tokens.resolve(token), { id: entry.id, userId: 'u1', name: 'Laptop' });
  assert.ok(tokens.list('u1')[0].lastUsedAt);
  assert.deepEqual(tokens.list('u2'), []);
  assert.equal(tokens.resolve('keel_wrong'), null);
  assert.equal(tokens.resolve(`keel_${'A'.repeat(43)}`), null);

  assert.throws(() => tokens.revoke('u2', entry.id), /No such Claude connection/);
  tokens.revoke('u1', entry.id);
  assert.equal(tokens.resolve(token), null);

  const again = tokens.create('u1', '');
  assert.equal(again.entry.name, 'Claude');
  tokens.removeUser('u1');
  assert.equal(tokens.resolve(again.token), null);
});

test('commits: work items and pull requests from messages, merged newest first', () => {
  assert.deepEqual(commitRefs('Fix VAT rounding (AB#4107) and #12, again #4107'), { workItemIds: [4107, 12], prId: null });
  assert.deepEqual(commitRefs('Merged PR 815: Add PDF invoices\n\nRelated work items: #4101'), { workItemIds: [4101], prId: 815 });
  assert.deepEqual(commitRefs('Bump to v2 #1'), { workItemIds: [], prId: null });

  const repo = (id) => ({ id, name: id, projectId: 'p', projectName: 'P' });
  const c = (id, date, message = 'x') => ({ id, message, author: { name: 'A', email: 'a@x', date } });
  const merged = mergeCommits([
    { repo: repo('web'), commits: [c('a', '2026-10-03T00:00:00Z', 'Subject line\n\nBody'), c('b', '2026-10-01T00:00:00Z')] },
    { repo: repo('api'), commits: [c('c', '2026-10-02T00:00:00Z')] },
  ]);
  assert.deepEqual(merged.map((x) => [x.id, x.repoName]), [['a', 'web'], ['c', 'api'], ['b', 'web']]);
  assert.equal(merged[0].subject, 'Subject line');
  assert.equal(mergeCommits([{ repo: repo('web'), commits: [c('a', '2026-10-03'), c('b', '2026-10-02')] }], { limit: 1 }).length, 1);
});
