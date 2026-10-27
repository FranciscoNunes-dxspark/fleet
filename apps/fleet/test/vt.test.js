import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualTerminal } from '../src/vt.js';
import { MIN_SPLIT_COLUMNS, paneAt, splitLayout, takePaneMouse } from '../src/split.js';

const rows = (vt) => Array.from({ length: vt.rows }, (_, y) => vt.rowText(y));

test('text, the tty\'s \\n, wrapping at the edge and scrolling at the bottom', () => {
  const vt = new VirtualTerminal(5, 3);
  vt.write('ab\ncdefgh');
  assert.deepEqual(rows(vt), ['ab', 'cdefg', 'h']);
  vt.write('\r\nx\ny');
  assert.deepEqual(rows(vt), ['h', 'x', 'y']);
  // The last column fills without wrapping until the next character.
  const edge = new VirtualTerminal(3, 2);
  edge.write('abc');
  assert.deepEqual([edge.x, edge.y, rows(edge)], [2, 0, ['abc', '']]);
});

test('cursor moves, erasing, inserting and deleting, as Ink and the apps use them', () => {
  const vt = new VirtualTerminal(10, 4);
  vt.write('\x1b[2J\x1b[Hone\r\ntwo\r\nthree');
  vt.write('\x1b[2;2HX\x1b[1;1H\x1b[2K\x1b[3;3H\x1b[K');
  assert.deepEqual(rows(vt), ['', 'tXo', 'th', '']);
  vt.write('\x1b[2;1H\x1b[2@\x1b[4;1Habcdef\x1b[4;2H\x1b[2P');
  assert.deepEqual(rows(vt), ['', '  tXo', 'th', 'adef']);
  // Log-update's way: erase each line going up, then write from the column start.
  vt.write('\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[Gnew');
  assert.deepEqual(rows(vt), ['', 'new', '', '']);
  vt.write('\x1b7\x1b[4;5Hsaved\x1b8!');
  assert.equal(vt.rowText(1), 'new!');
  assert.equal(vt.rowText(3), '    saved');
});

test('colours and attributes are kept per cell and drawn back as SGR, reset at the end of each row', () => {
  const vt = new VirtualTerminal(6, 1);
  vt.write('\x1b[1;38;2;95;215;135mab\x1b[22mc\x1b[0m\x1b[48;5;236md\x1b[m');
  assert.equal(vt.rowAnsi(0), '\x1b[0m\x1b[0;1;38;2;95;215;135mab\x1b[0;38;2;95;215;135mc\x1b[0;48;5;236md\x1b[0m  \x1b[0m');
  // The colon form, and erasing with the background in use.
  const bce = new VirtualTerminal(4, 1);
  bce.write('\x1b[38:2::1:2:3mx\x1b[44m\x1b[K');
  assert.equal(bce.rowAnsi(0), '\x1b[0m\x1b[0;38;2;1;2;3mx\x1b[0;44m   \x1b[0m');
});

test('wide characters take two cells, and half of one overwritten leaves a blank', () => {
  const vt = new VirtualTerminal(6, 2);
  vt.write('a漢b');
  assert.equal(vt.rowText(0), 'a漢b');
  assert.equal(vt.rowAnsi(0), '\x1b[0ma漢b  \x1b[0m');
  vt.write('\x1b[1;3Hx');
  assert.equal(vt.rowAnsi(0), '\x1b[0ma xb  \x1b[0m');
  // A wide character that doesn't fit at the end of a row goes to the next.
  const edge = new VirtualTerminal(3, 2);
  edge.write('ab漢');
  assert.deepEqual(rows(edge), ['ab', '漢']);
  // A combining mark joins the character before it.
  const mark = new VirtualTerminal(4, 1);
  mark.write('éx');
  assert.equal(mark.rowText(0), 'éx');
});

test("the bell, the clipboard and notifications come back for the terminal; modes and sync are kept; hyperlinks dropped", () => {
  const vt = new VirtualTerminal(10, 2);
  const said = vt.write('a\x07\x1b]52;c;aGk=\x07\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\\x1b]9;done\x1b\\');
  assert.equal(said, '\x07\x1b]52;c;aGk=\x07\x1b]9;done\x1b\\');
  assert.equal(vt.rowText(0), 'alink');
  vt.write('\x1b[?25l\x1b[?2026h');
  assert.equal(vt.cursorShown(), false);
  assert.equal(vt.sync, true);
  vt.write('\x1b[?2026l');
  assert.equal(vt.sync, false);
  // A sequence cut across writes waits for its end.
  vt.write('\x1b[2;');
  vt.write('3Hz');
  assert.equal(vt.rowText(1), '  z');
});

test('dirty rows are the ones drawn on since they were last taken', () => {
  const vt = new VirtualTerminal(4, 3);
  assert.deepEqual(vt.takeDirty(), [0, 1, 2]);
  vt.write('\x1b[2;1Hx');
  assert.deepEqual(vt.takeDirty(), [1]);
  assert.deepEqual(vt.takeDirty(), []);
  vt.write('\x1b[3;1H\n');
  assert.deepEqual(vt.takeDirty(), [0, 1, 2]);
});

test('a scroll region scrolls only its rows', () => {
  const vt = new VirtualTerminal(3, 4);
  vt.write('a\nb\nc\nd\x1b[2;3r\x1b[3;1H\nx');
  assert.deepEqual(rows(vt), ['a', 'c', 'x', 'd']);
});

test('the split: two panes and a divider, mouse reports moved into their pane', () => {
  assert.deepEqual(splitLayout(81), [
    { x: 0, width: 40 },
    { x: 41, width: 40 },
  ]);
  assert.deepEqual(splitLayout(80), [
    { x: 0, width: 39 },
    { x: 40, width: 40 },
  ]);
  const panes = splitLayout(81);
  assert.equal(paneAt(panes, 39), 0);
  assert.equal(paneAt(panes, 40), -1);
  assert.equal(paneAt(panes, 41), 1);
  const { data, reports } = takePaneMouse('a\x1b[<0;45;3Mb\x1b[<0;2;5m\x1b[<0;41;1M\x1b[<64;50;2M', panes);
  assert.equal(data, 'ab');
  assert.deepEqual(reports, [
    { pane: 1, data: '\x1b[<0;4;3M', press: true },
    { pane: 0, data: '\x1b[<0;2;5m', press: false },
    { pane: 1, data: '\x1b[<64;9;2M', press: false },
  ]);
  assert.ok(MIN_SPLIT_COLUMNS >= 20);
});
