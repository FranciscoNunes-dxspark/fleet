import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REASONS, approvalTarget, judgeReadiness } from '../server/domain/readiness.js';
import { reasonText } from '../server/domain/risk.js';
import { createMockProvider } from '../server/mock/provider.js';
import { createService } from '../server/service.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';
import pt from '../client/src/locales/pt/readiness.js';

const ids = (r) => r.reasons.map((x) => x.id);
const target = (extra = {}) => ({ waiting: 3, workItems: [], ...extra });
const pipe = (name, health, branch = 'main') => ({ key: `p:${name}`, definition: { name }, branch, health });

test('nothing in the way is green, with no reasons', () => {
  const r = judgeReadiness({
    target: target({ workItems: [{ id: 1, stateCategory: 'Completed' }, { id: 2, stateCategory: 'Resolved' }] }),
    risks: [{ id: 7, score: 20 }],
    pipelines: [pipe('shop-ci', 'healthy')],
    monitors: [{ name: 'Shop', state: 'up' }],
  });
  assert.equal(r.verdict, 'green');
  assert.deepEqual(r.reasons, []);
});

test('something broken now is red, and its reasons come first', () => {
  const r = judgeReadiness({
    target: target({ workItems: [{ id: 4107, type: 'Bug', state: 'Active', stateCategory: 'InProgress' }] }),
    risks: [{ id: 7, score: 72 }],
    pipelines: [pipe('shop-ci', 'failing')],
    monitors: [{ name: 'Shop', state: 'down' }],
  });
  assert.equal(r.verdict, 'red');
  assert.deepEqual(ids(r), ['productionDown', 'pipelineFailing', 'riskHigh', 'workOpen']);
  assert.deepEqual(r.reasons.map((x) => x.tone), ['red', 'red', 'amber', 'amber']);
  assert.equal(reasonText(r.reasons[2]), '!7 going out is high risk: 72 of 100');
  assert.equal(reasonText(r.reasons[3]), 'Bug #4107 going out is still Active');
});

test('reasons to look twice are amber', () => {
  const r = judgeReadiness({
    target: target({ lastFailed: { id: 9, label: 'Release-41' }, workItems: [{ id: 1, stateCategory: 'Proposed' }, { id: 2, stateCategory: 'InProgress' }] }),
    risks: [{ id: 3, score: 61 }, { id: 5, score: 80 }, { id: 6, score: 10 }],
    pipelines: [pipe('shop-ci', 'unstable', 'release/1')],
    flaky: [{ shortName: 'CartTests.Total', pipeline: { name: 'shop-ci' } }, { shortName: 'CartTests.Vat', pipeline: { name: 'shop-ci' } }],
    advisories: [{ package: 'lodash', version: '4.17.20', severity: 'high' }, { package: 'qs', version: '6.0.0', severity: 'low' }],
    monitors: [{ name: 'Shop', state: 'degraded' }, { name: 'Admin', state: 'deploying' }],
    repo: 'storefront-web',
  });
  assert.equal(r.verdict, 'amber');
  assert.deepEqual(ids(r), ['productionDegraded', 'pipelineUnstable', 'advisoryHigh', 'lastFailed', 'riskHigh', 'workOpen', 'flaky']);
  const text = r.reasons.map(reasonText);
  assert.equal(text[1], 'shop-ci is unstable on release/1');
  assert.equal(text[2], 'lodash 4.17.20 in storefront-web has a new high-severity security advisory');
  assert.equal(text[3], 'The last deploy, Release-41, did not succeed');
  assert.equal(text[4], '2 pull requests going out are high risk, the highest !5 at 80 of 100');
  assert.equal(text[5], '2 work items going out are not done (#1, #2)');
  assert.equal(text[6], '2 flaky tests on shop-ci');
});

test('a new critical advisory is red, and several are counted', () => {
  const r = judgeReadiness({
    target: target(),
    advisories: [{ package: 'a', version: '1', severity: 'critical' }, { package: 'b', version: '2', severity: 'critical' }],
    repo: 'checkout-api',
  });
  assert.equal(r.verdict, 'red');
  assert.equal(reasonText(r.reasons[0]), '2 new critical security advisories in checkout-api');
});

test("a batch that couldn't be read says so, without judging what it can't see", () => {
  const r = judgeReadiness({ target: { unknown: true, workItems: [{ id: 1, stateCategory: 'Proposed' }] }, risks: [{ id: 3, score: 90 }] });
  assert.equal(r.verdict, 'green');
  assert.deepEqual(r.reasons.map((x) => [x.id, x.tone]), [['batchUnknown', 'info']]);
});

test('an approval matches the production environment it deploys to', () => {
  const targets = [
    { key: 'release:p1:4:Production', type: 'release', projectId: 'p1', definitionId: 4, stage: 'Production', definitionName: 'Shop' },
    { key: 'pipeline:p1:12', type: 'pipeline', projectId: 'p1', definitionId: 12, definitionName: 'storefront-web-CI' },
  ];
  const builds = [{ id: 900, definition: { id: 12 } }];
  assert.equal(approvalTarget({ kind: 'release', projectId: 'p1', definitionId: 4, stage: 'Production' }, targets), 'release:p1:4:Production');
  // Older answers without the definition's id are matched by its name.
  assert.equal(approvalTarget({ kind: 'release', projectId: 'p1', pipeline: 'Shop', stage: 'Production' }, targets), 'release:p1:4:Production');
  assert.equal(approvalTarget({ kind: 'release', projectId: 'p1', definitionId: 4, stage: 'QA' }, targets), null);
  assert.equal(approvalTarget({ kind: 'release', projectId: 'p1', definitionId: 4, stage: 'Production (after deployment)', postDeploy: true }, targets), null);
  assert.equal(approvalTarget({ kind: 'yaml', projectId: 'p1', stage: 'Deploy to Production', run: { id: 900 } }, targets, builds), 'pipeline:p1:12');
  assert.equal(approvalTarget({ kind: 'yaml', projectId: 'p1', stage: null, pipeline: 'storefront-web-CI', run: null }, targets, builds), 'pipeline:p1:12');
  // A pipeline's earlier stages aren't its production.
  assert.equal(approvalTarget({ kind: 'yaml', projectId: 'p1', stage: 'Deploy to QA', run: { id: 900 } }, targets, builds), null);
});

test('every reason has its Portuguese', () => {
  for (const text of Object.values(REASONS)) assert.ok(pt[text], `no Portuguese for "${text}"`);
});

test('the demo organization: each environment has a verdict, and the release approval its environment', async () => {
  let current = { ...structuredClone(DEFAULT_SETTINGS), projects: { 'p-commerce': { name: 'Commerce', tracked: true, repos: 'all', teams: [] } } };
  const settings = { load: async () => current, save: async (patch) => (current = { ...current, ...patch }) };
  const service = createService({ provider: createMockProvider(), settings });
  const r = await service.readiness();
  assert.ok(r.targets.length > 0);
  for (const x of r.targets) {
    assert.ok(['green', 'amber', 'red'].includes(x.verdict), x.verdict);
    for (const reason of x.reasons) assert.ok(Object.values(REASONS).includes(reason.text), reason.text);
  }
  const approvals = await service.approvals();
  const release = approvals.find((a) => a.kind === 'release');
  const mapped = r.approvals.find((a) => a.key === release.key);
  assert.ok(mapped, 'the release approval maps to an environment');
  assert.ok(r.targets.some((x) => x.key === mapped.targetKey));
});
