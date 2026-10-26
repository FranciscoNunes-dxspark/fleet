import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainConsole, plainGlyphs, plainOutput } from '../glyphs.js';
import { stringWidth } from '../text.js';

test("characters Consolas lacks become ones it has, each as wide as the one it replaces", () => {
  assert.equal(plainGlyphs('❯ main ✓ ↵ open ╭─╯ ◌'), '> main √ ┘ open ┌─┘ ○');
  for (const ch of '‖↵⏎↻⇄⇅⊘⎇⎿⏺┏╭╮╯╰▁▂▃▅▆▇▉▊▋▍▎▏△▶▸▾◀◂◆◉◌◐◔⚠✓✔✕✗✢✳✶✻✽❚❤❯') {
    assert.equal(stringWidth(plainGlyphs(ch)), stringWidth(ch), ch);
  }
  assert.equal(plainGlyphs('\x1b[32m● plain text\x1b[0m'), '\x1b[32m● plain text\x1b[0m');
});

test("only Windows' own console swaps them, unless FLEET_GLYPHS says", () => {
  assert.equal(plainConsole({ env: {}, platform: 'win32' }), true);
  assert.equal(plainConsole({ env: { WT_SESSION: 'x' }, platform: 'win32' }), false);
  assert.equal(plainConsole({ env: { TERM_PROGRAM: 'vscode' }, platform: 'win32' }), false);
  assert.equal(plainConsole({ env: { TERM: 'xterm-256color' }, platform: 'win32' }), false);
  assert.equal(plainConsole({ env: {}, platform: 'linux' }), false);
  assert.equal(plainConsole({ env: { FLEET_GLYPHS: 'plain' }, platform: 'linux' }), true);
  assert.equal(plainConsole({ env: { FLEET_GLYPHS: 'full' }, platform: 'win32' }), false);

  const written = [];
  const out = { write: (s) => written.push(s) };
  assert.equal(plainOutput(out, { env: {}, platform: 'win32' }), true);
  out.write('❯ ✗');
  out.write(Buffer.from('❯'));
  assert.equal(written[0], '> x');
  assert.ok(Buffer.isBuffer(written[1]));
  assert.equal(plainOutput({ write() {} }, { env: { WT_SESSION: '1' }, platform: 'win32' }), false);
});
