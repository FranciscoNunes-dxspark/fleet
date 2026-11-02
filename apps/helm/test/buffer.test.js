import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as b from '../src/buffer.js';
import { highlight, withCursor, fromColumn } from '../src/highlight.js';

test('typing, new lines keep the indent and open a block one deeper', () => {
  let s = b.create('if ($x) {');
  s = b.move(s, 'end');
  s = b.newline(s);
  assert.deepEqual([s.row, s.col], [1, 2]);
  s = b.insert(s, 'foo');
  s = b.newline(s);
  assert.equal(b.textOf(s), 'if ($x) {\n  foo\n  ');
});

test('backspace joins lines and takes an indent step over spaces; delete joins from above', () => {
  let s = b.create('ab\n    cd');
  s = { ...s, row: 1, col: 4 };
  s = b.backspace(s);
  assert.equal(b.currentLine(s), '  cd');
  s = { ...s, col: 0 };
  s = b.backspace(s);
  assert.equal(b.textOf(s), 'ab  cd');
  assert.deepEqual([s.row, s.col], [0, 2]);
  s = b.del({ ...s, col: 2 });
  assert.equal(b.textOf(s), 'ab cd');
});

test('pasting several lines and tabs', () => {
  const s = b.insert(b.create('xy'), 'a\r\n\tb\nc');
  assert.equal(b.textOf(s), 'a\n  b\ncxy');
  assert.deepEqual([s.row, s.col], [2, 1]);
});

test('moving clamps the column, wraps at line ends, and home goes to the indent first', () => {
  let s = b.create('    long line\nab');
  s = b.move({ ...s, col: 10 }, 'down');
  assert.deepEqual([s.row, s.col], [1, 2]);
  s = b.move(s, 'right');
  assert.deepEqual([s.row, s.col], [1, 2]);
  s = b.move({ ...s, row: 0, col: 8 }, 'home');
  assert.equal(s.col, 4);
  assert.equal(b.move(s, 'home').col, 0);
  assert.equal(b.scrollFor(12, 0, 10), 3);
  assert.equal(b.scrollFor(2, 5, 10), 2);
});

test('colouring tells comments, strings, variables, parameters, commands and keywords apart', () => {
  const parts = highlight('foreach ($i in 1..3) { Get-Item -Path "a b" # note').map((s) => s.text);
  for (const want of ['foreach', '$i', 'Get-Item', '-Path', '"a b"', '# note']) assert.ok(parts.includes(want), want);
  assert.equal(highlight('x = 1').map((s) => s.text).join(''), 'x = 1');
});

test('the cursor is one inverse character, and sideways scrolling cuts from the left', () => {
  const segs = withCursor(highlight('$a = 5'), 1);
  assert.equal(segs.map((s) => s.text).join(''), '$a = 5');
  assert.equal(segs.filter((s) => s.inverse).map((s) => s.text).join(''), 'a');
  assert.equal(withCursor([{ text: 'ab' }], 2).at(-1).text, ' ');
  assert.equal(fromColumn([{ text: 'abc' }, { text: 'def' }], 4).map((s) => s.text).join(''), 'ef');
});
