import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffText } from '../cli/format.js';
import { buildDiff } from '../server/domain/filediff.js';

test('a file\'s diff reads as +, - and context lines under its hunk header', () => {
  const text = diffText({ path: '/src/a.js' }, buildDiff('a\nb\nc\n', 'a\nB\nc\n'));
  assert.deepEqual(text.split('\n'), ['/src/a.js', '', '+1 -1', '', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c']);
  assert.match(diffText({ path: '/x.png' }, buildDiff('\0', 'a')), /binary/);
  assert.match(diffText({ path: '/y', originalPath: '/z' }, buildDiff('a', 'a')), /\(was \/z\)[\s\S]*No lines changed/);
});
