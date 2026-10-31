// The command lines Chart runs, against a fake run; what a folder holds; where a resource is declared; chart check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChart, detectFolder, explain, locateResource, safeArg } from '../src/iac.js';
import { fails, parseArgs, runHeadless } from '../src/headless.js';
import { whatIfArgs } from '../src/actions.js';
import { markdownReport } from '../src/share.js';
import { parseTerraformPlan } from '../src/plan.js';
import { DEMO_PLAN, DEMO_STATE, DEMO_WHAT_IF, demoChart } from '../src/demo.js';

function fakeRun(answers) {
  const calls = [];
  const run = async (command, opts) => {
    calls.push({ command, cwd: opts?.cwd });
    const hit = answers.find(([re]) => re.test(command));
    if (!hit) return { stdout: '', stderr: '' };
    if (hit[1] instanceof Error) throw hit[1];
    return { stdout: typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]), stderr: '' };
  };
  return Object.assign(run, { calls });
}

test('a plan: terraform plan into a file of its own, then show -json of it, never asking for input', async () => {
  const run = fakeRun([[/show -json/, DEMO_PLAN]]);
  const plan = await createChart({ run }).plan('/srv/infra', { bin: 'tofu', refreshOnly: true });
  assert.equal(plan.changes.length, 8);
  assert.match(run.calls[0].command, /^tofu plan -input=false -lock=false -no-color -refresh-only -out=".+chart-[\w-]+\.tfplan"$/);
  assert.match(run.calls[1].command, /^tofu show -json ".+\.tfplan"$/);
  assert.equal(run.calls[0].cwd, '/srv/infra');
  await assert.rejects(createChart({ run }).plan('/x', { bin: 'rm -rf' }), /runs terraform or tofu/);
});

test('the state, and an empty one; init', async () => {
  const chart = createChart({ run: fakeRun([[/show -json/, DEMO_STATE]]) });
  assert.equal((await chart.state('/srv/infra')).resources.length, 4);
  assert.deepEqual((await createChart({ run: fakeRun([[/show/, 'No state.\n']]) }).state('/x')).resources, []);
  const run = fakeRun([]);
  await createChart({ run }).init('/x', { bin: 'terraform' });
  assert.equal(run.calls[0].command, 'terraform init -input=false -no-color');
});

test("a what-if: az's command for a resource group or the subscription, everything in it checked", async () => {
  const run = fakeRun([[/what-if/, DEMO_WHAT_IF]]);
  const chart = createChart({ run });
  await chart.whatIf('/srv', { file: 'bicep/main.bicep', resourceGroup: 'shop-prod', params: 'bicep/main.prod.bicepparam' });
  assert.equal(run.calls[0].command, 'az deployment group what-if --resource-group "shop-prod" --template-file "bicep/main.bicep" --parameters "bicep/main.prod.bicepparam" --no-pretty-print --output json');
  await chart.whatIf('/srv', { file: 'main.bicep', location: 'westeurope' });
  assert.equal(run.calls[1].command, 'az deployment sub what-if --location "westeurope" --template-file "main.bicep" --no-pretty-print --output json');
  await assert.rejects(chart.whatIf('/srv', { file: 'main.bicep' }), /needs a resource group/);
  await assert.rejects(chart.whatIf('/srv', { file: 'main.bicep', resourceGroup: 'rg"; rm -rf ~; "' }), /won't put in a command line/);
  assert.equal(safeArg('C:\\infra\\main.bicep'), true);
  assert.equal(safeArg('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\chart-1.tfplan'), true);
  assert.equal(safeArg('$(whoami)'), false);
  assert.match(explain(new Error('az: command not found'), 'az').message, /az isn't installed/);
  assert.match(explain(new Error('Error: Backend initialization required, please run "terraform init"'), 'terraform').message, /needs init first/);
});

test("/whatif's arguments: given, or the last ones, a parameter file beside the template found", () => {
  const found = { bicep: ['bicep/main.bicep'], params: ['bicep/main.prod.bicepparam'] };
  assert.deepEqual(whatIfArgs('--rg shop-prod', { found }), { file: 'bicep/main.bicep', resourceGroup: 'shop-prod', location: undefined, params: 'bicep/main.prod.bicepparam' });
  assert.deepEqual(whatIfArgs('', { last: { file: 'a.bicep', resourceGroup: 'rg', params: 'a.json' } }), { file: 'a.bicep', resourceGroup: 'rg', location: undefined, params: 'a.json' });
  assert.deepEqual(whatIfArgs('b.bicep --location westeurope', { last: { file: 'a.bicep', resourceGroup: 'rg', params: 'a.json' } }), { file: 'b.bicep', resourceGroup: undefined, location: 'westeurope', params: undefined });
});

test('a folder: its Terraform folders, Bicep files, parameters and saved plans; a resource found where it is declared', () => {
  const root = mkdtempSync(join(tmpdir(), 'chart-scan-'));
  try {
    const put = (path, text) => {
      mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(root, ...path.split('/')), text);
    };
    put('main.tf', 'terraform {}\n');
    put('app.tf', '# the apps\n\nresource "azurerm_linux_web_app" "api" {\n  name = "shop-api"\n}\n');
    put('modules/network/main.tf', 'resource "azurerm_virtual_network" "main" {}\n');
    put('.terraform/modules/x/main.tf', 'resource "azurerm_linux_web_app" "api" {}\n');
    put('bicep/main.bicep', "resource site 'Microsoft.Web/sites@2023-01-01' = {}\n");
    put('bicep/main.prod.bicepparam', "using 'main.bicep'\n");
    put('plans/plan.json', '{}');
    const found = detectFolder(root);
    assert.deepEqual([found.tfDirs, found.bicep, found.params, found.saved], [['.', 'modules/network'], ['bicep/main.bicep'], ['bicep/main.prod.bicepparam'], ['plans/plan.json']]);
    assert.deepEqual(locateResource(root, 'azurerm_linux_web_app', 'api'), { path: 'app.tf', line: 3 });
    assert.deepEqual(locateResource(root, 'azurerm_virtual_network', 'main'), { path: 'modules/network/main.tf', line: 1 });
    assert.equal(locateResource(root, 'azurerm_linux_web_app', 'nope'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('chart check: what the plan does, and an exit code by --fail-on; --json; --markdown', async () => {
  const out = [];
  const write = (s) => out.push(s);
  assert.equal(await runHeadless(['check'], { provider: demoChart(), write }), 1);
  assert.match(out.join(''), /^\+2 ~2 ±1 -1\n- azurerm_mssql_database\.reports {2}\(it is no longer in the configuration\)/);
  assert.match(out.join(''), /Changed outside Terraform:\n~ azurerm_linux_web_app\.api: app_settings\.LOG_LEVEL: "info" → "debug"; tags\.owner = "ana"/);
  assert.equal(await runHeadless(['check', '--fail-on', 'none'], { provider: demoChart(), write }), 0);
  const provider = demoChart();
  assert.equal(await runHeadless(['check', '--fail-on', 'drift', '--tofu'], { provider, write }), 1);
  assert.deepEqual(provider.calls.find((c) => c[0] === 'plan').slice(2), ['tofu', true]);
  out.length = 0;
  assert.equal(await runHeadless(['check', '--json', '--fail-on', 'replace'], { provider: demoChart(), write }), 1);
  assert.deepEqual(JSON.parse(out.join('')).summary, { delete: 1, replace: 1, update: 2, create: 2, noop: 2 });
  assert.equal(await runHeadless(['check', '--fail-on', 'everything'], { provider: demoChart(), write }), 2);
  assert.deepEqual(parseArgs(['check', 'plan.json', '--markdown']), { command: 'check', target: 'plan.json', failOn: 'destroy', json: false, markdown: true, bin: 'terraform' });
  const plan = parseTerraformPlan(DEMO_PLAN);
  assert.deepEqual(['destroy', 'replace', 'change', 'drift', 'none'].map((f) => fails(plan, f)), [true, true, true, true, false]);
  assert.equal(fails({ changes: [{ action: 'noop' }], drift: [] }, 'change'), false);
});

test('the Markdown report: what is destroyed called out, a row per change, the attributes folded away, the drift', () => {
  const md = markdownReport(parseTerraformPlan(DEMO_PLAN), { label: 'infra', when: new Date('2026-10-30T12:00:00Z') });
  assert.match(md, /^# Terraform plan: infra\n\n\+2 ~2 ±1 -1 \(2026-10-30 12:00 UTC, Terraform 1\.9\.8\)/);
  assert.match(md, /> \*\*2 resources are destroyed:\*\* `azurerm_mssql_database\.reports`, `azurerm_linux_web_app\.admin`/);
  assert.match(md, /\| `±` \| `azurerm_linux_web_app\.admin` \| replace \| an argument that forces replacement changed \|/);
  assert.match(md, /<details><summary><code>~ azurerm_service_plan\.main<\/code><\/summary>\n\n```diff\n! sku_name: "B1" → "P1v3"/);
  assert.match(md, /## Changed outside Terraform\n\n- `azurerm_linux_web_app\.api`: app_settings\.LOG_LEVEL/);
  assert.ok(!md.includes('hunter2'));
});
