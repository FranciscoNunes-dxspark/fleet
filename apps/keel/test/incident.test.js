import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAD_FAIL_RATE, MAX_SUSPECTS, TIMELINE, incidentStart, incidentTimeline, lastGoodDeploy, redeployPlan, suspectDeploys, timelineText,
} from '../server/domain/incident.js';
import { incidentMarkdown } from '../client/src/incident.js';
import { buildLine } from '../client/src/line/stages.js';
import { createService } from '../server/service.js';
import pt from '../client/src/locales/pt.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';

const H = 3_600_000;
/** Settings kept in memory, with one tracked project. */
const memoryStore = () => {
  let current = { ...structuredClone(DEFAULT_SETTINGS), projects: { p1: { name: 'Shop', tracked: true, repos: 'all', teams: [] } } };
  return { load: async () => current, save: async (patch) => (current = { ...current, ...patch }) };
};
const NOW = Date.parse('2026-11-06T12:00:00Z');
const at = (hAgo) => new Date(NOW - hAgo * H).toISOString();
const deploy = (id, hAgo, status = 'succeeded', extra = {}) => ({ id, label: `Release-${id}`, at: at(hAgo), status, webUrl: `https://x/${id}`, ...extra });

test('incident start: the first failed check after the last good one', () => {
  const history = [{ at: at(3), ok: true }, { at: at(2), ok: false }, { at: at(1.5), ok: true }, { at: at(1), ok: false }, { at: at(0.5), ok: false }];
  assert.equal(incidentStart({ state: 'down', history }, NOW), at(1));
});

test('incident start: the first of the trailing hourly buckets failing, earlier than the checks when so', () => {
  const series = [
    { at: at(5), total: 1000, failed: 3 },
    { at: at(4), total: 1000, failed: 70 },
    { at: at(3), total: 1000, failed: 90 },
    { at: at(2), total: 1000, failed: BAD_FAIL_RATE * 1000 },
  ];
  assert.equal(incidentStart({ state: 'degraded', ai: { series }, history: [{ at: at(1), ok: false }] }, NOW), at(4));
});

test('incident start: none when up, deploying or settling; the last check when nothing else says', () => {
  for (const state of ['up', 'deploying', 'settling', 'unknown']) assert.equal(incidentStart({ state, last: { at: at(1) } }, NOW), null);
  assert.equal(incidentStart({ state: 'degraded', last: { at: at(0.2), ok: true }, history: [{ at: at(0.2), ok: true }] }, NOW), at(0.2));
});

test('suspects: deploys in the day before, newest first, at most a few; else the latest before', () => {
  const history = [deploy(9, 0.5), deploy(8, 3), deploy(7, 10, 'failed'), deploy(6, 20), deploy(5, 22), deploy(4, 40)];
  const start = at(1);
  const found = suspectDeploys(history, start);
  assert.deepEqual(found.map((d) => d.id), [8, 7, 6], 'not the one after the incident began, and no more than MAX_SUSPECTS');
  assert.equal(found.length, MAX_SUSPECTS);
  assert.equal(found[0].gapMs, 2 * H);
  // A deploy that finished just after the first failure may still be the cause.
  assert.deepEqual(suspectDeploys([deploy(9, 0.95)], start).map((d) => d.id), [9]);
  // Nothing in the day before: the latest one, with how long before it was.
  const old = suspectDeploys([deploy(4, 40), deploy(3, 60)], start);
  assert.deepEqual(old.map((d) => [d.id, d.gapMs]), [[4, 39 * H]]);
  assert.deepEqual(suspectDeploys([], start), []);
});

test('last good deploy: the newest successful one older than every suspect', () => {
  const history = [deploy(8, 3), deploy(7, 10, 'failed'), deploy(6, 30, 'failed'), deploy(5, 40), deploy(4, 50)];
  const suspects = suspectDeploys(history, at(1));
  assert.equal(lastGoodDeploy(history, at(1), suspects).id, 5);
  assert.equal(lastGoodDeploy([deploy(8, 3)], at(1), suspectDeploys([deploy(8, 3)], at(1))), null);
  assert.equal(lastGoodDeploy(history, at(1), []).id, 8, 'with no suspects, the newest successful one before the incident');
});

test('redeploy: a classic release still listed, else go to Azure DevOps; a pipeline run never from Keel', () => {
  const target = { type: 'release', projectId: 'p1', definitionId: 2, stage: 'Production' };
  const defs = [{ projectId: 'p1', id: 2, releases: [{ id: 5, stages: [{ id: 51, name: 'QA' }, { id: 52, name: 'Production' }] }] }];
  assert.deepEqual(redeployPlan(target, deploy(5, 40), defs), {
    kind: 'release', projectId: 'p1', releaseId: 5, environmentId: 52, label: 'Release-5', stage: 'Production', webUrl: 'https://x/5',
  });
  assert.deepEqual(redeployPlan(target, deploy(4, 50), defs), { kind: 'manual', reason: 'notListed', label: 'Release-4', webUrl: 'https://x/4' });
  assert.equal(redeployPlan({ type: 'pipeline', projectId: 'p1', definitionId: 7 }, deploy(4, 50), defs).reason, 'pipeline');
  assert.equal(redeployPlan(target, null, defs), null);
});

test('timeline: merges, the deploy, its approval, the monitor turning bad and now, in order', () => {
  const suspects = [{ ...deploy(8, 3), startedAt: at(3.3), approvals: [{ by: 'Rita', at: at(3.4), status: 'approved' }, { by: 'Bot', at: null, status: 'approved' }] }];
  const pullRequests = [{ id: 41, title: 'Refunds', mergedAt: at(20), projectId: 'p1', repoId: 'r1' }, { id: 42, title: 'No date' }];
  const events = incidentTimeline({ monitor: { name: 'Shop', state: 'degraded' }, start: at(1), suspects, pullRequests, env: 'Production', now: NOW });
  assert.deepEqual(events.map(timelineText), [
    'Pull request !41 merged: Refunds',
    'Rita approved Release-8',
    'Release-8 started deploying to Production',
    'Release-8 deployed to Production',
    'Shop turned degraded',
    'Shop is still degraded',
  ]);
  assert.deepEqual(events[0].pr, { projectId: 'p1', repoId: 'r1', id: 41 });
  assert.equal(events.at(-2).bad, true);
  const failed = incidentTimeline({ monitor: { name: 'Shop', state: 'down' }, start: at(1), suspects: [deploy(8, 3, 'failed')], now: NOW });
  assert.deepEqual(failed.map((e) => e.kind), ['deployFailed', 'down', 'stillDown']);
});

/** An incident as the route sends it, with every section filled. */
const sample = () => ({
  monitor: { id: 'm1', name: 'Identity API', state: 'degraded', start: at(4), issues: [{ code: 'failures', severity: 'high', text: '7% of requests failing' }, { code: 'ai-error', severity: 'low', text: 'quiet' }] },
  active: true,
  environment: { key: 'release:p1:2:Production', name: 'Identity API', type: 'release', projectId: 'p1' },
  suspects: [{ id: 8, label: 'Release-8', at: at(6), webUrl: 'https://x/8', by: 'Ana', gapMs: 2 * H, approvals: [{ by: 'Rita', status: 'approved' }] }],
  shipped: {
    deployId: 8,
    pullRequests: [{ id: 41, title: 'Token refresh', author: 'Ana', webUrl: 'https://x/pr/41', risk: { score: 42, level: 'medium', reasons: [{ text: 'Changes CI or pipeline definitions ({files})', params: { files: 'ci.yml' }, points: 8 }] } }],
    workItems: [{ id: 4107, title: 'Sign-in fails' }],
    directCommits: [],
  },
  lastGood: { id: 7, label: 'Release-7', at: at(80), webUrl: 'https://x/7' },
  timeline: [{ at: at(6), text: TIMELINE.deployed, params: { label: 'Release-8', env: 'Identity API' } }, { at: at(4), text: TIMELINE.degraded, params: { monitor: 'Identity API' } }],
});

test('the incident as Markdown, for a post-incident write-up', () => {
  const md = incidentMarkdown(sample());
  assert.match(md, /^# Incident: Identity API\n/);
  assert.match(md, /- State: Degraded/);
  assert.match(md, /- 7% of requests failing/);
  assert.doesNotMatch(md, /quiet/, 'low-severity issues are left out');
  assert.match(md, /## Deploys just before\n\n- \[Release-8\]\(https:\/\/x\/8\) · .* · Ana · approved by Rita/);
  assert.match(md, /## What Release-8 shipped\n\n- \[!41\]\(https:\/\/x\/pr\/41\) Token refresh _\(Ana\)_ · risk 42\n {2}- Changes CI or pipeline definitions \(ci\.yml\)/);
  assert.match(md, /- Sign-in fails \(AB#4107\)/);
  assert.match(md, /## Timeline\n\n- .*: Release-8 deployed to Identity API\n- .*: Identity API turned degraded/);
  assert.match(md, /## Last good release\n\n- \[Release-7\]\(https:\/\/x\/7\)/);
  assert.ok(md.endsWith('\n'));
});

test('every sentence of the incident has its Portuguese', () => {
  for (const text of Object.values(TIMELINE)) assert.ok(pt[text], `no Portuguese for "${text}"`);
  // The Markdown's own sentences: whatever it asks to translate, for every kind of incident.
  const asked = new Set();
  const translate = (text, params) => {
    asked.add(text);
    return text.replace(/\{(\w+)\}/g, (_, k) => String(params?.[k] ?? ''));
  };
  incidentMarkdown(sample(), { translate });
  incidentMarkdown({ ...sample(), monitor: { ...sample().monitor, state: 'down' }, suspects: [], shipped: null, unlinked: true }, { translate });
  incidentMarkdown({ ...sample(), suspects: [], shipped: null }, { translate });
  for (const text of asked) assert.ok(pt[text], `no Portuguese for "${text}"`);
});

test('service: the incident joins the monitor, the deploys before it, what the latest shipped and how to go back', async () => {
  const commit = (id, hAgo, message) => ({ id, message, author: { name: 'Ana', email: 'ana@x', date: new Date(Date.now() - hAgo * H).toISOString() } });
  const base = Date.now();
  const ago = (h) => new Date(base - h * H).toISOString();
  const provider = {
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [{ id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'main' }],
    listReleases: async () => [{ id: 2, projectId: 'p1', projectName: 'Shop', name: 'Shop release', path: '\\', artifacts: [], stages: [{ id: 20, name: 'Production', rank: 1 }],
      releases: [{ id: 11, name: 'Release-11', createdOn: ago(50), stages: [{ id: 111, name: 'Production', status: 'succeeded', at: ago(48) }] }] }],
    listBuilds: async () => [],
    listDefinitions: async () => [],
    listDeployments: async () => [
      { id: 12, label: 'Release-12', at: ago(3), startedAt: ago(3.2), status: 'succeeded', repoId: 'r1', commit: 'c3', by: 'Ana' },
      { id: 11, label: 'Release-11', at: ago(48), status: 'succeeded', repoId: 'r1', commit: 'c1' },
    ],
    listCommitsBetween: async () => [commit('c3', 4, 'Merged PR 7: Faster tokens'), commit('c2', 5, 'Token cache')],
    getPullRequestCommitIds: async () => ['c2'],
    getWorkItems: async () => [],
    getDeployApprovals: async (target, id) => (id === 12 ? [{ by: 'Rita', at: ago(3.25), status: 'approved' }] : []),
    getPullRequest: async (projectId, repoId, id) => ({ key: `${projectId}/${repoId}/${id}`, projectId, repoId, id, title: 'Faster tokens', author: { displayName: 'Ana' }, targetBranch: 'main', reviewers: [] }),
    getPullRequestFiles: async () => ({ items: [{ path: '/src/auth/tokens.js' }] }),
    listCommits: async () => [],
  };
  const history = [{ at: ago(4), ok: true }, { at: ago(1), ok: false }, { at: ago(0.5), ok: false }];
  const monitor = { id: 'm1', name: 'Shop', url: 'https://shop', link: { type: 'release', projectId: 'p1', definitionId: 2, stage: 'Production' }, last: { at: ago(0.1), ok: false }, history, consecutiveFailures: 3, downSince: ago(4) };
  const monitoring = { status: () => [monitor, { id: 'm2', name: 'Fine', url: 'https://fine', link: null, last: { at: ago(0.1), ok: true, ms: 100 }, history: [{ at: ago(0.1), ok: true }], latencyWarnMs: 1500 }] };
  const service = createService({ provider, settings: memoryStore(), monitoring });

  const inc = await service.incident('m1');
  assert.equal(inc.active, true);
  assert.equal(inc.monitor.state, 'down');
  assert.equal(inc.monitor.start, ago(1), 'from the first failed check after the last good one');
  assert.deepEqual(inc.suspects.map((d) => [d.id, d.approvals.map((a) => a.by)]), [[12, ['Rita']]]);
  assert.deepEqual(inc.shipped.pullRequests.map((p) => p.id), [7]);
  assert.ok(inc.shipped.pullRequests[0].risk.reasons.some((r) => r.id === 'security'), 'each pull request comes with its risk');
  assert.equal(inc.lastGood.id, 11);
  assert.deepEqual(inc.redeploy, { kind: 'release', projectId: 'p1', releaseId: 11, environmentId: 111, label: 'Release-11', stage: 'Production', webUrl: null });
  assert.deepEqual(inc.timeline.map((e) => e.kind), ['merged', 'approved', 'deployStarted', 'deployed', 'down', 'stillDown']);

  assert.deepEqual(await service.incident('m2').then((x) => x.active), false, 'a monitor that is up has no incident');
  await assert.rejects(service.incident('nope'), /No such monitor/);
});

test('the Line: a down or degraded production app offers What broke? from its card', () => {
  const monitor = (id, state) => ({ id, name: id, state, url: `https://${id}`, last: { ms: 100 }, uptime24h: 1 });
  const line = buildLine({ production: { monitors: [monitor('a', 'down'), monitor('b', 'degraded'), monitor('c', 'up'), monitor('d', 'deploying')] } }, NOW);
  const live = line.find((s) => s.id === 'live').cards;
  assert.deepEqual(Object.fromEntries(live.map((c) => [c.title, c.incident])), { a: 'a', b: 'b', c: null, d: null });
});
