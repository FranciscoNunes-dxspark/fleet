import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRows } from '../client/src/diffrows.js';

const ctx = (a, b, text) => ({ t: ' ', a, b, text });
const del = (a, text) => ({ t: '-', a, text });
const add = (b, text) => ({ t: '+', b, text });

test('unchanged lines sit on both sides', () => {
  const l = ctx(1, 1, 'same');
  assert.deepEqual(splitRows([l]), [{ left: l, right: l }]);
});

test('a removed line pairs with the added line that follows it', () => {
  const rows = splitRows([ctx(1, 1, 'a'), del(2, 'old'), add(2, 'new'), ctx(3, 3, 'c')]);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].left.text, 'old');
  assert.equal(rows[1].right.text, 'new');
});

test('uneven runs leave the shorter side empty', () => {
  const rows = splitRows([del(1, 'x'), add(1, 'y1'), add(2, 'y2'), add(3, 'y3')]);
  assert.deepEqual(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null]), [['x', 'y1'], [null, 'y2'], [null, 'y3']]);
});

test('an added line with nothing removed before it has an empty left side', () => {
  const rows = splitRows([ctx(1, 1, 'a'), add(2, 'new'), ctx(2, 3, 'b')]);
  assert.equal(rows[1].left, null);
  assert.equal(rows[1].right.text, 'new');
});
