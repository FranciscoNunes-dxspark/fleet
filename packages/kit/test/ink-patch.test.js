// patches/ink+6.8.0.patch (the same in every app of the family): Ink measures, cuts and joins its
// frames faster, and gives the same frames as without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { EventEmitter } from 'node:events';
import { VirtualTerminal } from '../vt.js';

// Colours on, before chalk (under Ink) looks; and not in CI, where Ink draws nothing (is-in-ci).
process.env.FORCE_COLOR = '3';
delete process.env.CI;
delete process.env.CONTINUOUS_INTEGRATION;
const React = (await import('react')).default;
const { Box, render, renderToString, Text } = await import('ink');

const inkFile = (name) => new URL(name, import.meta.resolve('ink'));
const { lineWidth, widestLine } = await import(inkFile('./text-width.js'));
// The string-width Ink itself uses, wherever npm put it.
const stringWidth = (await import(pathToFileURL(createRequire(inkFile('./index.js')).resolve('string-width')))).default;

test('the patched Ink measures lines as string-width does', () => {
  const samples = ['', 'plain', '\x1b[31mred\x1b[39m text', '\x1b[1;38;2;1;2;3mbold é\x1b[0m', '│ ● ❯ ─', '漢字 テスト', '👍 ok', '👍🏽', '❤️', '©', 'é', '한국어', '­', '҃x', '\x1b]8;;http://x\x07link\x1b]8;;\x07', '\x1b[31m漢\x1b[39m👍'];
  for (const s of samples) assert.equal(lineWidth(s), stringWidth(s), JSON.stringify(s));
  for (let c = 0x20; c < 0x30000; c += 7) {
    if (c >= 0xd800 && c < 0xe000) continue;
    const s = `a${String.fromCodePoint(c)}\x1b[32m${String.fromCodePoint(c)}\x1b[39m`;
    assert.equal(lineWidth(s), stringWidth(s), JSON.stringify(s));
  }
  assert.equal(widestLine('ab\n\x1b[31m漢字\x1b[39m!\nx'), 5);
});

test('the patched Ink draws colours, wide characters, clipping and wrapping as Ink does', () => {
  const h = React.createElement;
  const tree = h(
    Box,
    { flexDirection: 'column', width: 24 },
    h(
      Box,
      { borderStyle: 'round', borderColor: 'blue', width: 24, overflow: 'hidden', flexDirection: 'column' },
      h(Text, { wrap: 'truncate' }, h(Text, { color: 'green' }, '❯ '), h(Text, { bold: true }, 'fix 漢字 the parser'), h(Text, { dimColor: true }, ' 3d')),
      h(Text, { backgroundColor: 'gray' }, h(Text, { color: 'red' }, '● '), 'naïve café 👍'),
      h(Box, { marginLeft: -3, width: 40 }, h(Text, { color: 'cyan' }, '│ cut on the left and on the right side')),
    ),
    h(Text, { wrap: 'wrap' }, h(Text, { color: 'yellow' }, 'wrapped '), 'words that go on past the width'),
  );
  // Ink 6.8.0's own frame, unpatched.
  const frame =
    '\x1b[34m╭──────────────────────╮\x1b[39m\n\x1b[34m│\x1b[32m❯ \x1b[39m\x1b[1mfix 漢字 the parser…\x1b[22m\x1b[34m│\x1b[39m\n' +
    '\x1b[34m│\x1b[100m\x1b[31m● \x1b[39mnaïve café 👍\x1b[49m       \x1b[34m│\x1b[39m\n\x1b[34m│\x1b[36mut on the left and on \x1b[34m│\x1b[39m\n' +
    '\x1b[34m╰──────────────────────╯\x1b[39m\n\x1b[33mwrapped \x1b[39mwords that go on\n past the width';
  for (let i = 0; i < 3; i++) assert.equal(renderToString(tree, { columns: 30 }), frame, i ? 'from the caches' : 'the first time');
});

test('the patched Ink keeps drawing past its caches’ limits', () => {
  const h = React.createElement;
  for (let i = 0; i < 12000; i += 1) {
    const out = renderToString(h(Box, { width: 12 }, h(Text, { wrap: 'truncate', color: 'red' }, `row ${i} of many`)), { columns: 20 });
    if (i % 1000 === 0 || i > 11990) assert.equal(out.replace(/\x1b\[\d+m/g, ''), `row ${i} of many`.slice(0, 11) + '…');
  }
});

test('the patched Ink draws a frame as tall as the screen again in place, never clearing the terminal', async () => {
  const h = React.createElement;
  const vt = new VirtualTerminal(24, 4);
  const written = [];
  const stdout = Object.assign(new EventEmitter(), { columns: 24, rows: 4, isTTY: true, write: (s) => (written.push(s), vt.write(s), true) });
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, setEncoding() {}, resume() {}, pause() {}, ref() {}, unref() {}, read: () => null });
  const frame = (n) => h(Box, { flexDirection: 'column', width: 24, height: 4 }, ...[0, 1, 2, 3].map((i) => h(Text, { key: i }, `row ${i} of frame ${n}`)));
  const app = render(frame(1), { stdout, stdin, patchConsole: false, exitOnCtrlC: false, maxFps: 0 });
  try {
    for (let n = 2; n <= 4; n++) {
      written.length = 0;
      app.rerender(frame(n));
      await new Promise((r) => setTimeout(r, 20));
      const out = written.join('');
      assert.ok(out.includes(`row 3 of frame ${n}`), 'the frame was drawn');
      // Unpatched, every frame after the first starts with clearing the whole terminal (ESC [2J).
      assert.ok(!out.includes('\x1b[2J'), `frame ${n} cleared the terminal`);
      assert.ok(!out.endsWith('\n'), `frame ${n} ends with a newline`);
      assert.deepEqual([0, 1, 2, 3].map((y) => vt.rowText(y)), [0, 1, 2, 3].map((i) => `row ${i} of frame ${n}`));
    }
  } finally {
    app.unmount();
  }
});
