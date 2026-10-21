// The terminal app's Board tab (cli/ui/BoardView.jsx) on the demo organization's boards, and the
// columns, cards and moves behind it (cli/board.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-board-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');
const { boardCards, boardColumns, cardLines, columnTitle, doneChanges } = await import('../cli/board.js');

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
const text = (segs) => segs.map((s) => s.text).join('');

const card = (id, column, over = {}) => ({ id, type: 'User Story', title: `Story ${id}`, state: 'New', stateCategory: 'Proposed', backlogOrder: id, tags: [], board: { column, done: false, lane: null }, ...over });
const configured = {
  taskTypes: ['Task'],
  board: {
    fields: { column: 'K.Column', done: 'K.Column.Done', lane: 'K.Lane' },
    columns: [
      { name: 'New', itemLimit: 0, stateMappings: { 'User Story': 'New' } },
      { name: 'Doing', itemLimit: 2, isSplit: true, stateMappings: { 'User Story': 'Active' } },
      { name: 'Done', itemLimit: 0, stateMappings: { 'User Story': 'Closed' } },
    ],
  },
  items: [
    card(3, 'New'),
    card(1, 'New'),
    card(2, 'Doing', { board: { column: 'Doing', done: true }, state: 'Active' }),
    card(4, 'Doing', { state: 'Active' }),
    card(5, 'Doing', { state: 'Active' }),
    { id: 9, type: 'Task', parentId: 1, stateCategory: 'Completed', board: { column: 'Done' } },
    { id: 10, type: 'Task', parentId: 1, stateCategory: 'InProgress', board: { column: 'Doing' } },
  ],
};

test("a configured board's columns hold cards in backlog order, tasks counted under their card", () => {
  const cols = boardColumns(configured);
  assert.deepEqual(cols.map((c) => c.label), ['New', 'Doing', 'Done']);
  const cards = boardCards(configured, cols);
  assert.deepEqual(cards.map((l) => l.map((w) => w.id)), [[1, 3], [2, 4, 5], []]);
  assert.deepEqual(cards[0][0].tasks, { done: 1, total: 2 });
  // A split column's limit counts only what's still Doing.
  assert.deepEqual(columnTitle(cols[1], cards[1]), { text: 'Doing 2/2', over: false });
  assert.deepEqual(boardCards(configured, cols, 'story 4').map((l) => l.map((w) => w.id)), [[], [4], []]);
});

test('moving a card saves its board column, Doing again, and the state the column maps to', () => {
  const [, doing, done] = boardColumns(configured);
  const w = configured.items[0];
  assert.equal(doing.accepts(w), true);
  assert.deepEqual(doing.changesFor(w), { state: 'Active', fields: { 'K.Column': 'Doing', 'K.Column.Done': false } });
  assert.equal(done.accepts({ ...w, board: { column: 'Done' } }), false);
  assert.deepEqual(doneChanges(configured, configured.items[2]), { fields: { 'K.Column.Done': false } });
});

test('without a configured board, a column per state category, moving by state', () => {
  const data = { taskTypes: [], board: null, states: { Bug: [{ name: 'New', category: 'Proposed' }, { name: 'Fixing', category: 'InProgress' }, { name: 'Shipped', category: 'Completed' }] }, items: [card(7, null, { type: 'Bug' })] };
  const cols = boardColumns(data);
  assert.deepEqual(cols.map((c) => c.label), ['Not started', 'In progress', 'Resolved', 'Done']);
  assert.deepEqual(boardCards(data, cols)[0].map((w) => w.id), [7]);
  assert.deepEqual(cols[1].changesFor(data.items[0]), { state: 'Fixing' });
  // Bugs have no Resolved state here, so they can't go there.
  assert.equal(cols[2].accepts(data.items[0]), false);
});

test("a card's lines: number and title, then who has it, points, tasks, lane and Done", () => {
  const [top, bottom] = cardLines({ ...card(4, 'Doing'), assignedTo: { displayName: 'Ana Silva' }, storyPoints: 3, tasks: { done: 1, total: 2 }, board: { column: 'Doing', done: true, lane: 'Expedite' } }, { split: true });
  assert.equal(text(top), '■ 4 Story 4');
  assert.equal(text(bottom), '  Ana · 3 pts · 1/2 tasks · Expedite  ✓ done');
  assert.match(text(cardLines({ ...card(5, 'New'), tags: ['Blocked'] }, { blockedTag: 'Blocked' })[1]), /unassigned  blocked/);
});

test('the Board tab draws the columns; > moves a card on and the cursor goes with it; t picks another team', async () => {
  lastApp = render(React.createElement(App, { keel, poll: false, openUrl: () => {} }));
  const app = lastApp;
  try {
    await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
    app.stdin.write('7');
    await until(() => frame().includes('Commerce Team · Stories') && frame().includes('╭─ New'), 'the board');
    assert.match(frame(), /Active \d\/4/);

    // To the Active column, then the card there moves on to Review.
    // Ready, which is empty, then Active.
    app.stdin.write('l');
    await until(() => !/❯ [■⊘] \d+/.test(frame()), 'the empty Ready column');
    app.stdin.write('l');
    await until(() => /❯ [■⊘] \d+/.test(frame()), 'a card in Active');
    const id = frame().match(/❯ [■⊘] (\d+)/)[1];
    app.stdin.write('>');
    await until(() => frame().includes(`→ Review`) && frame().includes('is in Review'), 'the move');
    await until(() => frame().includes(`❯ ■ ${id}`), 'the cursor on the moved card');
    const w = (await keel.service.board({})).items.find((x) => x.id === Number(id));
    assert.equal(w.board.column, 'Review');

    app.stdin.write('t');
    await until(() => frame().includes('Whose board?'), 'the teams');
    app.stdin.write('3');
    await until(() => frame().includes('Mobile Team · Backlog items'), 'the Mobile board');
  } finally {
    app.unmount();
  }
});
