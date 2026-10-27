// Keel in the family (the kit's family.js): the pure parts of what the terminal app hands Splice and Sonar
// (cli/kin.js), Pinch's mood, and how the server finds what carries a commit (server/domain/commits.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextIn } from '@fleet/kit/family.js';
import { compareForSonar, deploys, failureOf, familyChoices, familyMood, mineGone, newlyFailing, placeIn, prContext, reactionLine, reactionTo, runForSplice, sourcePath, timelineText } from '../cli/kin.js';
import { commitCarriers, reposNamed, sameCommit } from '../server/domain/commits.js';

test('a build agent\'s working folder comes off a path; anything else is left for Splice to match', () => {
  assert.equal(sourcePath('D:\\a\\1\\s\\src\\Shop.Api\\Orders.cs'), 'src/Shop.Api/Orders.cs');
  assert.equal(sourcePath('/home/vsts/work/1/s/src/orders.js'), 'src/orders.js');
  assert.equal(sourcePath('/__w/3/s/api/app.py'), 'api/app.py');
  assert.equal(sourcePath('/home/runner/work/shop/shop/src/a.ts'), 'src/a.ts');
  assert.equal(sourcePath('src/a.ts'), 'src/a.ts');
});

test('the place an error line names: stack frames, path:line, path(line,col); never a host and port', () => {
  assert.deepEqual(placeIn('    at place (/home/vsts/work/1/s/src/orders.js:42:7)'), { path: 'src/orders.js', line: 42 });
  assert.deepEqual(placeIn('   at Shop.Orders.Place() in D:\\a\\1\\s\\src\\Orders.cs:line 12'), { path: 'src/Orders.cs', line: 12 });
  assert.deepEqual(placeIn("src/pay.ts(17,5): error TS2322: Type 'string' is not assignable"), { path: 'src/pay.ts', line: 17 });
  assert.deepEqual(placeIn('FAIL test/orders.test.js:88 expected 3 got 2'), { path: 'test/orders.test.js', line: 88 });
  assert.equal(placeIn('Could not reach example.com:443 after 3 tries'), null);
  assert.equal(placeIn('npm ERR! version 1.2.3'), null);
  assert.equal(placeIn('at x (/app/node_modules/y/z.js:1:1)'), null);
});

const row = { projectId: 'p1', projectName: 'Shop', repoName: 'shop-api', definition: { id: 7, name: 'shop-ci' } };
const run = { id: 100, buildNumber: '20261027.3', commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' };

test("a failed run: its failed step's error, else its log's loud lines, names the file; else the commit goes", () => {
  const failed = {
    timeline: [
      { id: 's', type: 'Stage', name: 'Build', result: 'failed' },
      { id: 't', type: 'Task', name: 'Run tests', result: 'failed', issues: [{ type: 'error', message: 'Process completed with exit code 1.' }] },
    ],
    logs: { t: 'ok 1 - places\nnot ok 2 - refunds\n  Error: expected 3\n    at refund (/home/vsts/work/1/s/src/refunds.js:31:9)\n' },
    changes: [{ id: run.commit, message: 'Refunds in full\n\nAnd more' }],
  };
  assert.deepEqual(failureOf(failed), { step: 'Run tests', message: 'at refund (/home/vsts/work/1/s/src/refunds.js:31:9)', path: 'src/refunds.js', line: 31 });
  assert.deepEqual(contextIn(runForSplice(row, run, failed).line), { kind: 'file', data: { path: 'src/refunds.js', line: 31 } });
  const vague = { ...failed, logs: { t: 'Error: something went wrong' } };
  assert.deepEqual(contextIn(runForSplice(row, run, vague).line), { kind: 'commit', data: { repo: 'shop-api', hash: run.commit, subject: 'Refunds in full' } });
  assert.equal(runForSplice(row, run, vague).failure.step, 'Run tests');
  // A run that passed hands its commit; one with neither a place nor a commit hands nothing.
  assert.equal(failureOf({ timeline: [{ id: 't', type: 'Task', name: 'Build', result: 'succeeded' }] }), null);
  assert.deepEqual(contextIn(runForSplice(row, run, { timeline: [] }).line).data.subject, 'shop-ci 20261027.3');
  assert.equal(runForSplice(row, { ...run, commit: null }, { timeline: [] }), null);
});

test('a pull request as a context, and which pipelines deploy', () => {
  const pr = { org: 'contoso', projectName: 'Shop', repoName: 'shop-api', id: 817, title: 'Refunds', sourceBranch: 'refs/heads/feature/refunds', targetBranch: 'main', webUrl: 'https://x/pr/817', reviewers: [] };
  assert.deepEqual(prContext(pr), { org: 'contoso', project: 'Shop', repo: 'shop-api', id: 817, title: 'Refunds', sourceBranch: 'feature/refunds', targetBranch: 'main', url: 'https://x/pr/817' });
  assert.equal(deploys(row, [{ targetKey: 'pipeline:p1:7' }]), true);
  assert.equal(deploys(row, []), false);
  assert.equal(deploys({ ...row, definition: { id: 8, name: 'shop-deploy' } }, []), true);
});

test("a monitor's failures-up issue gives Sonar's /compare-window at its deploy; else its latest deploy", () => {
  const deploy = { label: 'Release-65', at: '2026-10-27T09:30:12.345Z' };
  const m = { name: 'Shop', issues: [{ code: 'slow', text: 'Slow' }, { code: 'deploy-regression', text: 'Failures up from 1% to 9% since Release-65 (2h ago)', deploy }], markers: [{ label: 'Release-66', at: '2026-10-27T11:00:00Z' }] };
  assert.deepEqual(compareForSonar(m), { deploy, issue: m.issues[1], line: '/compare-window 2026-10-27T09:30:12Z' });
  assert.equal(compareForSonar({ ...m, issues: [] }).line, '/compare-window 2026-10-27T11:00:00Z');
  assert.equal(compareForSonar({ ...m, issues: [], markers: [] }), null);
});

test("Pinch's mood for the family: down beats a pipeline that started failing beats busy beats a merge", () => {
  const data = { prs: [{}], pipelines: [{ health: 'failing' }, { health: 'healthy' }], production: { monitors: [{ name: 'Shop', state: 'up' }] } };
  assert.deepEqual(familyMood({ data }), { mood: 'neutral', reason: 'watching 1 pull request and 2 pipelines, 1 failing' });
  assert.deepEqual(familyMood({ data, merged: 'your pull request !8 merged' }), { mood: 'happy', reason: 'your pull request !8 merged' });
  assert.deepEqual(familyMood({ data, merged: 'x', busy: { label: 'Approving' } }), { mood: 'busy', reason: 'Approving' });
  assert.deepEqual(familyMood({ data, busy: { label: 'x' }, alarm: 'shop-ci started failing' }), { mood: 'worried', reason: 'shop-ci started failing' });
  const down = { ...data, production: { monitors: [{ name: 'Shop', state: 'down' }, { name: 'Admin', state: 'down' }] } };
  assert.deepEqual(familyMood({ data: down, alarm: 'x' }), { mood: 'worried', reason: 'Shop is down (and 1 more)' });
  assert.equal(familyMood({ data: {} }).mood, 'busy');
});

test('what changed between two reads: pipelines that started failing, your pull requests that left', () => {
  const p = (key, health) => ({ key, health, definition: { name: key } });
  assert.deepEqual(newlyFailing(null, [p('a', 'failing')]), []);
  assert.deepEqual(newlyFailing([p('a', 'failing'), p('b', 'healthy')], [p('a', 'failing'), p('b', 'failing')]).map((r) => r.key), ['b']);
  const pr = (key, isMine) => ({ key, isMine });
  assert.deepEqual(mineGone([pr('1', true), pr('2', false), pr('3', true)], [pr('3', true)]).map((x) => x.key), ['1']);
  assert.deepEqual(mineGone(null, []), []);
});

test("Pinch's word on the siblings, /family's lines and /timeline's text", () => {
  const moods = [{ app: 'sonar', mood: 'neutral', reason: 'x', at: 3 }, { app: 'splice', mood: 'happy', reason: 'PR #12 merged', at: 2 }];
  const m = reactionTo(moods, new Set());
  assert.equal(reactionLine(m), 'Twig says: PR #12 merged');
  assert.equal(reactionTo(moods, new Set(['splice|2'])), null);
  const choices = familyChoices({ dir: '/w/shop', repo: '/w/shop', crew: true, httpFiles: ['/w/shop/api/orders.http'], databases: [] });
  assert.deepEqual(choices.map((c) => [c.app, c.line]), [['splice', '/open /w/shop'], ['bosun', '/move /w/shop'], ['hail', '/open /w/shop/api/orders.http']]);
  const now = 10 * 3600_000;
  assert.equal(timelineText([{ at: now - 120_000, app: 'keel', text: 'Approve !817 Refunds in shop-api' }, { at: now - 7200_000, app: 'splice', text: 'pushed main', project: '/w/shop' }], now), '  2m  Keel    Approve !817 Refunds in shop-api\n  2h  Splice  pushed main  (shop)');
  assert.match(timelineText([]), /Nothing logged yet/);
});

test('Family moods is a setting of this computer, on unless KEEL_FAMILY_MOODS turns it off', async () => {
  const { familyMoodsOn, settingsRows } = await import('../cli/settings.js');
  assert.equal(familyMoodsOn({}), true);
  assert.equal(familyMoodsOn({ KEEL_FAMILY_MOODS: '0' }), false);
  const row = settingsRows({ view: { settings: { projects: {}, thresholds: {}, autoComplete: {} }, projects: [] }, local: { env: { KEEL_FAMILY_MOODS: 'off' } } }).find((r) => r.kind === 'familyMoods');
  assert.equal(row.on, false);
  assert.equal(row.section, 'computer');
});

test("through your team's Keel, a commit is looked up at /api/commits/<hash>/carriers", async () => {
  const { remoteService } = await import('../cli/remote.js');
  const calls = [];
  const service = remoteService({ call: async (path) => (calls.push(path), { prs: [], runs: [] }) });
  await service.commitUsage('abc1234', { repo: 'shop api' });
  await service.commitUsage('abc1234');
  assert.deepEqual(calls, ['/commits/abc1234/carriers?repo=shop%20api', '/commits/abc1234/carriers']);
});

test('what carries a commit: runs that built it, pull requests that brought or merged it', () => {
  const hash = 'a1b2c3d4e5f6';
  assert.equal(sameCommit('A1B2C3D4E5F60718', hash), true);
  assert.equal(sameCommit('a1b2c3d', 'a1b2c3d4e5f6'), true);
  assert.equal(sameCommit('a1b2c3', 'a1b2c3'), false);
  assert.equal(sameCommit(null, hash), false);
  const repos = [{ id: 'r1', name: 'shop-api' }, { id: 'r2', name: 'admin' }];
  assert.deepEqual(reposNamed(repos, 'Shop-API').map((r) => r.id), ['r1']);
  assert.deepEqual(reposNamed(repos, 'elsewhere').map((r) => r.id), ['r1', 'r2']);
  const builds = [
    { id: 1, commit: 'a1b2c3d4e5f60718', queuedAt: '2026-10-26T10:00:00Z', definition: { id: 7, name: 'ci' } },
    { id: 2, commit: 'ffffffffffff', queuedAt: '2026-10-27T10:00:00Z', definition: { id: 7, name: 'ci' } },
    { id: 3, commit: 'a1b2c3d4e5f60718', queuedAt: '2026-10-27T10:00:00Z', definition: { id: 8, name: 'deploy' } },
  ];
  const prs = [
    { key: 'p/r1/1', id: 1, status: 'active', createdAt: '2026-10-20T00:00:00Z' },
    { key: 'p/r1/2', id: 2, status: 'completed', mergeCommit: 'a1b2c3d4e5f60718', createdAt: '2026-10-01T00:00:00Z', closedAt: '2026-10-25T00:00:00Z' },
    { key: 'p/r1/3', id: 3, status: 'active', createdAt: '2026-10-21T00:00:00Z' },
  ];
  const found = commitCarriers({ hash, builds, prs, prCommits: new Map([['p/r1/1', ['a1b2c3d4e5f60718', 'beef']], ['p/r1/3', ['beef']]]) });
  assert.deepEqual(found.runs.map((b) => b.id), [3, 1]);
  assert.deepEqual(found.prs.map((p) => p.id), [2, 1]);
});
