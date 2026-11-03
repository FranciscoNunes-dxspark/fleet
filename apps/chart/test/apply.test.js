// Applying, deliberately: only a plan file Chart saved itself, what it does shown first, the name of
// where it goes typed, production asked once more; its output as it comes, and the activity logged.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readActivity } from '@fleet/kit/family.js';
import { createChart } from '../src/iac.js';
import { DEMO_PLAN } from '../src/demo.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

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

/** A fake run that writes the plan file terraform would, and answers show -json with the demo plan. */
function fakeTerraform() {
  const calls = [];
  const run = async (command, opts) => {
    calls.push({ command, env: opts?.env });
    const out = /-out="([^"]+)"/.exec(command);
    if (out) writeFileSync(out[1], 'a plan');
    if (/show -json/.test(command)) return { stdout: JSON.stringify(DEMO_PLAN), stderr: '' };
    if (/workspace show/.test(command)) return { stdout: 'staging\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const streamed = [];
  const stream = async (command, opts) => {
    streamed.push({ command, env: opts.env });
    if (stream.fail) throw new Error(stream.fail);
    opts.onLine?.('Apply complete!');
    return { stdout: 'Apply complete!', stderr: '' };
  };
  return { run, stream, calls, streamed };
}

test('the provider keeps a plan it was asked to keep, in a folder of its own, and applies only that file, once', async () => {
  const t = fakeTerraform();
  const chart = createChart({ run: t.run, stream: t.stream });
  const p = await chart.plan('/srv/infra', { keep: true, workspace: 'prod', varFile: 'env/prod.tfvars' });
  assert.ok(p.planFile && existsSync(p.planFile));
  assert.match(t.calls[0].command, /^terraform plan -input=false -lock=false -no-color -var-file="env\/prod\.tfvars" -out="[^"]+chart-plans-[^"]+"$/);
  assert.deepEqual(t.calls[0].env, { TF_WORKSPACE: 'prod' });
  if (process.platform !== 'win32') assert.equal(statSync(dirname(p.planFile)).mode & 0o077, 0, 'only this user reads the folder');
  await assert.rejects(chart.apply('/srv/infra', { planFile: join(dirname(p.planFile), 'other.tfplan') }), /applies only a plan it saved itself/);
  const lines = [];
  await chart.apply('/srv/infra', { planFile: p.planFile, workspace: 'prod', onLine: (l) => lines.push(l) });
  assert.match(t.streamed[0].command, /^terraform apply -input=false -no-color "[^"]+\.tfplan"$/);
  assert.deepEqual(t.streamed[0].env, { TF_WORKSPACE: 'prod' });
  assert.deepEqual(lines, ['Apply complete!']);
  assert.equal(existsSync(p.planFile), false, 'an applied plan is gone');
  await assert.rejects(chart.apply('/srv/infra', { planFile: p.planFile }), /applies only a plan it saved itself/, 'and never applied twice');
  const q = await chart.plan('/srv/infra', { keep: true });
  t.stream.fail = 'Error: Saved plan is stale\n\nThe given plan file can no longer be applied because the state was changed by another operation after the plan was created.';
  await assert.rejects(chart.apply('/srv/infra', { planFile: q.planFile }), /The plan is stale: the state changed after Chart planned, so terraform applied nothing\. \/plan again/);
  const plain = await chart.plan('/srv/infra');
  assert.equal(plain.planFile, undefined, 'without keep, nothing stays');
  assert.equal(await chart.workspace('/srv/infra'), 'staging');
  assert.equal(await chart.workspace('/srv/infra', { workspace: 'prod' }), 'prod');
  await assert.rejects(chart.plan('/x', { workspace: 'prod; rm -rf ~' }), /isn't a workspace name/);
  const r = await chart.plan('/srv/infra', { keep: true });
  chart.cleanup();
  assert.equal(existsSync(r.planFile), false, 'closing removes what was kept');
});


test('/apply shows what it does, destroys first, and applies only once the workspace is typed; its output goes to the log', async () => {
  const app = start();
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/apply');
  await until(shows(app, 'No plan to apply'), 'the refusal');
  await run(app, '/plan');
  await until(shows(app, 'cost +$219/month'), 'the plan, priced');
  const planned = app.provider.calls.find((c) => c[0] === 'plan');
  assert.ok(planned);
  await run(app, '/apply');
  await until(shows(app, 'Type default to apply this plan to infra (workspace default)'), 'the question');
  const frame = app.lastFrame();
  assert.ok(frame.indexOf('Destroyed:') < frame.indexOf('Replaced (destroyed, then created again):'));
  assert.ok(frame.indexOf('Replaced') < frame.indexOf('Changed in place:'));
  assert.ok(frame.indexOf('Changed in place:') < frame.indexOf('Created:'));
  assert.match(frame, /- azurerm_mssql_database\.reports {2}\(it is no longer in the configuration\) {2}-\$15\/month/);
  await type(app.stdin, 'prod');
  app.stdin.write(KEYS.enter);
  await until(shows(app, "That isn't default: nothing was applied."), 'the wrong name');
  assert.ok(!app.provider.calls.some((c) => c[0] === 'apply'));
  await run(app, '/apply');
  await until(shows(app, 'Type default to apply'), 'the question again');
  await type(app.stdin, 'default');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'azurerm_mssql_database.reports: Destruction complete'), 'the output');
  const call = app.provider.calls.find((c) => c[0] === 'apply');
  assert.match(call[2].planFile, /^demo-plans\/chart-1\.tfplan$/);
  await until(() => readActivity().some((e) => /^Applied/.test(e.text)), 'the activity');
  const applied = readActivity().find((e) => /^Applied/.test(e.text));
  assert.equal(applied.text, 'Applied infra (workspace default): +2 ~2 ±1 -1');
  assert.equal(applied.kind, 'change');
  await until(shows(app, '/plan asks terraform'), 'the plan gone from the screen');
  app.unmount();
});

test("/apply refuses a plan opened from a file, and a stale one says so; a newer plan's file replaces the last", async () => {
  const app = start();
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/open plan.json');
  await until(shows(app, 'azurerm_mssql_database.reports'), 'the plan read');
  await run(app, '/apply');
  await until(shows(app, 'applies only a plan Chart made and saved itself'), 'the refusal');
  await run(app, '/plan');
  await until(() => app.provider.calls.filter((c) => c[0] === 'plan').length === 1, 'the plan');
  await until(shows(app, 'terraform plan infra'), 'the plan done');
  await run(app, '/plan');
  await until(() => app.provider.calls.some((c) => c[0] === 'discard' && c[1] === 'demo-plans/chart-1.tfplan'), 'the first file removed');
  app.provider.failApply = 'Error: Saved plan is stale';
  await run(app, '/apply');
  await until(shows(app, 'Type default to apply'), 'the question');
  await type(app.stdin, 'default');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'The plan is stale'), 'the stale plan');
  await run(app, '/apply');
  await until(shows(app, 'applies only a plan Chart made and saved itself'), 'a spent plan is not applied again');
  app.unmount();
});

test("in an environment: the environment's name is typed, production asks once more, a plan made for another environment isn't applied", async () => {
  const root = join(home, 'shop');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.fleet'), { recursive: true });
  writeFileSync(join(root, '.fleet', 'project.json'), JSON.stringify({ default: 'dev', environments: { dev: { chart: { workspace: 'dev' } }, prod: { prod: true, chart: { workspace: 'prod' } } } }));
  const app = start({ cwd: root });
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/plan');
  await until(shows(app, 'azurerm_mssql_database.reports'), 'the dev plan');
  await run(app, '/env prod');
  await until(shows(app, 'Environment: prod'), 'the switch');
  await run(app, '/apply');
  await until(shows(app, 'This plan was made for dev, and the project is on prod now'), 'the refusal');
  await run(app, '/plan');
  await until(shows(app, 'terraform plan shop (prod)'), 'the prod plan');
  await run(app, '/apply');
  await until(shows(app, 'Type prod to apply this plan to shop (prod, workspace prod)'), 'the question');
  await type(app.stdin, 'prod');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'prod is production. Apply this plan to shop (prod, workspace prod)?'), 'the production question');
  app.stdin.write('2');
  await until(() => app.provider.calls.some((c) => c[0] === 'apply'), 'the apply');
  assert.equal(app.provider.calls.find((c) => c[0] === 'apply')[2].workspace, 'prod');
  app.unmount();
});

test('/apply after a what-if deploys the same file and arguments, once the resource group is typed', async () => {
  const app = start();
  await until(shows(app, '/plan asks terraform'), 'the hint');
  await run(app, '/whatif --rg shop-prod');
  await until(shows(app, 'Microsoft.Cache/Redis/shop-cache'), 'the what-if');
  await run(app, '/apply');
  await until(shows(app, 'Type shop-prod to deploy bicep/main.bicep into shop-prod'), 'the question');
  await type(app.stdin, 'shop-prod');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.calls.some((c) => c[0] === 'deploy'), 'the deployment');
  const call = app.provider.calls.find((c) => c[0] === 'deploy')[2];
  assert.deepEqual([call.file, call.resourceGroup, call.params], ['bicep/main.bicep', 'shop-prod', 'bicep/main.prod.bicepparam']);
  await until(() => readActivity().some((e) => /^Deployed bicep\/main\.bicep into shop-prod: \+1 ~1 -1$/.test(e.text)), 'the activity');
  app.unmount();
});
