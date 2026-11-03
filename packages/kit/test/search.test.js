import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markRanges, matcher, matchingLines } from '../search.js';

test('search: smart case, every match in a line, and the lines that have one', () => {
  assert.deepEqual(matcher('ab')('xAB ab'), [
    [1, 3],
    [4, 6],
  ]);
  // A capital letter: case for case.
  assert.deepEqual(matcher('AB')('xAB ab'), [[1, 3]]);
  assert.equal(matcher(''), null);
  assert.deepEqual(matchingLines(['one', [{ text: 'tw' }, { text: 'o' }], 'three'], 'two'), [1]);
});

test('markRanges restyles just the ranges, across segment boundaries', () => {
  const segs = [
    { text: 'hello ', color: 'a' },
    { text: 'world', color: 'b' },
  ];
  assert.deepEqual(markRanges(segs, [[4, 8]], { bg: 'X' }), [
    { text: 'hell', color: 'a' },
    { text: 'o ', color: 'a', bg: 'X' },
    { text: 'wo', color: 'b', bg: 'X' },
    { text: 'rld', color: 'b' },
  ]);
  assert.equal(markRanges(segs, [], { bg: 'X' }), segs);
});

test('markRanges: overlapping and unordered ranges, and a long line with thousands of matches', () => {
  assert.deepEqual(markRanges([{ text: 'abcdef' }], [[3, 5], [1, 4], [2, 2]], { bg: 'X' }), [
    { text: 'a' },
    { text: 'b', bg: 'X' },
    { text: 'c', bg: 'X' },
    { text: 'd', bg: 'X' },
    { text: 'e', bg: 'X' },
    { text: 'f' },
  ]);
  const line = [{ text: 'ab '.repeat(20_000) }];
  const t = performance.now();
  const out = markRanges(line, matcher('ab')(line[0].text), { bg: 'X' });
  assert.equal(out.length, 40_000);
  assert.ok(performance.now() - t < 1000, `${performance.now() - t} ms`);
});
