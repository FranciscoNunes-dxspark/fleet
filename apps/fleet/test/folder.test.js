import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, sep } from 'node:path';
import { stringWidth } from '@fleet/kit/text.js';
import { completeFolder, editLine, expandHome, lineOf, renderAsk, resolveFolder, shortFolder } from '../src/folder.js';

const plain = (s) => s.replace(/\x1b\[[\d;]*m/g, '');

test('the line editor: typing, moving, deleting, and ↵, esc and tab said', () => {
  let { line, done } = editLine(lineOf('/srv'), '/app');
  assert.deepEqual([line, done], [{ text: '/srv/app', cursor: 8 }, null]);
  ({ line } = editLine(line, '\x1b[D\x1b[D\x7f'));
  assert.deepEqual(line, { text: '/srv/pp', cursor: 5 });
  ({ line } = editLine(line, '\x01x\x05y'));
  assert.deepEqual(line, { text: 'x/srv/ppy', cursor: 9 });
  ({ line } = editLine(line, '\x17'));
  assert.deepEqual(line, { text: 'x/srv/', cursor: 6 });
  ({ line } = editLine(line, '\x15'));
  assert.deepEqual(line, { text: '', cursor: 0 });
  assert.equal(editLine(line, 'a\r').done, 'submit');
  assert.equal(editLine(line, 'a\r').line.text, 'a');
  assert.equal(editLine(line, '\x1b').done, 'cancel');
  assert.equal(editLine(line, '\t').done, 'complete');
  // The mouse and the arrows up and down do nothing.
  assert.deepEqual(editLine(line, '\x1b[<0;3;4M\x1b[A').line, line);
});

test('folders resolve from the fleet\'s folder, ~ the home folder, and read back from ~', () => {
  // The home folder as the system gives it: with a drive and backslashes on Windows.
  const home = resolve('/home/me');
  assert.equal(resolveFolder('sub', { cwd: '/work', home }), resolve('/work/sub'));
  assert.equal(resolveFolder('~/code', { cwd: '/work', home }), join(home, 'code'));
  assert.equal(expandHome('~', home), home);
  assert.equal(shortFolder(join(home, 'code'), home), `~${sep}code`);
  assert.equal(shortFolder(resolve('/elsewhere'), home), resolve('/elsewhere'));
});

test('tab completes one folder whole, several as far as they agree, hidden ones only when asked', () => {
  const listed = { [resolve('/w')]: ['api', 'app', 'apple', '.git', 'web'], [resolve('/w/web')]: ['src'] };
  const readdir = (dir) => listed[dir] ?? [];
  const at = { cwd: '/w', home: '/h', readdir, caseless: false };
  assert.deepEqual(completeFolder('w', at), { text: 'web/', matches: ['web'] });
  assert.deepEqual(completeFolder('web/s', at), { text: 'web/src/', matches: ['src'] });
  assert.deepEqual(completeFolder('ap', at), { text: 'ap', matches: ['api', 'app', 'apple'] });
  assert.deepEqual(completeFolder('app', at), { text: 'app', matches: ['app', 'apple'] });
  assert.equal(completeFolder('', at).matches.includes('.git'), false);
  assert.deepEqual(completeFolder('.g', at).matches, ['.git']);
  assert.deepEqual(completeFolder('zzz', at), { text: 'zzz', matches: [] });
});

test('the bar asking is exactly as wide as the screen, the cursor kept in sight', () => {
  const line = lineOf('/a/very/long/folder/name/that/goes/on');
  for (const width of [30, 60, 120]) {
    const bar = renderAsk({ label: 'Move the fleet to', line, hint: 'esc cancels', width });
    assert.equal(stringWidth(plain(bar)), width, `at ${width}`);
  }
  assert.ok(plain(renderAsk({ label: 'Move the fleet to', line, width: 30 })).includes('goes/on'));
});
