import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stagesOf, stagesToSkip } from '../server/domain/pipelines.js';
import { createAzdoProvider } from '../server/azdo/provider.js';
import { createMockProvider } from '../server/mock/provider.js';
import { createService } from '../server/service.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';
import { runArgs } from '../cli/actions.js';

const STAGES = [{ id: 'Build', name: 'Build' }, { id: 'Test', name: 'Unit tests' }, { id: 'DeployQA', name: 'Deploy to QA' }];

test('a pipeline\'s stages come from its run\'s timeline, in order, without the hidden default stage', () => {
  assert.deepEqual(stagesOf([
    { type: 'Stage', identifier: 'Test', name: 'Unit tests', order: 2 },
    { type: 'Job', identifier: 'Build.job', name: 'Job', order: 1 },
    { type: 'Stage', identifier: 'Build', name: 'Build', order: 1 },
  ]), [{ id: 'Build', name: 'Build' }, { id: 'Test', name: 'Unit tests' }]);
  assert.deepEqual(stagesOf([{ type: 'Stage', identifier: '__default', name: '__default', order: 1 }]), []);
});

test('stages to skip: known ones once each, and never all of them', () => {
  assert.deepEqual(stagesToSkip(STAGES, ['Test', 'Test', 'Nope']), ['Test']);
  assert.deepEqual(stagesToSkip(STAGES, []), []);
  assert.throws(() => stagesToSkip(STAGES, ['Build', 'Test', 'DeployQA']), /at least one stage/);
});

test('/run reads the branch and the stages after a minus, by either name', () => {
  assert.deepEqual(runArgs('', STAGES), { branch: '', skip: [], unknown: [] });
  assert.deepEqual(runArgs('release/1.2 -deploy-to-qa -TEST -Test', STAGES), { branch: 'release/1.2', skip: ['DeployQA', 'Test'], unknown: [] });
  assert.deepEqual(runArgs('-Lint', STAGES), { branch: '', skip: [], unknown: ['Lint'] });
});

test('Azure DevOps: skipping stages goes through the Pipelines API; a plain run stays on the Build API', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = new URL(url);
    calls.push([opts.method || 'GET', u.pathname, opts.body ? JSON.parse(opts.body) : null]);
    const body = u.pathname.endsWith('/timeline')
      ? { records: [{ type: 'Stage', identifier: 'Build', name: 'Build', order: 1 }, { type: 'Stage', identifier: 'Deploy', name: 'Deploy', order: 2 }] }
      : u.pathname.endsWith('/_apis/build/builds') && (opts.method || 'GET') === 'GET' ? { value: [{ id: 9 }] }
        : { id: 77, _links: { web: { href: 'https://x/run/77' } } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const provider = createAzdoProvider({ orgUrl: 'https://dev.azure.com/acme', pat: 'x' });
  assert.deepEqual(await provider.listPipelineStages('p1', 5), [{ id: 'Build', name: 'Build' }, { id: 'Deploy', name: 'Deploy' }]);
  calls.length = 0;
  assert.deepEqual(await provider.queueBuild('p1', 5, 'main', { skipStages: ['Deploy'] }), { id: 77, webUrl: 'https://x/run/77' });
  assert.deepEqual(calls[0], ['POST', '/acme/p1/_apis/pipelines/5/runs', { stagesToSkip: ['Deploy'], resources: { repositories: { self: { refName: 'refs/heads/main' } } } }]);
  await provider.queueBuild('p1', 5, 'main');
  assert.equal(calls[1][1], '/acme/p1/_apis/build/builds');
});

test('demo: a run without a stage shows it skipped, and skipping every stage is refused', async () => {
  const provider = createMockProvider();
  const settings = { ...structuredClone(DEFAULT_SETTINGS), projects: { 'p-commerce': { name: 'Commerce', tracked: true, repos: 'all', teams: [] } } };
  const service = createService({ provider, settings: { load: async () => settings, save: async () => settings } });
  const row = (await service.pipelines()).find((p) => p.lastRun);
  const stages = await service.pipelineStages(row.projectId, row.definition.id);
  assert.deepEqual(stages.map((s) => s.id), ['Build', 'Test', 'DeploytoQA']);
  await assert.rejects(service.queueBuild(row.projectId, row.definition.id, 'main', { skipStages: stages.map((s) => s.id) }), /at least one stage/);
  const run = await service.queueBuild(row.projectId, row.definition.id, 'main', { skipStages: ['DeploytoQA'] });
  const { timeline } = await service.runDetails(row.projectId, run.id);
  const stage = (name) => timeline.find((r) => r.type === 'Stage' && r.name === name);
  assert.equal(stage('Deploy to QA').result, 'skipped');
  assert.notEqual(stage('Build').result, 'skipped');
});
