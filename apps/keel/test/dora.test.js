import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOW, buildDora, howText, isHotfix, isProduction, readHistory } from '../server/domain/dora.js';
import pt from '../client/src/locales/pt/dora.js';

test('every line saying how a measure was counted has its Portuguese', () => {
  for (const text of Object.values(HOW)) assert.ok(pt[text], `no Portuguese for "${text}"`);
});

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.parse('2026-11-01T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ann = { id: 'ann', uniqueName: 'ann@contoso.com', displayName: 'Ann' };
const bob = { id: 'bob', uniqueName: 'bob@contoso.com', displayName: 'Bob' };

// A deploy `daysAgo` days back, with one change by `who` whose first commit was `leadH` hours before.
const deploy = (id, daysAgo, { status = 'succeeded', commit = `c${id}`, who = ann, leadH = 10, prCreatedH = null } = {}) => {
  const ms = NOW - daysAgo * D;
  return {
    id, label: `Release-${id}`, at: iso(ms), status, commit, repoId: 'r1', branch: 'main',
    changes: status === 'succeeded' ? [{ kind: 'pr', id: id * 10, author: who, ...(prCreatedH != null ? { prCreatedAt: iso(ms - prCreatedH * H) } : { firstCommitAt: iso(ms - leadH * H) }) }] : [],
  };
};
const env = (deploys, extra = {}) => ({ key: 'release:p1:1:Production', name: 'Shop · Production', stage: 'Production', projectId: 'p1', projectName: 'Shop', deploys, ...extra });

test('production is a stage named like prod by default, or one of the configured names', () => {
  assert.equal(isProduction({ stage: 'Production' }), true);
  assert.equal(isProduction({ stage: 'QA' }), false);
  assert.equal(isProduction({ stage: 'QA', monitored: true }), true);
  assert.equal(isProduction({ name: 'shop-live' }), true);
  // Configured: only those names, the monitors' links included.
  assert.equal(isProduction({ stage: 'Production' }, 'Live-EU'), false);
  assert.equal(isProduction({ stage: 'live-eu' }, 'Live-EU, Live-US'), true);
  assert.equal(isProduction({ name: 'Shop · Live-US', monitored: true }, ['Live-US']), true);
  assert.equal(isProduction({ name: 'Shop API', monitored: true }, ['Live-US']), false);
});

test('a hotfix is a completed pull request named so, into a release branch or the deployed one', () => {
  const where = { projectId: 'p1', repoId: 'r1', branch: 'main' };
  const pr = { status: 'completed', projectId: 'p1', repoId: 'r1', sourceBranch: 'hotfix/vat', targetBranch: 'release/2.4', title: 'Fix VAT' };
  assert.equal(isHotfix(pr, where), true);
  assert.equal(isHotfix({ ...pr, targetBranch: 'main' }, where), true);
  assert.equal(isHotfix({ ...pr, targetBranch: 'develop' }, where), false);
  assert.equal(isHotfix({ ...pr, sourceBranch: 'feature/vat' }, where), false);
  assert.equal(isHotfix({ ...pr, sourceBranch: 'feature/vat', title: 'Hotfix: VAT rounding' }, where), true);
  assert.equal(isHotfix({ ...pr, repoId: 'r2' }, where), false);
  assert.equal(isHotfix({ ...pr, status: 'abandoned' }, where), false);
});

test('a lower id than the deploy before, or a commit production ran earlier, is a rollback', () => {
  const h = readHistory(env([deploy(10, 5), deploy(11, 4), deploy(10, 3.9), deploy(12, 2)]));
  assert.deepEqual(h.deploys.map((d) => d.rollback), [false, false, true, false]);
  // Release 11 was followed within a day by the rollback.
  assert.deepEqual(h.deploys[1].signals, ['rollback']);
  assert.deepEqual(h.incidents.map((i) => [i.kind, (i.end - i.start) / H]), [['rollback', 2.4]]);
  // Pipelines whose ids say nothing: the commit does.
  const byCommit = readHistory(env([deploy(1, 5, { commit: 'a' }), deploy(2, 4, { commit: 'b' }), deploy(3, 3, { commit: 'a' })]));
  assert.equal(byCommit.deploys[2].rollback, true);
  // A redeploy of the same build isn't going back.
  const same = readHistory(env([deploy(1, 5, { commit: 'a' }), deploy(2, 4, { commit: 'a' })]));
  assert.equal(same.deploys[1].rollback, false);
});

test('the four measures, their bands and how they were counted', () => {
  const deploys = [
    deploy(1, 20, { leadH: 5 }),
    deploy(2, 15, { leadH: 30 }),
    { ...deploy(3, 14.9, { status: 'failed' }) }, // 2.4h after release 2: a failed change
    deploy(4, 14.8, { leadH: 2 }), // restores it
    deploy(5, 8, { prCreatedH: 50 }),
    deploy(6, 2, { leadH: 1 }),
  ];
  const prs = [
    // A hotfix merged 6 hours after release 6, opened 2 hours before that; never deployed since.
    { status: 'completed', projectId: 'p1', repoId: 'r1', sourceBranch: 'hotfix/x', targetBranch: 'main', title: 'x', createdAt: iso(NOW - 2 * D + 4 * H), closedAt: iso(NOW - 2 * D + 6 * H) },
  ];
  const dora = buildDora({ environments: [env(deploys)], pullRequests: prs, days: 30, now: NOW });
  const all = dora.scopes[0];
  assert.equal(all.kind, 'all');
  const m = all.current;
  assert.equal(m.frequency.deploys, 5);
  assert.equal(m.frequency.band, 'high'); // weekly or more, not daily
  assert.equal(howText(m.frequency.how), '5 successful production deploys in 30 days (1.2 a week), to Shop · Production.');
  // Leads 5, 30, 2, 50 (from the pull request), 1: median 5.
  assert.equal(m.leadTime.hours, 5);
  assert.equal(m.leadTime.fromPr, 1);
  assert.equal(m.leadTime.band, 'elite');
  assert.match(howText(m.leadTime.how), /Median of 5 changes.*\(1 timed from the pull request opening/);
  // Release 2 (failed deploy after it) and release 6 (hotfix after it) of 5.
  assert.equal(m.failureRate.failed, 2);
  assert.equal(m.failureRate.rate, 2 / 5);
  assert.equal(m.failureRate.band, 'low');
  assert.equal(howText(m.failureRate.how), '2 of 5 production deploys were followed within 24h by a failed deploy (1), a rollback or redeploy of an older build (0) or a hotfix pull request (1).');
  // The failed deploy restored 2.4h later; the hotfix not yet.
  assert.equal(Math.round(m.restore.hours * 10) / 10, 2.4);
  assert.equal(m.restore.open, 1);
  assert.equal(m.restore.band, 'high');
  assert.match(howText(m.restore.how), /Median of 1 restores.*; 1 not restored yet\./);
});

test('the window is configurable, and a failure past it is not the deploy\'s', () => {
  const deploys = [deploy(1, 10), { ...deploy(2, 9, { status: 'failed' }) }, deploy(3, 8)];
  const wide = buildDora({ environments: [env(deploys)], days: 30, now: NOW, windowHours: 48 }).scopes[0].current;
  const narrow = buildDora({ environments: [env(deploys)], days: 30, now: NOW, windowHours: 12 }).scopes[0].current;
  assert.equal(wide.failureRate.failed, 1);
  assert.equal(narrow.failureRate.failed, 0);
  assert.match(howText(narrow.failureRate.how), /within 12h/);
});

test('the trend compares with the period before', () => {
  const deploys = [deploy(1, 50, { leadH: 100 }), deploy(2, 40, { leadH: 100 }), deploy(3, 20, { leadH: 2 }), deploy(4, 10, { leadH: 2 }), deploy(5, 5, { leadH: 2 }), deploy(6, 1, { leadH: 2 })];
  const all = buildDora({ environments: [env(deploys)], days: 30, now: NOW }).scopes[0];
  assert.equal(all.previous.frequency.deploys, 2);
  assert.equal(all.trend.frequency.direction, 'better');
  assert.equal(all.trend.leadTime.previous, 100);
  assert.equal(all.trend.leadTime.direction, 'better');
  assert.equal(all.trend.failureRate.direction, 'same');
});

test('per project, and per team by whose changes a deploy shipped', () => {
  const shop = env([deploy(1, 10, { who: ann, leadH: 4 }), deploy(2, 5, { who: bob, leadH: 40 }), { ...deploy(3, 4.9, { status: 'failed' }) }, deploy(4, 4.8, { who: bob })]);
  const billing = env([deploy(7, 3, { who: ann, leadH: 8 })], { key: 'release:p2:1:Prod', name: 'Billing · Prod', stage: 'Prod', projectId: 'p2', projectName: 'Billing' });
  const teams = [
    { key: 'p1:t1', name: 'Shop Team', projectId: 'p1', projectName: 'Shop', members: [ann] },
    { key: 'p1:t2', name: 'Payments', projectId: 'p1', projectName: 'Shop', members: [{ ...bob, id: 'other-org-id' }] },
  ];
  const dora = buildDora({ environments: [shop, billing], teams, days: 30, now: NOW });
  assert.deepEqual(dora.scopes.map((s) => [s.kind, s.name]), [['all', 'Everything'], ['project', 'Billing'], ['project', 'Shop'], ['team', 'Payments'], ['team', 'Shop Team']]);
  const by = (name) => dora.scopes.find((s) => s.name === name).current;
  assert.equal(by('Everything').frequency.deploys, 4);
  assert.equal(by('Shop').frequency.deploys, 3);
  assert.equal(by('Billing').frequency.deploys, 1);
  // Ann shipped release 1 in Shop (Billing isn't her team's project); Bob (matched by sign-in name), releases 2 and 4.
  assert.equal(by('Shop Team').frequency.deploys, 1);
  assert.equal(by('Shop Team').leadTime.hours, 4);
  assert.equal(by('Payments').frequency.deploys, 2);
  assert.equal(by('Payments').failureRate.failed, 1);
  assert.equal(by('Payments').restore.incidents, 1);
  assert.equal(by('Shop Team').failureRate.failed, 0);
  assert.equal(by('Shop Team').restore.incidents, 0);
});

test('only production counts, and says when there is none', () => {
  const qa = env([deploy(1, 3)], { name: 'Shop · QA', stage: 'QA', key: 'qa' });
  const none = buildDora({ environments: [qa], days: 30, now: NOW });
  assert.equal(none.production.environments.length, 0);
  assert.equal(howText(none.scopes[0].current.frequency.how), 'No successful production deploys in 30 days.');
  assert.equal(none.scopes[0].current.frequency.band, 'low');
  assert.equal(none.scopes[0].current.leadTime.band, null);
  const named = buildDora({ environments: [qa], days: 30, now: NOW, production: 'QA' });
  assert.equal(named.scopes[0].current.frequency.deploys, 1);
  assert.deepEqual(named.production.names, ['QA']);
});
