// The project's environments (.fleet/project.json, the kit's environments.js): /env, what Chart's section
// makes it run, and the lines a runbook's recording keeps.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRecording, recordedLines } from '@fleet/kit/recording.js';
import { readActivity, takeLine } from '@fleet/kit/family.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';
import { whatIfArgs } from '../src/actions.js';

let cleanup;
let home;
beforeEach(() => {
  cleanup = tempHome();
  home = process.env.CHART_HOME;
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);
const run = async (app, line) => {
  await type(app.stdin, line);
  app.stdin.write(KEYS.enter);
};

const SHOP = {
  default: 'dev',
  environments: {
    dev: { chart: { workspace: 'dev', varFile: 'env/dev.tfvars', resourceGroup: 'shop-dev', parametersFile: 'bicep/main.dev.bicepparam' } },
    prod: { prod: true, chart: { workspace: 'prod', varFile: 'env/prod.tfvars', resourceGroup: 'shop-prod' } },
  },
};

/** A project folder with its .fleet/project.json (and a .git, so the search for it stops there). */
function project(json = SHOP) {
  const root = join(home, 'shop');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.fleet'), { recursive: true });
  writeFileSync(join(root, '.fleet', 'project.json'), JSON.stringify(json));
  return root;
}

test("/env says which environment, and the plan runs with its workspace and var file; /env prod moves every app", async () => {
  const cwd = project();
  const app = start({ cwd });
  await until(shows(app, '/plan asks terraform'), 'the hint');
  assert.match(app.lastFrame(), /shop {2}dev {2}terraform/);
  await run(app, '/env');
  await until(shows(app, 'Environment: dev'), 'which one');
  assert.match(app.lastFrame(), /Chart: workspace dev, var file env\/dev\.tfvars, what-ifs into shop-dev/);
  await run(app, '/plan');
  await until(() => app.provider.calls.some((c) => c[0] === 'plan'), 'the plan');
  assert.deepEqual(app.provider.calls.find((c) => c[0] === 'plan')[4], { workspace: 'dev', varFile: 'env/dev.tfvars' });
  await until(shows(app, 'azurerm_mssql_database.reports'), 'the changes');
  await run(app, '/env prod');
  await until(shows(app, 'Environment: prod (production), for every app'), 'the switch');
  await until(() => /shop {2}prod {2}terraform/.test(app.lastFrame()), 'prod in the header');
  assert.ok(readActivity().some((e) => e.app === 'chart' && /Switched shop to prod \(production\)/.test(e.text)));
  await run(app, '/plan');
  await until(() => app.provider.calls.filter((c) => c[0] === 'plan').length === 2, 'the second plan');
  assert.deepEqual(app.provider.calls.filter((c) => c[0] === 'plan')[1][4], { workspace: 'prod', varFile: 'env/prod.tfvars' });
  await run(app, '/env staging');
  await until(shows(app, 'No environment staging: dev, prod.'), 'the refusal');
  app.unmount();
});

test("a what-if goes where the environment says, unless it's typed; the environment's group isn't kept as the last one", async () => {
  assert.deepEqual(whatIfArgs('', { found: { bicep: ['bicep/main.bicep'], params: [] }, env: SHOP.environments.dev.chart }), { file: 'bicep/main.bicep', resourceGroup: 'shop-dev', location: undefined, params: 'bicep/main.dev.bicepparam' });
  assert.equal(whatIfArgs('--rg other', { env: SHOP.environments.dev.chart, last: { file: 'a.bicep' } }).resourceGroup, 'other');
  assert.equal(whatIfArgs('--location westeurope', { env: SHOP.environments.dev.chart, last: { file: 'a.bicep' } }).resourceGroup, undefined);
  assert.equal(whatIfArgs('', { env: SHOP.environments.prod.chart, last: { file: 'a.bicep', resourceGroup: 'old' } }).resourceGroup, 'shop-prod');
  const cwd = project();
  const app = start({ cwd });
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/whatif');
  await until(() => app.provider.calls.some((c) => c[0] === 'whatIf'), 'the what-if');
  assert.equal(app.provider.calls.find((c) => c[0] === 'whatIf')[2].resourceGroup, 'shop-dev');
  await until(shows(app, 'into shop-dev'), 'the what-if done');
  const { loadConfig } = await import('../src/config.js');
  assert.equal(loadConfig().whatIf.resourceGroup, undefined);
  app.unmount();
});

test('while Fleet records a runbook, each slash command and /take line run goes in it, never a ! line', async () => {
  const cwd = project();
  startRecording(cwd);
  const app = start({ cwd });
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/tool tofu');
  await until(shows(app, 'Running tofu from now on'), 'the tool');
  await run(app, '!echo hi');
  await until(() => app.provider.calls.length >= 1 && app.lastFrame().includes('echo hi'), 'the shell command');
  await run(app, '/nonsense');
  await until(shows(app, 'Unknown command'), 'the unknown one');
  const line = takeLine('site', { name: 'shop-api' });
  await run(app, line);
  await until(shows(app, 'Locker'), "the context's owner");
  assert.deepEqual(recordedLines().map((l) => [l.app, l.line]), [['chart', '/tool tofu'], ['chart', line]]);
  app.unmount();
});

test("in production, /deploy wants the environment's name typed, then asks once more", async () => {
  const cwd = project();
  const app = start({ cwd });
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/env prod');
  await until(shows(app, 'Environment: prod'), 'the switch');
  await run(app, '/deploy');
  await until(shows(app, 'Type prod to deploy bicep/main.bicep into shop-prod (prod)'), 'the typed question');
  await type(app.stdin, 'prod');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'prod is production. Deploy bicep/main.bicep into shop-prod (prod)?'), 'the production question');
  app.stdin.write(KEYS.enter);
  await until(() => !app.lastFrame().includes('is production'), 'the answer');
  assert.ok(!app.provider.calls.some((c) => c[0] === 'deploy'), 'a bare ↵ is a No');
  app.unmount();
});
