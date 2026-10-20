import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAzdoProvider, graphHost } from '../server/azdo/provider.js';
import { createService } from '../server/service.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';

test('graph host: Azure DevOps Services only', () => {
  assert.equal(graphHost('https://dev.azure.com/acme'), 'https://vssps.dev.azure.com/acme');
  assert.equal(graphHost('https://acme.visualstudio.com'), 'https://acme.vssps.visualstudio.com');
  assert.equal(graphHost('https://tfs.example.com/tfs/Default'), null);
});

test('removing a team member goes through the Graph API; a refusal says what is missing', async (t) => {
  const calls = [];
  let refuse = false;
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = new URL(url);
    calls.push(`${opts.method || 'GET'} ${u.host}${u.pathname}`);
    if (refuse) return new Response('{"message":"TF400813"}', { status: 401, headers: { 'content-type': 'application/json' } });
    if (u.pathname.includes('/descriptors/')) {
      const value = u.pathname.endsWith('/member-1') ? 'aad.member' : 'vssgp.team';
      return new Response(JSON.stringify({ value }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(null, { status: 200 }); // the membership DELETE: no body at all
  });
  const provider = createAzdoProvider({ orgUrl: 'https://dev.azure.com/acme', pat: 'x' });
  await provider.removeTeamMember('p1', 'team-1', 'member-1');
  assert.deepEqual(calls.sort(), [
    'DELETE vssps.dev.azure.com/acme/_apis/graph/memberships/aad.member/vssgp.team',
    'GET vssps.dev.azure.com/acme/_apis/graph/descriptors/member-1',
    'GET vssps.dev.azure.com/acme/_apis/graph/descriptors/team-1',
  ]);

  refuse = true;
  await assert.rejects(provider.removeTeamMember('p1', 'team-1', 'member-1'), (err) => err.status === 403 && /Graph \(Read & manage\)/.test(err.message) && err.code !== 'token-rejected');
});

const person = (id, name) => ({ id, displayName: name, uniqueName: `${id}@x` });

test('team page: hide someone (yours only), and take someone out of a team you lead', async () => {
  const members = { t1: [person('ana', 'Ana'), person('rui', 'Rui')], t2: [person('rui', 'Rui')] };
  const removed = [];
  const busy = (id) => Array.from({ length: 6 }, (_, i) => ({ id: i + 1, title: `W${i}`, type: 'Task', state: 'Active', stateCategory: 'InProgress', assignedTo: person(id, id), changedAt: new Date().toISOString(), tags: [] }));
  const provider = {
    me: async () => person('me', 'Me'),
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [],
    listPullRequests: async () => [],
    queryWorkItems: async () => busy('rui'), // Rui has too much in progress
    getWorkItems: async () => [],
    getWorkItemTypeStates: async () => ({}),
    listWorkItemTypes: async () => [],
    listBuilds: async () => [],
    listDefinitions: async () => [],
    listReleases: async () => [],
    listReleaseApprovals: async () => [],
    listPendingChecks: async () => [],
    getCurrentIteration: async () => null,
    getBoards: async () => [],
    listTeamMembers: async (projectId, teamId) => members[teamId],
    removeTeamMember: async (projectId, teamId, memberId) => {
      removed.push([projectId, teamId, memberId]);
      members[teamId] = members[teamId].filter((m) => m.id !== memberId);
    },
  };
  let settings = { ...structuredClone(DEFAULT_SETTINGS), projects: { p1: { name: 'Shop', tracked: true, repos: 'all', teams: [{ id: 't1', name: 'Web' }, { id: 't2', name: 'Payments' }] } } };
  const store = { load: async () => settings, save: async (patch) => (settings = { ...settings, ...patch }) };
  const service = createService({ provider, settings: store });

  const before = await service.team();
  const rui = before.rows.find((r) => r.person.id === 'rui').person;
  assert.deepEqual(rui.teams.map((x) => x.teamName), ['Web', 'Payments'], 'each person with the teams they are in');
  assert.ok((await service.attention()).items.some((i) => i.kind === 'team'), 'Rui is flagged as overloaded');

  // Hidden: off the page and its overload alerts, listed to show again.
  await service.setHidden(rui, true);
  service.invalidate('');
  const hidden = await service.team();
  assert.deepEqual(hidden.rows.map((r) => r.person.id), ['ana']);
  assert.deepEqual(hidden.hidden.map((p) => p.displayName), ['Rui']);
  assert.ok(!(await service.attention()).items.some((i) => i.kind === 'team'));
  await service.setHidden(rui, false);
  service.invalidate('');
  assert.equal((await service.team()).rows.length, 2);

  // Removed from one team in Azure DevOps: only teams you lead in Keel.
  await assert.rejects(service.removeTeamMember('p1', 'someone-elses-team', 'rui'), /teams you lead/);
  await service.removeTeamMember('p1', 't2', 'rui');
  assert.deepEqual(removed, [['p1', 't2', 'rui']]);
  const after = (await service.team()).rows.find((r) => r.person.id === 'rui').person;
  assert.deepEqual(after.teams.map((x) => x.teamName), ['Web'], 'the page shows the change at once');
});

test('someone just removed stays off the team while Azure DevOps (or another server process) still lists them', async () => {
  const members = { t1: [person('ana', 'Ana'), person('rui', 'Rui')] };
  const provider = {
    me: async () => person('me', 'Me'),
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [],
    listPullRequests: async () => [],
    queryWorkItems: async () => [],
    getWorkItems: async () => [],
    getWorkItemTypeStates: async () => ({}),
    listWorkItemTypes: async () => [],
    listBuilds: async () => [],
    listDefinitions: async () => [],
    listReleases: async () => [],
    listReleaseApprovals: async () => [],
    listPendingChecks: async () => [],
    getCurrentIteration: async () => null,
    getBoards: async () => [],
    listTeamMembers: async (projectId, teamId) => members[teamId], // the removal doesn't show here yet
    removeTeamMember: async () => {},
  };
  let settings = { ...structuredClone(DEFAULT_SETTINGS), projects: { p1: { name: 'Shop', tracked: true, repos: 'all', teams: [{ id: 't1', name: 'Web' }] } } };
  const store = { load: async () => settings, save: async (patch) => (settings = { ...settings, ...patch }) };
  const here = createService({ provider, settings: store });
  const there = createService({ provider, settings: store }); // another process, same settings file
  const ids = async (service) => (await service.team()).rows.map((r) => r.person.id).sort();
  assert.deepEqual(await ids(there), ['ana', 'rui']); // its list is cached now

  await here.removeTeamMember('p1', 't1', 'rui');
  assert.deepEqual(await ids(here), ['ana']);
  assert.deepEqual(await ids(there), ['ana']);

  // An hour on, Azure DevOps listing them still means they're in the team.
  settings = { ...settings, removedMembers: { 'p1:t1:rui': new Date(Date.now() - 2 * 3_600_000).toISOString() } };
  assert.deepEqual(await ids(there), ['ana', 'rui']);
});
