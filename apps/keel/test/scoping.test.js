import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createService, projectsStore } from '../server/service.js';
import { createMultiService } from '../server/multiorg.js';
import { createChannels } from '../server/channels.js';
import { createMonitoring } from '../server/monitoring.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';

process.env.MONITOR_ALLOW_PRIVATE = '1'; // no DNS for the made-up addresses

/** Settings kept in memory, with one tracked project. */
const memoryStore = (extra = {}) => {
  let current = { ...structuredClone(DEFAULT_SETTINGS), projects: { p1: { name: 'Shop', tracked: true, repos: 'all', teams: [] } }, ...extra };
  return { load: async () => current, save: async (patch) => (current = { ...current, ...patch }) };
};

const down = (id, extra) => ({
  id, name: `${id} app`, url: `https://${id}.example.test`, link: null, projectId: null,
  state: 'down', issues: [{ code: 'down', severity: 'high', text: 'Down' }], last: { at: new Date().toISOString(), ok: false }, ...extra,
});

/** Just enough Azure DevOps for the inbox and production pages: two projects, nothing open. */
const provider = () => ({
  me: async () => ({ id: 'me', displayName: 'Me', uniqueName: 'me@x' }),
  listProjects: async () => [{ id: 'p1', name: 'Shop' }, { id: 'p2', name: 'Games' }],
  listTeams: async (projectId) => (projectId === 'p2' ? [{ id: 't-other', name: 'Other' }, { id: 't2', name: 'Games Team' }] : []),
  listRepos: async () => [],
  listPullRequests: async () => [],
  queryWorkItems: async () => [],
  getWorkItems: async () => [],
  listBuilds: async () => [],
  listDefinitions: async () => [],
  listReleases: async () => [],
  listReleaseApprovals: async () => [],
  listPendingChecks: async () => [],
  getCurrentIteration: async () => null,
  getTeamMembers: async () => [],
  getWorkItemTypeStates: async () => ({}),
});

test('monitors: people see those of the projects they track and those of no project', async () => {
  const monitoring = {
    status: () => [
      down('mine', { link: { type: 'pipeline', projectId: 'p1', definitionId: 5 }, projectId: 'p1' }),
      down('theirs', { projectId: 'p2' }),
      down('everyone'),
    ],
  };
  const service = createService({ provider: provider(), settings: memoryStore(), monitoring });
  const { monitors } = await service.production();
  assert.deepEqual(monitors.map((m) => m.id), ['mine', 'everyone']);

  const { targets } = await service.undeployed();
  assert.deepEqual(targets.map((t) => t.name).sort(), ['everyone app', 'mine app'], 'Waiting to ship too');

  const inbox = (await service.attention()).items.filter((i) => i.kind === 'production');
  assert.deepEqual(inbox.map((i) => i.key.split(':')[1]).sort(), ['everyone', 'mine']);

  // Someone who tracks Games sees its monitor instead of Shop's.
  const games = createService({ provider: provider(), settings: memoryStore({ projects: { p2: { name: 'Games', tracked: true, repos: 'all', teams: [] } } }), monitoring });
  assert.deepEqual((await games.production()).monitors.map((m) => m.id), ['theirs', 'everyone']);
});

test('monitors: belong to the project that deploys them, else the one picked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-monitor-project-'));
  try {
    const monitoring = createMonitoring({ dataDir: dir, mock: false });
    const appInsightsAppId = '0f1e2d3c-0000-4000-8000-000000000000';
    const saved = await monitoring.save([
      { name: 'Linked', appInsightsAppId, projectId: 'p9', link: { type: 'pipeline', projectId: 'p1', definitionId: 5 } },
      { name: 'Picked', appInsightsAppId, projectId: 'p2' },
      { name: 'Everyone', appInsightsAppId, projectId: '' },
    ]);
    assert.deepEqual(saved.map((m) => m.projectId), ['p1', 'p2', null]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a channel view: tracked projects keep their teams, others get their default team; read-only', async () => {
  const base = memoryStore({ projects: { p1: { name: 'Shop', tracked: true, repos: ['r1'], teams: [{ id: 't1', name: 'Web' }] } } });
  const store = projectsStore(base, ['p1', 'p2', 'p-elsewhere'], provider());
  const { projects, thresholds } = await store.load();
  assert.deepEqual(Object.keys(projects), ['p1', 'p2'], "another organization's project is left to that organization");
  assert.deepEqual(projects.p1.repos, ['r1']);
  assert.deepEqual(projects.p2.teams, [{ id: 't2', name: 'Games Team' }]);
  assert.equal(projects.p2.repos, 'all');
  assert.equal(thresholds.stalePrDays, 5, 'thresholds stay the owner\'s');
  await assert.rejects(store.save({ projects: {} }), /read-only/);
});

test('a channel with its own projects is read through a view of them, shared by channels that pick the same', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-channel-projects-'));
  const views = [];
  const make = (projects) => ({
    projects,
    invalidate: () => {},
    attention: async () => ({ items: [{ key: `prod:${projects || 'own'}`, kind: 'production', severity: 'high', title: `${projects || 'own'} is down`, reasons: [] }] }),
    withProjects(ids) {
      const v = make(ids.join(','));
      views.push(v);
      return v;
    },
  });
  const owner = make(null);
  const channels = createChannels({ dataDir: dir, mock: false, resolveService: () => owner, send: async () => {}, every: 3_600_000 });
  try {
    const hook = 'https://hooks.example.test/x';
    const { channels: saved } = await channels.save([
      { name: 'Games', kind: 'slack', url: hook, events: ['production'], projects: ['p2', 'p3', 'p2', '../bad'] },
      { name: 'Games too', kind: 'slack', url: hook, events: ['production'], projects: ['p3', 'p2'] },
      { name: 'Mine', kind: 'slack', url: hook, events: ['production'] },
    ]);
    assert.deepEqual(saved.map((c) => c.projects), [['p2', 'p3'], ['p3', 'p2'], []]);
    await channels.tick();
    assert.deepEqual(views.map((v) => v.projects), ['p2,p3'], 'one view for both Games channels, none for Mine');
    await channels.tick();
    assert.equal(views.length, 1, 'kept from one look to the next');
  } finally {
    channels.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('several organizations: a channel view covers each of them', async () => {
  const asked = [];
  const svc = (key) => ({ withProjects: (ids) => (asked.push([key, ids]), { key }) });
  const multi = createMultiService([
    { org: { key: 'a', primary: true }, service: svc('a') },
    { org: { key: 'b' }, service: svc('b') },
  ]);
  multi.withProjects(['p1', 'p2']);
  assert.deepEqual(asked, [['a', ['p1', 'p2']], ['b', ['p1', 'p2']]]);
});

test('platform totals: Fetch all fetches the sites one after another, then not again for 10 minutes', async () => {
  const http = await import('node:http');
  const { demoTotals } = await import('../server/platform.js');
  let inFlight = 0;
  let most = 0;
  const asked = [];
  const site = http.createServer((req, res) => {
    if (!req.url.startsWith('/totals')) return res.end('ok');
    asked.push(req.headers.host);
    inFlight++;
    most = Math.max(most, inFlight);
    setTimeout(() => {
      inFlight--;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(demoTotals('platform-a')));
    }, 30);
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const { port } = site.address();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-fetch-all-'));
  try {
    const monitoring = createMonitoring({ dataDir: dir, mock: false });
    const saved = await monitoring.save([
      { name: 'A', url: `http://127.0.0.1:${port}/health`, totalsKey: 'k1' },
      { name: 'B', url: `http://localhost:${port}/health`, totalsKey: 'k2' },
      { name: 'No key', url: `http://127.0.0.1:${port}/health` },
    ]);
    assert.deepEqual(monitoring.fetchAllTotalsNow(), { started: 2, skipped: 0 });
    assert.equal(monitoring.totals().filter((s) => s.fetching || s.queued).length, 2, 'both show as under way at once');
    for (let i = 0; i < 100 && monitoring.totals().some((s) => !s.latest); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(monitoring.totals().filter((s) => s.latest).length, 2);
    assert.equal(most, 1, 'one site at a time');
    assert.equal(asked.length, 2);
    assert.throws(() => monitoring.fetchAllTotalsNow(), /less than 10 minutes/);
    assert.throws(() => monitoring.fetchAllTotalsNow([saved[2].id]), /No site has a totals key/, 'only the sites asked for');
  } finally {
    site.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
