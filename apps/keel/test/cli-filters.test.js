// Filters by field in the terminal app (cli/filters.js): who:, type:, tag:, state:, project:, repo:,
// team: in a tab's /find text, and F, which builds them from the values in the list on screen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-filters-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');
const { applyFilter, fieldValues, fieldsMatch, shownFilter, splitFilter, withField } = await import('../cli/filters.js');

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

const ana = { id: 'a', displayName: 'Ana Silva' };
const bo = { id: 'b', displayName: 'Bo Chen' };
const items = [
  { id: 1, type: 'Bug', state: 'Active', tags: ['Blocked'], projectName: 'Shop', assignedTo: ana },
  { id: 2, type: 'User Story', state: 'New', tags: [], projectName: 'Shop', assignedTo: bo },
  { id: 3, type: 'Bug', state: 'New', tags: ['ux'], projectName: 'Web', assignedTo: null },
];
const isMe = (w) => w.assignedTo?.id === 'a';

test('fields come out of the filter text; plain words and unknown keys stay text', () => {
  assert.deepEqual(splitFilter('who:"Ana Silva" type:bug refund flow', 'workitems'), { fields: [{ key: 'who', value: 'Ana Silva' }, { key: 'type', value: 'bug' }], text: 'refund flow' });
  // repo: isn't a work item field, so it's searched as text.
  assert.deepEqual(splitFilter('repo:api type:bug', 'workitems'), { fields: [{ key: 'type', value: 'bug' }], text: 'repo:api' });
  assert.deepEqual(splitFilter('', 'prs'), { fields: [], text: '' });
});

test('an item matches every field asked for; who:me and who:none are you and nobody', () => {
  const ids = (text) => applyFilter('workitems', items, text, isMe).items.map((w) => w.id);
  assert.deepEqual(ids('type:bug'), [1, 3]);
  assert.deepEqual(ids('type:bug project:shop'), [1]);
  assert.deepEqual(ids('who:me'), [1]);
  assert.deepEqual(ids('who:none'), [3]);
  assert.deepEqual(ids('who:chen'), [2]);
  assert.deepEqual(ids('tag:blocked'), [1]);
  assert.deepEqual(ids('state:new type:story'), [2]);
  assert.equal(applyFilter('workitems', items, 'type:bug refund', isMe).text, 'refund');
  assert.equal(fieldsMatch('team', { person: { teams: [{ teamName: 'Shop Team' }] } }, [{ key: 'team', value: 'shop' }]), true);
});

test('F sets one field at a time, quoted when it has spaces, and "any" takes it out', () => {
  assert.equal(withField('refund', 'workitems', 'who', 'Ana Silva'), 'who:"Ana Silva" refund');
  assert.equal(withField('who:"Ana Silva" refund', 'workitems', 'who', 'none'), 'who:none refund');
  assert.equal(withField('who:none type:bug refund', 'workitems', 'who', null), 'type:bug refund');
  assert.deepEqual(fieldValues('workitems', 'type', items), [{ value: 'Bug', count: 2 }, { value: 'User Story', count: 1 }]);
  assert.deepEqual(fieldValues('workitems', 'who', items).map((v) => v.value), ['Ana Silva', 'Bo Chen']);
  assert.equal(shownFilter('who:none refund'), 'who:none refund');
  assert.equal(shownFilter('refund'), '"refund"');
});

test('F on the Board narrows the cards to a person, picked from those on it; /find with nothing clears it', async () => {
  lastApp = render(React.createElement(App, { keel, poll: false, openUrl: () => {} }));
  const app = lastApp;
  try {
    await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
    app.stdin.write('7');
    await until(() => frame().includes('Commerce Team · Stories'), 'the board');
    const before = (frame().match(/■ \d+/g) ?? []).length;
    app.stdin.write('F');
    await until(() => frame().includes('Filter by') && frame().includes('Assigned to'), 'the fields');
    app.stdin.write('1');
    await until(() => frame().includes('Anyone') && frame().includes('Nobody'), 'the people');
    // After Anyone, Me and Nobody: the most common first, with how many cards each has.
    const first = frame().match(/4\. ([^(]+) \((\d+)\)/);
    app.stdin.write('4');
    await until(() => frame().includes(`who:"${first[1].trim()}"`) || frame().includes(`who:${first[1].trim()}`), 'the filter');
    const shown = (frame().match(/[■⊘] \d+/g) ?? []).length;
    assert.ok(shown <= Number(first[2]) && shown < before, `${shown} cards shown of ${before}, ${first[2]} assigned to ${first[1]}`);
    app.stdin.write('/');
    await type(app.stdin, 'find');
    app.stdin.write('\r');
    await until(() => !frame().includes('who:'), 'the filter cleared');
  } finally {
    app.unmount();
  }
});

test('/find who:none on Work items leaves only the unassigned', async () => {
  lastApp = render(React.createElement(App, { keel, poll: false, openUrl: () => {} }));
  const app = lastApp;
  try {
    await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
    app.stdin.write('4');
    await until(() => frame().includes('╭─ Work items'), 'the Work items tab');
    app.stdin.write('/');
    await type(app.stdin, 'find who:none');
    app.stdin.write('\r');
    await until(() => frame().includes('Assigned to nobody') || frame().includes('Unassigned') || frame().includes('unassigned'), 'an unassigned item');
    // Its rows (the hint with the count may not fit 100 columns): as many as there are unassigned.
    const unassigned = (await keel.service.workItems()).items.filter((w) => !w.assignedTo).map((w) => String(w.id));
    const listed = frame().split('\n').map((l) => l.match(/^│[❯ ] \S \S+(?: \S+)?\s+(\d+) /)?.[1]).filter(Boolean);
    assert.deepEqual([...listed].sort(), [...unassigned].sort());
  } finally {
    app.unmount();
  }
});
