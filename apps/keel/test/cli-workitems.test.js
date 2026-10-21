// The terminal app's Work items tab (cli/ui/WorkItemsView.jsx) on the demo organization, and the
// pure rules behind it (cli/format.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-wi-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');
const { isBlocked, wiRows, wiViews } = await import('../cli/format.js');

const KEYS = { enter: '\r', esc: '\x1b' };

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
function start() {
  lastApp = render(React.createElement(App, { keel, poll: false, openUrl: () => {} }));
  return lastApp;
}
/** The work item the cursor is on, by the number in the side panel's title. */
const selectedId = () => Number(frame().match(/╭─ (?:Bug|Task|User Story|Feature|Epic|Product Backlog Item) (\d+) /)?.[1]);

const item = (over) => ({ id: 1, title: 'x', type: 'Task', state: 'Active', stateCategory: 'InProgress', tags: [], priority: 2, changedAt: '2026-10-20T00:00:00Z', iterationPath: 'Web\\Sprint 4', assignedTo: null, ...over });

test('views and order: the web app\'s views, in progress first, then by priority', () => {
  const now = Date.parse('2026-10-21T00:00:00Z');
  const data = {
    me: { id: 'me' },
    currentIterationPaths: ['Web\\Sprint 4'],
    items: [
      item({ id: 1, stateCategory: 'Proposed', state: 'New', priority: 1 }),
      item({ id: 2, priority: 3, assignedTo: { id: 'me' } }),
      item({ id: 3, priority: 1, tags: ['Blocked'], iterationPath: 'Web\\Sprint 4\\Week 1' }),
      item({ id: 4, type: 'Bug', stateCategory: 'Resolved', iterationPath: 'Web', changedAt: '2026-10-01T00:00:00Z' }),
      item({ id: 5, changedAt: '2026-10-01T00:00:00Z', iterationPath: 'Web' }),
    ],
  };
  const meta = { blockedTag: 'Blocked', thresholds: { itemStuckDays: 5 } };
  const ids = (view) => wiRows(data, meta, { view }, now).map((w) => w.id);
  assert.deepEqual(ids('all'), [3, 5, 2, 4, 1], 'in progress (by priority), resolved, then new');
  assert.deepEqual(ids('mine'), [2]);
  assert.deepEqual(ids('sprint'), [3, 2, 1], 'the sprint and the iterations under it');
  assert.deepEqual(ids('bugs'), [4]);
  assert.deepEqual(ids('blocked'), [3]);
  assert.deepEqual(ids('stuck'), [5], 'in progress and unchanged for 5 days');
  assert.deepEqual(ids('unassigned'), [3, 5, 4, 1]);
  assert.deepEqual(wiRows(data, meta, { view: 'all', filter: '#4' }, now).map((w) => w.id), [4]);
  assert.equal(wiViews(data, meta).find((v) => v.id === 'stuck').label, 'no update in 5d');
  // Blocked is the flag, the tag, or a state named like the tag.
  assert.ok(isBlocked({ blocked: true, tags: [] }, 'Blocked'));
  assert.ok(isBlocked({ state: 'blocked', tags: [] }, 'Blocked'));
  assert.ok(!isBlocked({ state: 'Active', tags: ['later'] }, 'Blocked'));
});

test('the Work items tab lists open items; f goes round the views; ↵ shows one in full', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  app.stdin.write('4');
  await until(() => frame().includes('all open') && selectedId() > 0, 'the Work items tab');
  app.stdin.write('f');
  await until(() => frame().includes('current sprint'), 'the next view');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Acceptance criteria') || frame().includes('(No description.)') || /Comments \(\d+\)/.test(frame()), 'the work item in full');
  app.stdin.write(KEYS.esc);
  app.unmount();
});

test('s moves a work item to a state picked from its list; i takes it; b tags it blocked', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  app.stdin.write('4');
  await until(() => selectedId() > 0, 'the Work items tab');
  const id = selectedId();
  const before = (await keel.service.workItems()).items.find((w) => w.id === id);

  app.stdin.write('s');
  await until(() => frame().includes(`Move ${before.type} ${id}`) && frame().includes('Leave it'), 'the states to pick from');
  app.stdin.write('1');
  await until(() => frame().includes(`${before.type} ${id} → `) && frame().includes(' now.'), 'the move');
  const moved = (await keel.service.workItem(id)).state;
  assert.notEqual(moved, before.state);
  assert.match(frame(), new RegExp(`${before.type} ${id} → ${moved}`));
  // The key that answered stays with the question (a "1" doesn't also switch to the Inbox), and
  // the cursor stays on the work item wherever its new state puts it in the list.
  assert.match(frame(), /╭─ Work items/);
  await until(() => selectedId() === id, 'the cursor on it');

  app.stdin.write('i');
  await until(() => frame().includes('is yours now.') || frame().includes('already assigned to'), 'taking it');
  const { me } = await keel.service.workItems();
  assert.equal((await keel.service.workItem(id)).assignedTo?.id, me.id);

  const tagged = (await keel.service.workItem(id)).tags.includes('Blocked');
  app.stdin.write('b');
  await until(() => frame().includes(tagged ? 'tag is off' : 'Tagged Blocked'), 'the blocked tag');
  assert.equal((await keel.service.workItem(id)).tags.includes('Blocked'), !tagged);
  app.unmount();
});

test('/wi jumps to a work item, /priority and /comment act on it, /assign finds a person by name', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  const { items, people } = await keel.service.workItems();
  const target = items.at(-1);
  await type(app.stdin, `/wi ${target.id}`);
  app.stdin.write(KEYS.enter);
  await until(() => selectedId() === target.id, 'the work item');

  const priority = target.priority === 1 ? 2 : 1;
  await type(app.stdin, `/priority ${priority}`);
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes(`Priority ${priority}.`), 'the priority');
  assert.equal((await keel.service.workItem(target.id)).priority, priority);

  await type(app.stdin, '/comment Looked at this from the terminal');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes(`Comment on ${target.type} ${target.id}`) && frame().includes('Looked at this from the terminal'), 'the comment');

  // Part of a name is enough (completion offers the whole one).
  const first = (p) => p.displayName.split(' ')[0].toLowerCase();
  const someone = people.find((p) => !p.isContainer && p.id !== target.assignedTo?.id && people.filter((q) => first(q) === first(p)).length === 1);
  await type(app.stdin, `/assign ${first(someone)}`);
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes(`${someone.displayName}'s now.`), 'the assignment');
  assert.equal((await keel.service.workItem(target.id)).assignedTo?.id, someone.id);
  app.unmount();
});

test('/new creates a work item in the selected one\'s project, in the sprint', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  app.stdin.write('4');
  await until(() => selectedId() > 0, 'the Work items tab');
  await type(app.stdin, '/new bug Totals wrong on the terminal');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Create Bug "Totals wrong on the terminal"') && frame().includes('Yes, in Sprint'), 'the question');
  app.stdin.write('1');
  await until(() => /Bug \d+ created in Sprint/.test(frame()), 'the new bug');
  const id = Number(frame().match(/Bug (\d+) created/)[1]);
  const created = await keel.service.workItem(id);
  assert.equal(created.title, 'Totals wrong on the terminal');
  assert.match(created.iterationPath, /Sprint/);
  await until(() => selectedId() === id, 'the cursor on it');
  app.unmount();
});
