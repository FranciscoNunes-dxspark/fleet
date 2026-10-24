// The terminal app's Board tab when no tracked project has a team (only GitHub owners tracked, say):
// it says so instead of drawing columns. A file of its own, so no other test's board is cached.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-board-empty-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');

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

test('with no tracked project that has a team, the Board tab says so instead of drawing columns', async () => {
  // What service.board() answers then (server/service.js): no project, nothing to pick.
  const empty = { ...keel, service: { ...keel.service, board: async () => ({ project: null, options: [] }) } };
  lastApp = render(React.createElement(App, { keel: empty, poll: false, openUrl: () => {} }));
  const app = lastApp;
  try {
    await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
    app.stdin.write('7');
    await until(() => frame().includes('No boards here: none of your tracked projects has a team'), 'the note');
    assert.doesNotMatch(frame(), /Nothing here/);
    // Keys on an empty board do nothing, and break nothing.
    for (const k of ['l', 'j', '>', 'm', ' ', 't', 'v']) app.stdin.write(k);
    await new Promise((r) => setTimeout(r, 300));
    assert.match(frame(), /No boards here/);
    assert.doesNotMatch(frame(), /ERROR/);
  } finally {
    app.unmount();
  }
});
