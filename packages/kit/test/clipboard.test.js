import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { pasteOnCtrlV, readClipboard } from '../clipboard.js';

test("the clipboard's text, with Windows line endings made plain, or '' when it can't be read", async () => {
  assert.equal(await readClipboard({ read: async () => 'one\r\ntwo\rthree' }), 'one\ntwo\nthree');
  assert.equal(await readClipboard({ read: async () => null }), '');
  assert.equal(await readClipboard({ read: async () => Promise.reject(new Error('no xclip')) }), '');
});

test('ctrl+v, sent on as a key, is taken out of what Ink reads and the clipboard comes in its place', async () => {
  const stdin = new PassThrough();
  stdin.setEncoding('utf8');
  pasteOnCtrlV(stdin, { read: async () => 'pasted text' });
  // What Ink does: read until null on each 'readable'.
  const got = [];
  stdin.on('readable', () => {
    let chunk;
    while ((chunk = stdin.read()) !== null) got.push(chunk);
  });
  stdin.write('a');
  await new Promise((r) => setImmediate(r));
  stdin.write('\x16');
  await new Promise((r) => setTimeout(r, 20));
  stdin.write('b');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ['a', 'pasted text', 'b']);
});
