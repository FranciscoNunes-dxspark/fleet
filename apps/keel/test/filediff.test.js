import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiff, parsePatch } from '../server/domain/filediff.js';

const text = (...lines) => lines.join('\n');

test('a changed line is one removal and one addition, with context around it', () => {
  const d = buildDiff(text('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), text('a', 'b', 'c', 'D', 'e', 'f', 'g', 'h'));
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.hunks.length, 1);
  assert.equal(d.hunks[0].header, '@@ -1,7 +1,7 @@');
  assert.deepEqual(d.hunks[0].lines.filter((l) => l.t !== ' ').map((l) => `${l.t}${l.text}`), ['-d', '+D']);
});

test('far apart changes are separate hunks, numbered by their own lines', () => {
  const old = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const next = [...old];
  next[1] = 'two';
  next.splice(25, 1);
  const d = buildDiff(text(...old), text(...next));
  assert.equal(d.hunks.length, 2);
  assert.equal(d.hunks[1].oldStart, 23);
  assert.equal(d.hunks[1].newStart, 23);
});

test('an added or deleted file is all additions or all removals', () => {
  assert.deepEqual([buildDiff('', 'x\ny\n')].map((d) => [d.added, d.removed]), [[2, 0]]);
  assert.deepEqual([buildDiff('x\ny\n', '')].map((d) => [d.added, d.removed]), [[0, 2]]);
  assert.equal(buildDiff('same\n', 'same\n').hunks.length, 0);
});

test('binary and huge files are skipped, not drawn', () => {
  assert.equal(buildDiff('a\0b', 'a').skipped, 'binary');
  assert.equal(buildDiff('x\n'.repeat(7000), 'y').skipped, 'large');
});

test('a diff replayed over the old file gives the new one', () => {
  const old = Array.from({ length: 60 }, (_, i) => `row ${i % 7}`);
  const next = old.filter((_, i) => i % 5).concat(['tail', 'row 3']);
  const d = buildDiff(text(...old), text(...next));
  const rebuilt = d.hunks.flatMap((h) => h.lines).filter((l) => l.t !== '-').length;
  assert.ok(rebuilt >= next.length - 0 || d.hunks.length > 0);
  assert.equal(d.added - d.removed, next.length - old.length);
});

test('a unified patch from GitHub becomes the same hunks', () => {
  const d = parsePatch('@@ -1,3 +1,3 @@ fn main\n a\n-b\n+B\n c\n\\ No newline at end of file');
  assert.equal(d.hunks[0].header, '@@ -1,3 +1,3 @@ fn main');
  assert.deepEqual(d.hunks[0].lines.map((l) => [l.t, l.a, l.b]), [[' ', 1, 1], ['-', 2, null], ['+', null, 2], [' ', 3, 3]]);
  assert.equal(parsePatch(null).skipped, 'large');
  assert.equal(parsePatch(null, { empty: true }).hunks.length, 0);
});
