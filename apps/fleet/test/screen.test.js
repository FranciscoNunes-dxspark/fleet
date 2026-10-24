import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutputFilter } from '../src/screen.js';

const BAR = '<bar>';

test('the alternate screen, the title stack and a reset stay out; the rest passes as it came', () => {
  const f = new OutputFilter();
  assert.equal(f.push('\x1b[?1049h\x1b[H\x1b[22;0thello\x1b[31mred\x1b]0;title\x07', { bar: BAR }), `\x1b[Hhello\x1b[31mred\x1b]0;title\x07${BAR}`);
  assert.equal(f.push('\x1b[?1049l\x1b[23;0t\x1bc'), '');
  // A list of modes keeps the ones that aren't the alternate screen.
  assert.equal(f.push('\x1b[?1049;25h'), '\x1b[?25h');
});

test('the bar goes in before a synchronized frame ends, once, never inside a sequence or a saved cursor', () => {
  const f = new OutputFilter();
  assert.equal(f.push('\x1b[?2026h\x1b[2Jframe', { bar: BAR }), '\x1b[?2026h\x1b[2Jframe');
  assert.equal(f.push('more\x1b[?2026l', { bar: BAR }), `more${BAR}\x1b[?2026l`);
  // Cut in the middle of a sequence: nothing of it until it's whole, and no bar before then.
  assert.equal(f.push('text\x1b[3', { bar: BAR }), 'text');
  assert.equal(f.push('1mred', { bar: BAR }), `\x1b[31mred${BAR}`);
  // The app's own saved cursor (a drag's selection painted over its frame): the bar waits for the restore.
  assert.equal(f.push('\x1b7\x1b[5;1Hsel', { bar: BAR }), '\x1b7\x1b[5;1Hsel');
  assert.equal(f.push('\x1b8', { bar: BAR }), `\x1b8${BAR}`);
});

test('off screen nothing is written, but the modes it sets are kept for when it comes back', () => {
  const f = new OutputFilter();
  assert.equal(f.push('\x1b[?1002h\x1b[?1006h\x1b[?25lframe', { active: false, bar: BAR }), '');
  const modes = f.restoreModes();
  assert.ok(modes.startsWith('\x1b[?9l\x1b[?1000l'));
  assert.ok(modes.includes('\x1b[?1002h\x1b[?1006h'));
  assert.ok(modes.endsWith('\x1b[?25l'));
  f.push('\x1b[?1002l\x1b[?25h', { active: false });
  assert.ok(!f.restoreModes().includes('\x1b[?1002h'));
  assert.ok(f.restoreModes().endsWith('\x1b[?25h'));
  assert.ok(new OutputFilter().restoreModes().endsWith('\x1b[?25h'));
  // The host's own clicks stay on, whatever the app does with its mouse.
  assert.ok(new OutputFilter().restoreModes().includes('\x1b[?1000h\x1b[?1006h'));
  const off = new OutputFilter();
  assert.equal(off.push('\x1b[?1000h\x1b[?1006h'), '\x1b[?1000h\x1b[?1006h');
  assert.equal(off.wantsMouse(), true);
  assert.equal(off.push('\x1b[?1000l\x1b[?1006l\x1b[?25l'), '\x1b[?25l');
  assert.equal(off.wantsMouse(), false);
});

test('an OSC cut across reads, ended with ESC \\, passes whole', () => {
  const f = new OutputFilter();
  assert.equal(f.push('\x1b]52;c;aGk=', { bar: BAR }), '');
  assert.equal(f.push('\x1b\\x', { bar: BAR }), `\x1b]52;c;aGk=\x1b\\x${BAR}`);
});

test("the app's messages are taken out of its output, whole across reads, on screen or not", () => {
  const got = [];
  const filter = new OutputFilter({ onMessage: (m) => got.push(m) });
  assert.equal(filter.push('a\x1b]5379;{"ready":tr'), 'a');
  assert.equal(filter.push('ue}\x07b\x1b]0;title\x07'), 'b\x1b]0;title\x07');
  assert.equal(filter.push('\x1b]5379;{"handoff":"trawl","line":"/x"}\x1b\\', { active: false }), '');
  assert.deepEqual(got, [{ ready: true }, { handoff: 'trawl', line: '/x' }]);
});
