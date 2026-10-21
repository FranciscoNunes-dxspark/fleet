// The terminal app's Team tab (cli/ui/TeamView.jsx) on the demo organization, and how people read
// in it (cli/team.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-team-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');
const { teamBrief, teamDetail, teamRows } = await import('../cli/team.js');

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

const person = (id, name, over = {}) => ({
  person: { id, displayName: name, teams: [{ teamName: 'Shop Team' }] },
  openItems: 3, inProgress: 1, proposed: 1, resolved: 1, sprintItems: 2, sprintPoints: 5, remainingWork: 0, bugs: 0, blocked: 0,
  prsAuthored: 1, draftPrs: 0, reviewsPending: 0, oldestPrHours: 30, flags: [], overloaded: false, ...over,
});

test('people with too much on come first, then by how much they have open; hidden people stay out', () => {
  const data = { rows: [person('a', 'Ana'), person('b', 'Bo', { openItems: 9 }), person('c', 'Cy', { flags: ['4 items in progress'], overloaded: true }), person('d', 'Di')], hidden: ['d'] };
  assert.deepEqual(teamRows(data).map((r) => r.person.displayName), ['Cy', 'Bo', 'Ana']);
  assert.deepEqual(teamRows(data, 'shop team').length, 3);
  assert.equal(teamBrief(person('a', 'Ana', { reviewsPending: 2 })), '1 in progress · 2 in the sprint, 5 pts · 2 reviews · 1 PR');
});

test("the pane lists their flags, numbers, work items, pull requests and the reviews waiting on them", () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  const r = person('a', 'Ana', { flags: ['4 items in progress'], reviewsPending: 1 });
  const workItems = [{ id: 7, title: 'Fix totals', state: 'Active', stateCategory: 'InProgress', changedAt: '2026-10-21T10:00:00Z', assignedTo: { id: 'a' } }, { id: 8, title: 'Not hers', assignedTo: { id: 'b' } }];
  const prs = [
    { id: 3, title: 'Refunds', author: { id: 'a' }, reviewState: 'in-review', ageHours: 50, reviewers: [] },
    { id: 4, title: 'Search', author: { id: 'b', displayName: 'Bo' }, ageHours: 5, reviewers: [{ id: 'a', vote: 0 }] },
    { id: 5, title: 'Voted', author: { id: 'b' }, reviewers: [{ id: 'a', vote: 10 }] },
  ];
  const shown = text(teamDetail(r, { workItems, prs, now }));
  assert.match(shown, /⚠ 4 items in progress/);
  assert.match(shown, /Sprint {2}2 items, 5 points/);
  assert.match(shown, /● 7 Fix totals {2}Active · 2h/);
  assert.doesNotMatch(shown, /Not hers/);
  assert.match(shown, /!3 Refunds {2}in review · 2d/);
  assert.match(shown, /Waiting on their review\n {2}· !4 Search {2}by Bo · 5h/);
  assert.doesNotMatch(shown, /Voted/);
});

test('the Team tab lists who carries what; ↵ shows their work items, p their pull requests', async () => {
  lastApp = render(React.createElement(App, { keel, poll: false, openUrl: () => {} }));
  const app = lastApp;
  try {
    await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
    app.stdin.write('8');
    await until(() => frame().includes('╭─ Team') && /❯ ⚠ \S/.test(frame()), 'the Team tab');
    const name = frame().match(/❯ ⚠ (\S+ \S+)/)[1];
    assert.match(frame(), /Their work items/);
    app.stdin.write('\r');
    // Filtered by their name: the first is theirs (the hint saying so may not fit 100 columns).
    await until(() => frame().includes('╭─ Work items') && frame().includes(`Assigned to ${name}`), 'their work items');
    app.stdin.write('8');
    await until(() => frame().includes('╭─ Team'), 'the Team tab again');
    app.stdin.write('p');
    await until(() => frame().includes('╭─ Pull requests') && frame().includes(`${name} opened it`), 'their pull requests');
  } finally {
    app.unmount();
  }
});
