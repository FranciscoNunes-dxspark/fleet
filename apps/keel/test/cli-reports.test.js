// The terminal app's reports in the viewer (cli/reports.js): /insights, /flaky, /closed, /commits
// and /totals, as text, and one of them on the demo organization end to end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-reports-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');
const { closedText, commitsText, dur, figureLabel, flakyText, insightsText, sparkline, totalsText } = await import('../cli/reports.js');
const { parseDaysArg } = await import('../cli/actions.js');

let keel;
before(() => {
  keel = openKeel();
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

let lastApp = null;
const frame = () => lastApp.lastFrame() ?? '';
async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame()}`);
}
const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const now = Date.parse('2026-10-21T12:00:00Z');

test('durations, bars and day counts read as people say them', () => {
  assert.deepEqual([dur(0.25), dur(5.2), dur(38.5), dur(72), dur(null)], ['15m', '5h', '39h', '3.0d', '–']);
  assert.equal(sparkline([0, 5, 10]), '▁▅█');
  assert.deepEqual([parseDaysArg('', 30, 7, 180), parseDaysArg('14', 30, 7, 180), parseDaysArg('14d', 30, 7, 180), parseDaysArg('3', 30, 7, 180), parseDaysArg('x', 30, 7, 180)], [30, 14, 14, null, null]);
});

test('/insights: pull request flow, then delivery to production with its DORA bands', () => {
  const ins = {
    days: 30,
    totals: { merged: 38, abandoned: 3, activePrs: 33, medianCycleHours: 38.5, p85CycleHours: 99, medianOpenAgeHours: 70, buildPassRate: 0.79, reviewersActive: 8 },
    weekly: [{ week: '2026-10-05', merged: 4 }, { week: '2026-10-12', merged: 8 }],
    openAge: [{ label: '< 1 day', count: 7 }],
    byRepo: [{ projectName: 'Shop', repoName: 'api', count: 7, medianCycleHours: 42, p85CycleHours: 92 }],
    byAuthor: [{ person: { displayName: 'Ana' }, count: 8, medianCycleHours: 40 }],
    byReviewer: [{ person: { displayName: 'Bo' }, count: 9 }],
  };
  const del = {
    days: 30,
    totals: { deploys: 59, failed: 4, deploysPerWeek: 13.77, medianLeadTimeHours: 31.6, failureRate: 0.063, medianRecoveryHours: 34 },
    bands: { frequency: 'elite', leadTime: 'high', failureRate: 'high', recovery: 'medium' },
    weekly: [{ week: '2026-10-12', deploys: 9, failed: 1 }],
    targets: [{ name: 'Shop (production)', projectName: 'Shop', deploys: 12, failed: 1, failureRate: 0.08, medianLeadTimeHours: 28, medianRecoveryHours: null, unrecovered: 0, lastDeploy: { label: 'Release-57', status: 'succeeded', at: '2026-10-21T09:00:00Z' } }],
  };
  const text = insightsText(ins, del, now);
  assert.match(text, /^The last 30 days\n\nPull requests\n {2}38 merged · 3 abandoned · 33 open now\n {2}Open to merged: half within 39h, 85% within 4\.1d/);
  assert.match(text, /Merged each week {2}▅█ {2}5 Oct 4 · 12 Oct 8/);
  assert.match(text, /Shop \/ api: 7 · 42h · 3\.8d/);
  assert.match(text, /Reviews done: Bo 9/);
  assert.match(text, /Deploys: 59, 13\.8 a week {2}\(elite\)/);
  assert.match(text, /Change failure rate: 6% \(4 failed\) {2}\(high\)/);
  assert.match(text, /Shop \(production\) \(Shop\): 12 deploys, 1 failed \(8%\) · lead 28h · restore – · last Release-57 ✓ 3h ago/);
});

test('/flaky, /closed and /commits', () => {
  const flaky = flakyText({ days: 14, analyzed: { runs: 20, pipelines: 2, unreadable: 0 }, tests: [{ shortName: 'Orders.Times_out', failingNow: true, pipeline: { name: 'api-CI', projectName: 'Shop', branch: 'main' }, fails: 5, runs: 19, failRate: 0.26, flips: 8, sameCommit: true, lastFailedAt: '2026-10-21T11:00:00Z', lastFailedRun: { buildNumber: '20261021.2' }, error: 'Timeout\nstack' }] }, now);
  assert.match(flaky, /^1 flaky test in the last 14 days · 20 runs of 2 pipelines read\n\n✗ failing now {2}Orders\.Times_out\n {2}api-CI \(Shop\) on main · failed 5 of 19 runs \(26%\) · flipped 8 times · passed again on the same commit\n {2}Last failed 1h ago in 20261021\.2\n {2}Timeout$/);
  assert.match(flakyText({ noTestData: true }), /No test results/);

  const closed = closedText({ days: 7, prs: [
    { id: 1, title: 'Old', status: 'abandoned', createdAt: '2026-10-19T00:00:00Z', closedAt: '2026-10-20T00:00:00Z', projectName: 'Shop', repoName: 'api', sourceBranch: 'a', targetBranch: 'main', reviewers: [] },
    { id: 2, title: 'New', status: 'completed', createdAt: '2026-10-21T06:00:00Z', closedAt: '2026-10-21T11:00:00Z', projectName: 'Shop', repoName: 'api', sourceBranch: 'refs/heads/b', targetBranch: 'refs/heads/main', author: { displayName: 'Ana' }, closedBy: { displayName: 'Bo' }, reviewers: [{ displayName: 'Bo', vote: 10 }] },
  ] }, now);
  assert.match(closed, /^2 pull requests closed in the last 7 days: 1 completed, 1 abandoned\n\n✓ !2 New\n {2}Shop \/ api · b → main · by Ana\n {2}Completed 1h ago by Bo · open 5h · ✓ Bo\n\n⊘ !1 Old/);

  const commits = commitsText({ days: 2, commits: [
    { id: 'abcdef1234', subject: 'Fix totals', repoName: 'api', author: { name: 'Ana' }, committedAt: '2026-10-21T10:00:00Z', prId: 7, workItemIds: [41] },
    { id: '1234567890', subject: 'Older', repoName: 'web', author: { name: 'Bo' }, committedAt: '2026-10-20T10:00:00Z', workItemIds: [] },
  ] }, now);
  assert.match(commits, /^2 commits in the last 2 days, on each repo's default branch\n\nWednesday 21 October\n {2}abcdef1 Fix totals\n {10}api · Ana · 2h ago · !7 #41\n\nTuesday 20 October\n {2}1234567 Older/);
});

test('/totals: the key figures first, with the change since the fetch before, then each area', () => {
  const sites = [{
    name: 'Berlin',
    latest: { at: '2026-10-21T11:00:00Z', product: 'WebShopSite', site: 'berlin', version: '1.0', season: { id: 's1', name: '2026/2027' }, failing: [{ type: 'injuries', error: 'timeout' }], totals: [
      { type: 'usersAll', areas: ['administration'], total: 1629 },
      { type: 'players', areas: ['administration'], total: 898 },
      { type: 'workSessions', areas: ['training'], total: 4146 },
    ] },
    previous: { seasonId: 's1', values: { players: 890, usersAll: 1629, workSessions: 4100 } },
  }];
  const text = totalsText(sites, now);
  assert.match(text, /^Berlin\n {2}WebShopSite · berlin · v1\.0 · season 2026\/2027 · fetched 1h ago/);
  assert.match(text, /✗ Couldn't count: Injuries \(timeout\)/);
  assert.match(text, /\n {2}Players 898 \(\+8\) · All users 1,629\n {2}Administration: \n?|\n {2}Training: Work sessions 4,146 \(\+46\)/);
  assert.equal(figureLabel('selfPerceptionQuestionnaires'), 'Self perception questionnaires');
  assert.match(totalsText([]), /No sites report platform totals yet/);
});

test('/insights opens in the viewer on the demo organization', async () => {
  lastApp = render(React.createElement(App, { keel, poll: false, openUrl: () => {} }));
  const app = lastApp;
  try {
    await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
    app.stdin.write('/');
    await type(app.stdin, 'insights 14');
    app.stdin.write('\r');
    await until(() => frame().includes('Insights, the last 14 days') && frame().includes('Pull requests'), 'the insights');
    assert.match(frame(), /merged · \d+ abandoned/);
    // Delivery to production comes after, further down.
    app.stdin.write('G');
    await until(() => frame().includes('By environment') || frame().includes('Time to restore'), 'the delivery measures');
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Insights, the last 14 days'), 'the viewer closed');
    app.stdin.write('/');
    await type(app.stdin, 'commits nothing-like-it');
    app.stdin.write('\r');
    await until(() => frame().includes('No commits in the last 7 days in a tracked repo'), 'the empty search');
  } finally {
    app.unmount();
  }
});
