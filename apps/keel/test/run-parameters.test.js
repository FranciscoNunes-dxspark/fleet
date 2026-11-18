import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parameterValues, pipelineParameters } from '../server/domain/parameters.js';
import { createAzdoProvider } from '../server/azdo/provider.js';
import { createMockProvider } from '../server/mock/provider.js';
import { createMockGithub } from '../server/mock/github.js';
import { createService } from '../server/service.js';
import { DEFAULT_SETTINGS } from '../server/settings.js';
import { runArgs } from '../cli/actions.js';
import { parametersText } from '../cli/format.js';

const AZDO = `
parameters:
  - name: environment
    displayName: Deploy to
    type: string
    default: qa
    values:
      - qa
      - staging
      - production
  - name: verbose
    type: boolean
    default: false
  - name: retries
    type: number
    default: 2
  - name: region
    type: string
  - name: config
    type: object
    default: { a: 1 }
  - name: extraSteps
    type: stepList
    default: []
stages:
  - stage: Build
`;

test('Azure DevOps runtime parameters: every option of each, in order; steps and jobs left out', () => {
  assert.deepEqual(pipelineParameters(AZDO), [
    { name: 'environment', label: 'Deploy to', type: 'string', default: 'qa', options: ['qa', 'staging', 'production'], required: false },
    { name: 'verbose', label: 'verbose', type: 'boolean', default: 'false', options: ['true', 'false'], required: false },
    { name: 'retries', label: 'retries', type: 'number', default: '2', options: [], required: false },
    { name: 'region', label: 'region', type: 'string', default: null, options: [], required: true },
    { name: 'config', label: 'config', type: 'object', default: '{"a":1}', options: [], required: false },
  ]);
  assert.deepEqual(pipelineParameters('stages:\n  - stage: Build\n'), []);
  assert.deepEqual(pipelineParameters('not: [valid'), []);
  assert.deepEqual(pipelineParameters(''), []);
});

test('GitHub workflow_dispatch inputs: a choice lists its options, a boolean true and false', () => {
  const params = pipelineParameters(`
on:
  push:
  workflow_dispatch:
    inputs:
      target:
        description: Where to
        type: choice
        required: true
        options: [staging, production]
      dry_run:
        type: boolean
        default: false
      note:
        description: A note
`);
  assert.deepEqual(params, [
    { name: 'target', label: 'Where to', type: 'string', default: null, options: ['staging', 'production'], required: true },
    { name: 'dry_run', label: 'dry_run', type: 'boolean', default: 'false', options: ['true', 'false'], required: false },
    { name: 'note', label: 'A note', type: 'string', default: null, options: [], required: false },
  ]);
  assert.deepEqual(pipelineParameters('on: push\njobs: {}\n'), []);
});

test('parameter values: checked against the options, defaults not sent, mistakes name the options', () => {
  const params = pipelineParameters(AZDO);
  assert.deepEqual(parameterValues(params, { Environment: 'STAGING', verbose: 'True', retries: '2', region: 'eu' }), { environment: 'staging', verbose: 'true', region: 'eu' });
  assert.throws(() => parameterValues(params, { environment: 'dev', region: 'eu' }), /environment can't be "dev". Its options: qa, staging, production\./);
  assert.throws(() => parameterValues(params, { verbose: 'yes', region: 'eu' }), /true or false/);
  assert.throws(() => parameterValues(params, { retries: 'many', region: 'eu' }), /is a number/);
  assert.throws(() => parameterValues(params, { nope: '1' }), /no parameter "nope"\. Its parameters: environment, verbose, retries, region, config\./);
  assert.throws(() => parameterValues(params, { environment: 'qa' }), /region needs a value/);
});

test('/run reads name=value words, quoted ones too, apart from the branch and stages', () => {
  assert.deepEqual(runArgs('main -Test environment=staging note="two words" flag=', [{ id: 'Test', name: 'Test' }]), {
    branch: 'main', skip: ['Test'], unknown: [], params: { environment: 'staging', note: 'two words', flag: '' },
  });
});

test('/params lists every option, marking the default', () => {
  const text = parametersText(pipelineParameters(AZDO), 'main');
  assert.match(text, /environment {2}Deploy to\n {2}string, qa by default\n {2}● qa\n {2}○ staging\n {2}○ production/);
  assert.match(text, /region\n {2}string, needs a value\n {2}any value/);
  assert.match(text, /\/run main environment=staging/);
  assert.match(parametersText([]), /no parameters/);
});

test('Azure DevOps: parameters come from the YAML file on the branch, and go with the run through the Pipelines API', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = new URL(url);
    calls.push([opts.method || 'GET', u.pathname, Object.fromEntries(u.searchParams), opts.body ? JSON.parse(opts.body) : null]);
    if (u.pathname.endsWith('/items')) return new Response(AZDO, { status: 200, headers: { 'content-type': 'text/plain' } });
    const body = u.pathname.endsWith('/definitions/5')
      ? { id: 5, process: { type: 2, yamlFilename: 'ci/azure-pipelines.yml' }, repository: { id: 'r1', type: 'TfsGit', defaultBranch: 'refs/heads/main' } }
      : { id: 78, _links: { web: { href: 'https://x/run/78' } } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const provider = createAzdoProvider({ orgUrl: 'https://dev.azure.com/acme', pat: 'x' });
  const params = await provider.listPipelineParameters('p1', 5);
  assert.deepEqual(params.map((p) => p.name), ['environment', 'verbose', 'retries', 'region', 'config']);
  const file = calls.find((c) => c[1].endsWith('/items'));
  assert.equal(file[1], '/acme/p1/_apis/git/repositories/r1/items');
  assert.equal(file[2].path, '/ci/azure-pipelines.yml');
  assert.equal(file[2]['versionDescriptor.version'], 'main');
  calls.length = 0;
  await provider.queueBuild('p1', 5, 'main', { parameters: { environment: 'staging' } });
  assert.deepEqual(calls[0].slice(0, 2), ['POST', '/acme/p1/_apis/pipelines/5/runs']);
  assert.deepEqual(calls[0][3], { templateParameters: { environment: 'staging' }, resources: { repositories: { self: { refName: 'refs/heads/main' } } } });
});

test('demo: a CI pipeline lists its parameters, and a run takes the ones set', async () => {
  const provider = createMockProvider();
  const settings = { ...structuredClone(DEFAULT_SETTINGS), projects: { 'p-commerce': { name: 'Commerce', tracked: true, repos: 'all', teams: [] } } };
  const service = createService({ provider, settings: { load: async () => settings, save: async () => settings } });
  const row = (await service.pipelines()).find((p) => p.lastRun && /-CI$/.test(p.definition.name));
  const params = await service.pipelineParameters(row.projectId, row.definition.id);
  assert.deepEqual(params.find((p) => p.name === 'environment').options, ['qa', 'staging', 'uat', 'production']);
  assert.deepEqual(params.find((p) => p.name === 'logLevel').options, ['error', 'warn', 'info', 'debug', 'trace']);
  assert.ok(!params.some((p) => p.name === 'buildSteps'));
  await assert.rejects(service.queueBuild(row.projectId, row.definition.id, 'main', { parameters: { environment: 'moon' } }), /Its options: qa, staging, uat, production/);
  const queued = [];
  const spy = provider.queueBuild;
  provider.queueBuild = (...args) => {
    queued.push(args);
    return spy(...args);
  };
  await service.queueBuild(row.projectId, row.definition.id, 'main', { parameters: { environment: 'uat', logLevel: 'info' } });
  assert.deepEqual(queued[0][3], { parameters: { environment: 'uat' } });
});

test('demo GitHub: a workflow\'s inputs with their options, sent as inputs', async () => {
  const gh = createMockGithub();
  const defs = await gh.listDefinitions('gh-octo-demo');
  const deploy = defs.find((d) => d.name === 'Deploy');
  const params = await gh.listPipelineParameters('gh-octo-demo', deploy.id);
  assert.deepEqual(params.map((p) => [p.name, p.options]), [['environment', ['staging', 'production']], ['dry_run', ['true', 'false']]]);
  await gh.queueBuild('gh-octo-demo', deploy.id, 'main', { parameters: { environment: 'production' } });
  const ci = defs.find((d) => d.name === 'CI' && d.repoName === 'web-app');
  assert.deepEqual(await gh.listPipelineParameters('gh-octo-demo', ci.id), []);
});
