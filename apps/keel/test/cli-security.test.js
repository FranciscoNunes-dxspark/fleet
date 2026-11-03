// bilge-ignore-file: reads the demo organization's made-up secrets, to check none reaches any output.
//
// The security review on the demo organization (server/mock/security.js): the service's review, the
// several-organizations layer, `keel security` (cli/headless.js) as text and JSON with its exit codes,
// /security in the terminal app, and no secret variable's value in any of their outputs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-security-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');
const { parseSecurityArgs, runSecurity } = await import('../cli/headless.js');
const { findingDetail, reviewSummary } = await import('../cli/security.js');
const { createMockProvider } = await import('../server/mock/provider.js');
const { createMockVariant } = await import('../server/mock/variant.js');
const { createService } = await import('../server/service.js');
const { createMultiService } = await import('../server/multiorg.js');
const { createSettingsStore } = await import('../server/settings.js');
const { secretName } = await import('../server/domain/devopssecurity.js');

let keel;
before(() => {
  keel = openKeel();
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

/** Every value the demo keeps in a plain variable named like a secret: what must never be shown. */
async function demoSecrets() {
  const provider = createMockProvider();
  const values = [];
  for (const p of await provider.listProjects()) {
    const s = await provider.readSecuritySettings(p.id);
    const vars = [...s.definitions.map((d) => d.variables), ...s.variableGroups.map((g) => g.variables)].flatMap((v) => Object.entries(v ?? {}));
    for (const [name, v] of vars) if (secretName(name) && !v.isSecret && v.value) values.push(String(v.value));
  }
  return values;
}
const assertNoSecret = (text, secrets, what) => {
  for (const s of secrets) assert.ok(!String(text).includes(s), `${what} shows a secret's value`);
};

const capture = () => {
  let out = '';
  return { write: (s) => { out += s; }, text: () => out };
};

test('the demo organization: every rule finds something, worst first, shared things counted once', async () => {
  const review = await keel.service.devopsSecurity();
  assert.deepEqual(review.projects.map((p) => p.projectName), ['Commerce', 'Platform', 'Mobile']);
  assert.deepEqual(new Set(review.findings.map((f) => f.rule)), new Set([
    'pipeline-plain-secret', 'group-plain-secret', 'group-not-keyvault', 'open-to-all-pipelines', 'connection-wide-scope', 'connection-owner-role',
    'connection-client-secret', 'connection-shared', 'branch-no-reviewers', 'branch-no-build-validation', 'branch-creator-vote', 'agent-outdated', 'project-public',
  ]));
  assert.deepEqual(review.counts, { critical: 0, high: 5, medium: 9, low: 5, unknown: 0 });
  const order = ['critical', 'high', 'medium', 'low'];
  assert.ok(review.findings.every((f, i, all) => !i || order.indexOf(all[i - 1].severity) <= order.indexOf(f.severity)), 'worst first');
  // commerce-prod is shared by Commerce and Platform, and their agent pool too: each said once.
  assert.equal(review.findings.filter((f) => f.where === 'service connection commerce-prod' && f.rule === 'connection-wide-scope').length, 1);
  assert.equal(review.findings.filter((f) => f.rule === 'agent-outdated').length, 1);
  // Mobile is in good order but for being public.
  const mobile = await keel.service.devopsSecurity({ project: 'mobile' });
  assert.deepEqual(mobile.findings.map((f) => `${f.severity} ${f.rule}`), ['medium project-public']);
  assert.deepEqual((await keel.service.devopsSecurity({ project: 'Nowhere' })).projects, []);
});

test('a project meant to be public, named in the settings, is a note rather than a finding to act on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-security-settings-'));
  try {
    const settings = createSettingsStore(join(dir, 'settings.json'));
    await settings.save({ devopsSecurity: { publicProjects: ['Mobile'] } });
    const service = createService({ provider: createMockProvider(), settings });
    const mobile = await service.devopsSecurity({ project: 'Mobile' });
    assert.deepEqual(mobile.findings.map((f) => `${f.severity} ${f.title}`), ['low Public project (expected)']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('several organizations: each one reviewed by its own service, tagged with its key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-security-multi-'));
  try {
    const settings = createSettingsStore(join(dir, 'settings.json'));
    const multi = createMultiService([
      { org: { key: 'contoso', primary: true }, service: createService({ provider: createMockProvider(), settings, org: { key: 'contoso', primary: true } }) },
      { org: { key: 'fabrikam', primary: false }, service: createService({ provider: createMockVariant(), settings, org: { key: 'fabrikam', primary: false } }) },
    ]);
    const review = await multi.devopsSecurity({ project: 'Retail' });
    assert.deepEqual(review.projects.map((p) => [p.org, p.projectName]), [['fabrikam', 'Retail']]);
    assert.ok(review.findings.length && review.findings.every((f) => f.org === 'fabrikam'));
    assert.ok(review.findings.some((f) => f.webUrl.startsWith('https://dev.azure.com/fabrikam-demo/Retail/')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keel security: its arguments', () => {
  assert.deepEqual(parseSecurityArgs([]), { project: null, json: false, failOn: 'high' });
  assert.deepEqual(parseSecurityArgs(['Commerce', '--json', '--fail-on', 'medium', '--demo']), { project: 'Commerce', json: true, failOn: 'medium' });
  assert.equal(parseSecurityArgs(['--fail-on=none']).failOn, 'none');
  assert.match(parseSecurityArgs(['--fail-on', 'bad']).error, /--fail-on is one of/);
  assert.match(parseSecurityArgs(['--nope']).error, /Unknown option --nope/);
});

test("keel security --json: the kit's securityJson, exit 1 at --fail-on, and no secret's value", async () => {
  const secrets = await demoSecrets();
  assert.equal(secrets.length, 3, 'the demo has three plain secrets to hide');
  const out = capture();
  const now = new Date('2026-11-03T10:00:00Z');
  const code = await runSecurity(['Commerce', '--json'], { service: keel.service, write: out.write, now });
  assert.equal(code, 1);
  const json = JSON.parse(out.text());
  assert.equal(json.app, 'keel');
  assert.equal(json.check, 'devops');
  assert.equal(json.target, 'Commerce');
  assert.equal(json.at, '2026-11-03T10:00:00.000Z');
  assert.deepEqual(json.projects, ['Commerce']);
  assert.deepEqual(json.counts, { critical: 0, high: 3, medium: 4, low: 5, unknown: 0 });
  assert.deepEqual(json.findings[0], {
    rule: 'pipeline-plain-secret',
    severity: 'high',
    title: 'Secret in a variable not marked secret',
    where: 'Commerce/pipeline storefront-web-CI (NPM_TOKEN)',
    why: 'Its value shows to anyone who can read the pipeline or the library, and in run logs, as it is not masked.',
    fix: "In the pipeline's Edit → Variables, tick \"Keep this value secret\" (or move it to a Key Vault variable group), then rotate the value: it has been readable.",
  });
  assert.ok(json.findings.every((f) => !('excerpt' in f) && !('webUrl' in f)), 'excerpts and links stay out of the JSON');
  assertNoSecret(out.text(), secrets, 'the JSON');

  // Every project as text: the findings worst first, the counts, and still no value.
  const text = capture();
  assert.equal(await runSecurity(['--fail-on', 'critical'], { service: keel.service, write: text.write }), 0);
  assert.match(text.text(), /^Azure DevOps security review: Commerce, Platform, Mobile\nHIGH Secret in a variable not marked secret {2}Commerce\/pipeline storefront-web-CI \(NPM_TOKEN\)\n/);
  assert.match(text.text(), /\n5 high · 9 medium · 5 low\n$/);
  assertNoSecret(text.text(), secrets, 'the text');

  // A project that isn't there, or a bad option: 2.
  const none = capture();
  assert.equal(await runSecurity(['Nowhere'], { service: keel.service, write: none.write }), 2);
  assert.equal(none.text(), 'keel security: no Azure DevOps project called Nowhere.\n');
  assert.equal(await runSecurity(['--fail-on', 'often'], { service: keel.service, write: () => {} }), 2);
  // What the token couldn't read is said, and the rest still judged.
  const partial = {
    devopsSecurity: async () => ({
      projects: [{ projectName: 'Shop', findings: [], gaps: [] }], findings: [], counts: {},
      gaps: [{ projectName: 'Shop', what: 'service connections', error: 'Azure DevOps GET failed (403): not allowed' }],
    }),
  };
  const gaps = capture();
  assert.equal(await runSecurity([], { service: partial, write: gaps.write }), 0);
  assert.match(gaps.text(), /Nothing found\.\n\nNot reviewed:\n {2}Shop: couldn't read service connections \(Azure DevOps GET failed \(403\): not allowed\)\n$/);
});

test("the service's own answer (the web app's and the terminal's) and each finding in full show the value only redacted", async () => {
  const secrets = await demoSecrets();
  const review = await keel.service.devopsSecurity();
  assertNoSecret(JSON.stringify(review), secrets, "the service's answer");
  for (const f of review.findings) assertNoSecret(findingDetail(f), secrets, `${f.where} in full`);
  const npm = review.findings.find((f) => f.where.endsWith('(NPM_TOKEN)'));
  assert.match(findingDetail(npm), /\nSeen: {2}NPM_TOKEN = npm_•+\n/);
  assert.match(reviewSummary(review), /^3 projects: 5 high · 9 medium · 5 low$/);
});

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

test('/security in the terminal app: the list worst first, the finding beside it, ↵ in full and back, o opens it, esc closes it', async () => {
  const secrets = await demoSecrets();
  const opened = [];
  lastApp = render(React.createElement(App, { home: 'inbox', keel, poll: false, openUrl: (u) => opened.push(u) }));
  const app = lastApp;
  const seen = [];
  try {
    await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
    app.stdin.write('/');
    await type(app.stdin, 'security');
    app.stdin.write('\r');
    await until(() => frame().includes('Security · 3 projects') && frame().includes('5 high · 9 medium · 5 low'), 'the review');
    seen.push(frame());
    assert.match(frame(), /❯ HIGH Secret in a variable not marked secret {2}Comme/);
    assert.match(frame(), /Where: Commerce\/pipeline\s.*\n.*storefront-web-CI \(NPM_TOKEN\)/, 'the selected finding beside the list');
    const tags = [...frame().matchAll(/^│[❯ ] (HIGH|MED |LOW )/gm)].map((m) => m[1].trim());
    assert.deepEqual(tags.slice(0, 6), ['HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'MED'], 'worst first');
    assert.match(frame(), /─ pipeline-plain-secret ─/);
    app.stdin.write('j');
    await until(() => frame().includes('branch-no-reviewers'), 'the next finding');
    app.stdin.write('\r');
    await until(() => frame().includes('Where: Commerce/repo payments-service (main)'), 'the finding in full');
    seen.push(frame());
    app.stdin.write('\x1b');
    await until(() => frame().includes('Security · 3 projects'), 'back to the list');
    assert.match(frame(), /❯ HIGH Default branch needs no reviewer/, 'still on the finding it opened');
    app.stdin.write('o');
    await until(() => opened.length === 1, 'the link opened');
    assert.equal(opened[0], 'https://dev.azure.com/contoso-demo/Commerce/_settings/repositories?repo=r-payments-service&_a=policiesMid&refs=refs%2Fheads%2Fmain');
    app.stdin.write('/');
    await type(app.stdin, 'find connection');
    app.stdin.write('\r');
    await until(() => frame().includes('matching') && !frame().includes('Default branch'), 'the list narrowed');
    assert.match(frame(), /Azure connection/);
    seen.push(frame());
    app.stdin.write('\x1b');
    await until(() => !frame().includes('Security ·'), 'the review closed');
    // One project by name.
    app.stdin.write('/');
    await type(app.stdin, 'security Mobile');
    app.stdin.write('\r');
    await until(() => frame().includes('Security · Mobile') && frame().includes('1 medium') && frame().includes('MED  Public project'), "Mobile's review");
    seen.push(frame());
    for (const f of seen) assertNoSecret(f, secrets, 'the screen');
  } finally {
    app.unmount();
  }
});
