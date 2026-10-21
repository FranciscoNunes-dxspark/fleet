// The terminal app's Releases tab (cli/ui/ReleasesView.jsx) on the demo organization's classic release
// pipelines, and how they read (cli/releases.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-rel-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');
const { approvalsFor, deployChoices, releaseDetail, releaseRows, stageStrip } = await import('../cli/releases.js');

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
const text = (lines) => lines.map((l) => (typeof l === 'string' ? l : l.map((s) => s.text).join(''))).join('\n');

const stage = (id, name, rank, latest = null, active = null) => ({ id, name, rank, latest, active });
const def = (over = {}) => ({
  id: 1,
  key: 'p:release:1',
  name: 'Shop release',
  projectId: 'p',
  projectName: 'Shop',
  path: '\\Web',
  health: 'healthy',
  artifacts: [{ isPrimary: true, sourceName: 'shop-CI' }],
  stages: [stage(10, 'QA', 1, { releaseName: 'Release-2', status: 'succeeded', at: '2026-10-21T10:00:00Z' }), stage(11, 'Prod', 2, { releaseName: 'Release-1', status: 'succeeded', at: '2026-10-20T10:00:00Z' })],
  releases: [
    { id: 2, name: 'Release-2', createdOn: '2026-10-21T09:00:00Z', stages: [{ id: 902, definitionEnvironmentId: 10, name: 'QA', status: 'succeeded' }, { id: 903, definitionEnvironmentId: 11, name: 'Prod', status: 'inProgress', waiting: true }] },
    { id: 1, name: 'Release-1', createdOn: '2026-10-20T09:00:00Z', stages: [{ id: 900, definitionEnvironmentId: 10, name: 'QA', status: 'succeeded' }, { id: 901, definitionEnvironmentId: 11, name: 'Prod', status: 'succeeded' }] },
  ],
  ...over,
});
const approval = { kind: 'release', id: 5, projectId: 'p', pipeline: 'Shop release', stage: 'Prod', run: { name: 'Release-2' }, canDecide: true, instructions: 'Smoke tests first' };

test('release pipelines waiting on an approval or deploying come first, then failing ones, then by name', () => {
  const quiet = def({ key: 'a', name: 'Alpha release' });
  const failing = def({ key: 'b', name: 'Beta release', health: 'failing' });
  const asks = def({ key: 'c', name: 'Shop release' });
  const rows = releaseRows({ definitions: [quiet, failing, asks], approvals: [approval] });
  assert.deepEqual(rows.map((d) => d.name), ['Shop release', 'Beta release', 'Alpha release']);
  assert.deepEqual(releaseRows({ definitions: [quiet, failing], approvals: [] }, 'beta').map((d) => d.name), ['Beta release']);
  assert.equal(text([stageStrip(def())]), 'QA ✓  Prod ✓  ');
});

test('the pane says what each stage last got, and what waits for approval with its instructions', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const shown = text(releaseDetail(def(), [approval], { now }));
  assert.match(shown, /Shop · Web · from shop-CI/);
  assert.match(shown, /✓ QA  Release-2 succeeded · 2h ago/);
  assert.match(shown, /Release-2 waits for approval · a approves, x rejects/);
  assert.match(shown, /"Smoke tests first"/);
  assert.match(shown, /Release-2 .*QA ✓ Prod ‖/);
  assert.equal(approvalsFor(def(), [approval, { ...approval, pipeline: 'Other' }]).length, 1);
});

test('a stage can get any recent release that includes it, newest first', () => {
  const choices = deployChoices(def(), { id: 11, name: 'Prod' });
  assert.deepEqual(choices.map((c) => [c.release.name, c.environmentId]), [['Release-2', 903], ['Release-1', 901]]);
  assert.match(choices[0].label, /Release-2 · waiting for approval there/);
  assert.match(choices[1].label, /Release-1 · succeeded there/);
});

test('the Releases tab lists the release pipelines; d deploys a release to a stage, a approves what one waits on', async () => {
  lastApp = render(React.createElement(App, { keel, poll: false, openUrl: () => {} }));
  const app = lastApp;
  try {
    await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
    app.stdin.write('6');
    await until(() => frame().includes('Storefront release') && frame().includes('waits for approval'), 'the Releases tab');
    assert.match(frame(), /╭─ Releases/);
    assert.match(frame(), /Checkout API release/);
    // The one waiting for an approval is first, with the cursor on it.
    assert.match(frame(), /❯ ‖ Storefront release/);

    // d: the stage, then the release, and it deploys.
    app.stdin.write('d');
    await until(() => frame().includes('Deploy Storefront release to which stage?'), 'the stages');
    app.stdin.write('2');
    await until(() => frame().includes('Deploy which release to Staging?'), 'the releases');
    assert.match(frame(), /Approvals and gates on that stage still apply/);
    app.stdin.write('1');
    await until(() => frame().includes('Release-58 is deploying to Staging'), 'the deployment');
    await until(() => /Storefront release\s+QA ✓  Staging ●/.test(frame()), 'Staging deploying');

    // a: the approval Production waits on, asked first.
    app.stdin.write('a');
    await until(() => frame().includes('Approve Release-58 to Production?'), 'the question');
    assert.match(frame(), /Check the Staging smoke tests first/);
    app.stdin.write('1');
    await until(() => frame().includes('Approved: the deployment carries on.'), 'the approval');
    await until(() => !frame().includes('waits for approval'), 'nothing waiting any more');
  } finally {
    app.unmount();
  }
});
