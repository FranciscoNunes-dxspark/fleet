import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringWidth } from '@fleet/kit/text.js';
import { ansi256, barLayout, colour, renderBar, stateMark, tabAt } from '../src/bar.js';
import { SPACES } from '../src/spaces.js';

const spaces = SPACES.map((s, i) => ({ ...s, state: ['running', 'idle', 'exited', 'idle', 'running', 'idle', 'idle'][i], code: i === 2 ? 1 : null }));
const width = (layout) => layout.segments.reduce((n, s) => n + stringWidth(s.text), 0);
const text = (layout) => layout.segments.map((s) => s.text).join('');

test('a tab per space with its key, name and state, the hint at the right, exactly as wide as the screen', () => {
  const layout = barLayout({ spaces, active: 'hail', width: 120 });
  assert.equal(width(layout), 120);
  assert.match(text(layout), /^ 1 Splice ● {2}2 Trawl ○ {2}3 Sonar ✕1 {2}4 Bosun ○ {2}5 Hail ● {2}6 Keel ○ {2}7 Wharf ○ +ctrl\+\] \? help $/);
  assert.equal(layout.segments.find((s) => s.role === 'active').id, 'hail');
  assert.deepEqual(stateMark({ state: 'exited', code: 0 }), '✕0');
});

test('narrower, the hint goes, then the names shrink to letters, then it is cut', () => {
  const noHint = barLayout({ spaces, active: 'splice', width: 90 });
  assert.equal(width(noHint), 90);
  assert.ok(!text(noHint).includes('help'));
  assert.ok(text(noHint).includes('Splice'));
  const letters = barLayout({ spaces, active: 'splice', width: 40 });
  assert.equal(width(letters), 40);
  assert.match(text(letters), /^ 1 S ● {2}2 T ○ /);
  const cut = barLayout({ spaces, active: 'splice', width: 20 });
  assert.equal(width(cut), 20);
  assert.ok(text(cut).endsWith('…'));
});

test("the prefix's keys show while it waits, and a notice in place of the hint", () => {
  assert.match(text(barLayout({ spaces, active: 'splice', width: 120, prefix: true })), /1-7 s t o b h k w · n p · r · q quit · \? help $/);
  // With little room the prefix's keys win over the names.
  const tight = barLayout({ spaces, active: 'splice', width: 92, prefix: true });
  assert.equal(width(tight), 92);
  assert.match(text(tight), / 1 S ● .*q quit/);
  assert.match(text(barLayout({ spaces, active: 'splice', width: 120, notice: 'Handed to Trawl' })), /Handed to Trawl $/);
});

test("a click finds its tab by column, wide characters counted as the terminal does", () => {
  const layout = barLayout({ spaces, active: 'splice', width: 120 });
  assert.equal(tabAt(layout, 0), 'splice');
  const trawl = layout.tabs.find((t) => t.id === 'trawl');
  assert.equal(tabAt(layout, trawl.from), 'trawl');
  assert.equal(tabAt(layout, trawl.to), 'sonar');
  assert.equal(tabAt(layout, 119), undefined);
});

test('the active tab in its accent, as 24-bit colour or the nearest of 256', () => {
  assert.equal(colour('#5fd787', { background: true }), '\x1b[48;2;95;215;135m');
  assert.equal(colour('#5fd787', { truecolor: false }), `\x1b[38;5;${ansi256('#5fd787')}m`);
  assert.equal(ansi256('#000000'), 16);
  assert.equal(ansi256('#ffffff'), 231);
  const line = renderBar(barLayout({ spaces, active: 'splice', width: 120 }), spaces);
  assert.ok(line.includes('\x1b[48;2;95;215;135m\x1b[38;5;16m\x1b[1m 1 Splice ● '));
});
