// A pipeline run in full in the terminal app (l in Pipelines, /logs; cli/runs.js), and the viewer's
// wrapping of long lines (cli/ui/TextViewer.jsx).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-runs-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');
const { runText, took } = await import('../cli/runs.js');
const { wrapIndented } = await import('../cli/ui/TextViewer.jsx');

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

const rec = (id, parentId, type, name, result, order = 1, extra = {}) => ({ id, parentId, type, name, order, state: 'completed', result, startedAt: '2026-10-21T10:00:00Z', finishedAt: '2026-10-21T10:01:30Z', issues: [], ...extra });

test("a run reads as a tree: every stage and job, the steps of the failed job with their errors and the end of their log", () => {
  const row = { definition: { name: 'shop-CI' }, projectName: 'Shop', repoName: 'shop' };
  const run = { id: 9, buildNumber: '20261021.3', status: 'completed', result: 'failed', sourceBranch: 'refs/heads/main', reason: 'manual', requestedFor: { displayName: 'Ana' }, startedAt: '2026-10-21T10:00:00Z', finishedAt: '2026-10-21T10:04:00Z', webUrl: 'https://x/run/9' };
  const details = {
    timeline: [
      rec('s1', null, 'Stage', 'Build', 'succeeded', 1),
      rec('j1', 's1', 'Job', 'Compile', 'succeeded'),
      rec('t1', 'j1', 'Task', 'Restore', 'succeeded'),
      rec('s2', null, 'Stage', 'Test', 'failed', 2),
      rec('j2', 's2', 'Job', 'Unit tests', 'failed'),
      rec('t2', 'j2', 'Task', 'Run tests', 'failed', 1, { issues: [{ type: 'error', message: '2 tests failed' }, { type: 'warning', message: 'slow' }] }),
      rec('t3', 'j2', 'Task', 'Publish results', 'skipped', 2),
    ],
    logs: { t2: Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') },
    tests: { total: 50, passed: 48, failed: 2, other: 0 },
    changes: [{ id: 'abcdef1234', message: 'Fix totals\nmore', author: 'Ana', at: '2026-10-21T09:00:00Z' }],
    approvals: [],
  };
  const { title, text } = runText(row, run, details, Date.parse('2026-10-21T12:00:00Z'));
  assert.equal(title, 'shop-CI 20261021.3 · failed');
  assert.match(text, /Shop \/ shop · main · Ana · manual · 1h ago · 4m 0s/);
  assert.match(text, /Tests {2}50 · 48 passed · 2 failed/);
  assert.match(text, /^✓ Build {2}1m 30s\n {2}✓ Compile {2}1m 30s\n✗ Test {2}failed/m);
  // The steps of a job that passed stay folded; the failed job's show, with its errors (not warnings).
  assert.doesNotMatch(text, /Restore/);
  assert.match(text, /✗ Run tests {2}failed {2}1m 30s\n {8}error: 2 tests failed\n {8}── the last 40 lines of its log ──\n {8}line 21\n/);
  assert.doesNotMatch(text, /line 20\n|slow/);
  assert.match(text, /⊘ Publish results {2}skipped\n/);
  assert.match(text, /Commits in this run\n {2}abcdef1 Fix totals · Ana · 3h ago/);
  assert.match(text, /https:\/\/x\/run\/9$/);
  assert.equal(took('2026-10-21T10:00:00Z', '2026-10-21T11:05:00Z'), '1h 5m');
});

test('long lines in the viewer wrap under their own text', () => {
  assert.deepEqual(wrapIndented('    error: one two three four five six seven eight nine ten', 30), ['    error: one two three four', '      five six seven eight', '      nine ten']);
  assert.deepEqual(wrapIndented('short', 30), ['short']);
});

test('l on a failing pipeline opens its latest run in full; /logs <number> opens an older one', async () => {
  lastApp = render(React.createElement(App, { keel, poll: false, openUrl: () => {} }));
  const app = lastApp;
  try {
    await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
    app.stdin.write('3');
    await until(() => /❯ ✗ \S/.test(frame()), 'a failing pipeline first');
    const name = frame().match(/❯ ✗ (\S+)/)[1];
    app.stdin.write('l');
    await until(() => frame().includes(`${name} `) && frame().includes('· failed') && frame().includes('esc close'), 'the run');
    assert.match(frame(), /✗ \S/);
    assert.match(frame(), /the last \d+ lines of its log/);
    app.stdin.write('\x1b');
    await until(() => frame().includes('╭─ Pipelines'), 'the list again');

    // The run before the latest, by its number.
    const row = (await keel.service.pipelines()).find((p) => p.definition.name === name);
    const older = (await keel.service.pipelineRuns(row.projectId, row.definition.id)).runs[1];
    app.stdin.write('/');
    await type(app.stdin, `logs ${older.buildNumber}`);
    app.stdin.write('\r');
    await until(() => frame().includes(`${name} ${older.buildNumber} ·`), 'the older run');
    app.stdin.write('\x1b');
    await until(() => frame().includes('╭─ Pipelines'), 'the list again');

    app.stdin.write('/');
    await type(app.stdin, 'logs 1999.1');
    app.stdin.write('\r');
    await until(() => frame().includes('has no recent run 1999.1'), "the run that isn't there");
  } finally {
    app.unmount();
  }
});
