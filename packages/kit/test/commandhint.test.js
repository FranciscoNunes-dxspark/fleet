import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withCommandHint } from '../commandhint.js';

const cmds = [{ name: 'add', args: '<name> <target>', desc: 'Save one' }, { name: 'last', desc: 'Show it' }];
const find = (n) => cmds.find((c) => c.name === n);

test('a typed command with parameters keeps them in view, as one row that leaves the line alone', () => {
  const [row] = withCommandHint([], '/add web ', find);
  assert.deepEqual(row, { label: '/add', hint: '<name> <target>', desc: 'Save one', insert: '/add web ', run: false });
});

test('candidates, a name still being typed, a command without parameters and text that is no command get no hint row', () => {
  const items = [{ label: 'x' }];
  assert.equal(withCommandHint(items, '/add w', find), items);
  assert.deepEqual(withCommandHint([], '/ad', find), []);
  assert.deepEqual(withCommandHint([], '/last ', find), []);
  assert.deepEqual(withCommandHint([], '/nope ', find), []);
  assert.deepEqual(withCommandHint([], 'add ', find), []);
});
