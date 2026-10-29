// The window's pure parts: the browser's keys and mouse as a terminal's bytes, a style as CSS, the
// characters the window draws itself, and a virtual terminal's rows as the runs it sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBox, splitBoxes } from '../gui/boxes.js';
import { keyBytes, mouseBytes, prefixOf } from '../gui/keymap.js';
import { colour256, parseStyle, styleCss } from '../gui/sgr.js';
import { paintsBlank, rowRuns } from '../src/gui/frames.js';
import { VirtualTerminal } from '../src/vt.js';

const key = (k, mods = {}) => keyBytes({ key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test('keys are what a terminal types', () => {
  assert.equal(key('a'), 'a');
  assert.equal(key('A', { shiftKey: true }), 'A');
  assert.equal(key('é'), 'é');
  assert.equal(key('Enter'), '\r');
  assert.equal(key('Backspace'), '\x7f');
  assert.equal(key('Escape'), '\x1b');
  assert.equal(key('Tab'), '\t');
  assert.equal(key('Tab', { shiftKey: true }), '\x1b[Z');
  assert.equal(key('ArrowUp'), '\x1b[A');
  assert.equal(key('ArrowLeft', { shiftKey: true }), '\x1b[1;2D');
  assert.equal(key('ArrowRight', { ctrlKey: true }), '\x1b[1;5C');
  assert.equal(key('PageDown'), '\x1b[6~');
  assert.equal(key('Delete'), '\x1b[3~');
  assert.equal(key('F1'), '\x1bOP');
  assert.equal(key('F5'), '\x1b[15~');
  assert.equal(key('Home'), '\x1b[H');
  // ctrl and alt as a terminal sends them: the apps' alt+letter shortcuts are ESC and the letter.
  assert.equal(key('c', { ctrlKey: true }), '\x03');
  assert.equal(key('C', { ctrlKey: true, shiftKey: true }), '\x03');
  assert.equal(key(' ', { ctrlKey: true }), '\x00');
  assert.equal(key(']', { ctrlKey: true }), '\x1d');
  assert.equal(key('y', { altKey: true }), '\x1by');
  assert.equal(key('Enter', { altKey: true }), '\x1b\r');
  // Nothing for a modifier alone, or for cmd/super, which are the system's.
  assert.equal(key('Shift', { shiftKey: true }), null);
  assert.equal(key('c', { metaKey: true }), null);
  assert.equal(key('Dead'), null);
});

test('the mouse as SGR reports, counted from 1', () => {
  assert.equal(mouseBytes({ kind: 'down', button: 0, x: 0, y: 0 }), '\x1b[<0;1;1M');
  assert.equal(mouseBytes({ kind: 'up', button: 0, x: 4, y: 2 }), '\x1b[<0;5;3m');
  assert.equal(mouseBytes({ kind: 'move', button: 0, x: 1, y: 1 }), '\x1b[<32;2;2M');
  assert.equal(mouseBytes({ kind: 'down', button: 2, x: 1, y: 1, ctrlKey: true }), '\x1b[<18;2;2M');
  assert.equal(mouseBytes({ kind: 'wheel', deltaY: -3, x: 9, y: 9 }), '\x1b[<64;10;10M');
  assert.equal(mouseBytes({ kind: 'wheel', deltaY: 3, x: 9, y: 9 }), '\x1b[<65;10;10M');
});

test('styles as CSS: the 16 colours, the 256, 24-bit, attributes and inverse video', () => {
  assert.deepEqual(parseStyle(''), { fg: '', bg: '', bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false, hidden: false });
  const s = parseStyle('1;3;38;2;95;215;135;48;5;196');
  assert.equal(s.bold, true);
  assert.equal(s.italic, true);
  assert.equal(s.fg, 'rgb(95,215,135)');
  assert.equal(s.bg, colour256(196));
  assert.equal(colour256(196), 'rgb(255,0,0)');
  assert.equal(colour256(232), 'rgb(8,8,8)');
  assert.equal(parseStyle('31').fg, parseStyle('38;5;1').fg);
  assert.equal(parseStyle('94').fg, colour256(12));
  // In 38;5;7, the 7 is a colour, not inverse video.
  assert.equal(parseStyle('38;5;7').inverse, false);
  assert.match(styleCss('7;38;2;1;2;3'), /^color:var\(--screen-bg\);background:rgb\(1,2,3\);$/);
  assert.match(styleCss('4;9'), /text-decoration:underline line-through/);
  assert.equal(styleCss(''), '');
});

test('box-drawing and block characters are drawn by the window, the text between them kept whole', () => {
  assert.ok(isBox('╭') && isBox('▀') && !isBox('a'));
  assert.deepEqual(splitBoxes('╭─ Commits ─╮'), [
    ['╭', 'tl r'],
    ['─', 'h'],
    [' Commits ', null],
    ['─', 'h'],
    ['╮', 'tr r'],
  ]);
  assert.deepEqual(splitBoxes('plain'), [['plain', null]]);
});

test("a virtual terminal's row as runs: by style, wide characters on their own, blank ends left out", () => {
  const vt = new VirtualTerminal(20, 2);
  vt.write('ab\x1b[1mcd\x1b[0m 漢x   ');
  assert.deepEqual(rowRuns(vt.chars[0], vt.styles[0]), [
    [0, 'ab', '', 2],
    [2, 'cd', '1', 2],
    [4, ' ', '', 1],
    [5, '漢', '', 2],
    [7, 'x', '', 1],
  ]);
  // A coloured background shows even where it's blank.
  vt.write('\r\n\x1b[44m  \x1b[0m');
  assert.deepEqual(rowRuns(vt.chars[1], vt.styles[1]), [[0, '  ', '44', 2]]);
  assert.equal(paintsBlank('48;2;1;2;3'), true);
  assert.equal(paintsBlank('7'), true);
  assert.equal(paintsBlank('38;5;7'), false);
  assert.equal(paintsBlank('38;2;40;41;42'), false);
  assert.deepEqual(rowRuns([' ', ' '], ['', '']), []);
});

test("native charts: round scales, round times, a layout per type, SVG, and what's under the pointer", async () => {
  const { bins, chartLayout, chartSvg, niceScale, pointAt, shortNumber, timeTicks } = await import('../gui/views.js');
  assert.deepEqual(niceScale(0, 27).ticks, [0, 10, 20, 30]);
  assert.deepEqual(niceScale(3, 3).ticks.length > 1, true);
  assert.equal(shortNumber(12345), '12.3k');
  assert.equal(shortNumber(0.256), '0.256');
  const hour = 3_600_000;
  const day0 = new Date(2026, 9, 27, 0, 0, 0).getTime();
  const ticks = timeTicks(day0 + 13 * 60_000, day0 + 24 * hour, 6);
  assert.ok(ticks.length >= 3 && ticks.every((t) => new Date(t).getMinutes() === 0), 'on the hour');
  assert.deepEqual(bins([1, 2, 2, 3, 9], 4).map((b) => b.count), [3, 1, 0, 1]);

  const line = { type: 'line', x: { kind: 'time', values: [day0, day0 + hour, day0 + 2 * hour] }, series: [{ name: 'n', values: [1, null, 3] }, { name: 'm', values: [2, 2, 2] }] };
  const L = chartLayout(line, 600, 300);
  assert.equal(L.type, 'line');
  assert.equal(L.lines[0].points[1], null, 'a gap stays a gap');
  const svg = chartSvg(line, 600, 300);
  assert.match(svg, /^<svg /);
  assert.equal((svg.match(/<path /g) ?? []).length, 2);
  assert.match(svg, />m</, 'a legend with two series');
  const hit = pointAt(line, 600, 300, L.lines[1].points[2][0], 100);
  assert.deepEqual(hit.lines.slice(1), ['n: 3', 'm: 2']);

  const bars = { type: 'bars', labels: ['a', 'b'], series: [{ name: 'n', values: [3, 5] }], share: true };
  const B = chartLayout(bars, 400, 200);
  assert.equal(B.bars.length, 2);
  assert.deepEqual(pointAt(bars, 400, 200, B.bars[1].x + 1, 50).lines, ['b', '5 (62.5%)']);
  assert.equal(chartLayout({ type: 'histogram', values: [1, 2, 3, 4] }, 400, 200).type, 'histogram');
  assert.equal(chartLayout({ type: 'scatter', points: [[1, 2], [3, 4]] }, 400, 200).dots.length, 2);
  assert.equal(chartLayout(line, 30, 20), null, 'too small to draw');
});

test("the prefix's keys in the window: ctrl+b (or the one named), and ctrl+] with or without AltGr", () => {
  const ev = (k, mods = {}) => ({ key: k, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, ...mods });
  assert.equal(prefixOf(ev('b')), '\x02');
  assert.equal(prefixOf(ev('B', { shiftKey: true })), '\x02');
  assert.equal(prefixOf(ev('b', { altKey: true })), null);
  assert.equal(prefixOf(ev('b', { ctrlKey: false })), null);
  assert.equal(prefixOf(ev(']')), '\x1d');
  // AltGr+9 on a Portuguese keyboard: the page sees ctrl and alt.
  assert.equal(prefixOf(ev(']', { altKey: true })), '\x1d');
  assert.equal(prefixOf(ev('a'), 'ctrl+a'), '\x01');
  assert.equal(prefixOf(ev('b'), 'ctrl+a'), null);
  assert.equal(prefixOf(ev(' '), 'ctrl+space'), '\x00');
  assert.equal(prefixOf(ev('b', { metaKey: true })), null);
});
