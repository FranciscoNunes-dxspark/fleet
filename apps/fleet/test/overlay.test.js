import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringWidth } from '@fleet/kit/text.js';
import { boxRows, boxSize, pickerLines, runbookLines, scrollFor } from '../src/overlay.js';
import { panelKeys } from '../src/panels.js';
import { SPACES } from '../src/spaces.js';

const plain = (s) => s.replace(/\x1b\[[\d;]*m/g, '');
const texts = (lines) => lines.map((l) => l.map((s) => s.text).join(''));

const RUNBOOK = {
  name: 'health',
  where: '.fleet/runbooks',
  title: 'Health',
  steps: [
    { app: 'bosun', line: '/start api', prose: 'Start the crew, then wait for its port to open before going on.' },
    { app: 'hail', line: '/send health', prose: '' },
  ],
  outro: 'Done.',
};

test('the box is as wide as asked or the screen allows, its rows exactly that wide, title and hint in its border', () => {
  const size = boxSize({ columns: 60, rows: 12 });
  assert.deepEqual(size, { left: 1, top: 1, width: 58, height: 10, inner: 56, body: 8 });
  const rows = boxRows({ title: 'Runbooks', hint: 'esc close', lines: [[{ text: 'Ünïcode 世界' }]], size });
  assert.equal(rows.length, 10);
  for (const r of rows) assert.equal(stringWidth(plain(r)), 58);
  assert.match(plain(rows[0]), /^┌─ Runbooks ─+┐$/);
  assert.match(plain(rows[1]), /^│ Ünïcode 世界 +│$/);
  assert.match(plain(rows.at(-1)), /^└─ esc close ─+┘$/);
  // A screen too narrow for the hint cuts it.
  const tiny = boxSize({ columns: 14, rows: 6 });
  for (const r of boxRows({ title: 'A long title here', hint: 'a long hint here', lines: [], size: tiny })) assert.equal(stringWidth(plain(r)), tiny.width);
});

test('scrolled so what has the cursor shows, a third of the way down, and ⋯ says there is more', () => {
  assert.equal(scrollFor(5, 10, 4), 0);
  assert.equal(scrollFor(100, 9, 50), 47);
  assert.equal(scrollFor(100, 9, 99), 91);
  assert.equal(scrollFor(100, 9, 1), 0);
  assert.equal(scrollFor(100, 9, 40, 47), 39);
  const size = boxSize({ columns: 40, rows: 8 });
  const lines = Array.from({ length: 30 }, (_, i) => [{ text: `row ${i}` }]);
  const rows = boxRows({ title: 'T', lines, focus: [15, 15], size }).map(plain);
  assert.match(rows[0], /⋯ ┐$/);
  assert.match(rows.at(-1), /⋯ ┘$/);
  assert.ok(rows.some((r) => r.includes('row 15')));
});

test("a runbook's rows: progress, prose above its step, ✓ for handed, › for the cursor, the app by name", () => {
  const { lines, focus } = runbookLines(RUNBOOK, { done: new Set([0]), cursor: 1, width: 30, spaces: SPACES });
  const t = texts(lines);
  assert.equal(t[0], '1 of 2 steps handed over · .fleet/runbooks/health.md');
  assert.deepEqual(t.slice(2, 7), ['Start the crew, then wait for', 'its port to open before going', 'on.', '✓  1  Bosun  /start api', '›  2  Hail   /send health']);
  assert.deepEqual(t.slice(-2), ['', 'Done.']);
  assert.deepEqual(focus, [6, 6]);
  // The tag is in the app's accent.
  assert.ok(lines[5][2].sgr.includes('38;2;255;107;107'));
  assert.deepEqual(runbookLines(RUNBOOK, { cursor: 0, spaces: SPACES }).focus, [2, 3]);
  assert.match(texts(runbookLines({ ...RUNBOOK, steps: [], outro: '' }).lines).join(' '), /No steps yet/);
});

test("the picker's rows, and what it says when there's no runbook", () => {
  const { lines, focus } = pickerLines([RUNBOOK, { ...RUNBOOK, name: 'b', title: 'B', steps: [] }], { cursor: 1, progress: (r) => (r.name === 'health' ? 1 : null) });
  assert.deepEqual(texts(lines), ['  Health  2 steps, 1 done  .fleet/runbooks/health.md', '› B  0 steps  .fleet/runbooks/b.md']);
  assert.deepEqual(focus, [1, 1]);
  const empty = texts(pickerLines([], { dirs: ['.fleet/runbooks', '/home/me/.fleet/runbooks'] }).lines).join('\n');
  assert.match(empty, /No runbooks yet/);
  assert.match(empty, / {2}\/home\/me\/\.fleet\/runbooks/);
  assert.match(empty, /n drafts one/);
});

test('keys in a panel: arrows, ↵, esc and typing, one at a time, the mouse left out', () => {
  assert.deepEqual(panelKeys('\x1b[A\x1bOBj\r\x7f\x15ab\x1b[<0;3;4M\x1b[5~\x1b'), ['up', 'down', 'j', 'enter', 'backspace', 'clear', 'a', 'b', 'pageup', 'esc']);
});
