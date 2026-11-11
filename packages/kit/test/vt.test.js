import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualTerminal } from '../vt.js';

test('rows pushed off the top are kept as history when asked, and not on the alternate screen', () => {
  const vt = new VirtualTerminal(5, 2, { scrollback: 3 });
  vt.write('a\r\nb\r\nc\r\nd\r\ne\r\nf');
  const text = (i) => vt.historyAnsi(i).replace(/\x1b\[[0-9;]*m/g, '').trim();
  assert.deepEqual([0, 1, 2].map(text), ['b', 'c', 'd']);
  assert.equal(vt.history.length, 3, 'the oldest go past the limit');
  const plain = new VirtualTerminal(5, 2);
  plain.write('a\r\nb\r\nc');
  assert.equal(plain.history.length, 0, 'no scrollback unless asked for');
  const alt = new VirtualTerminal(5, 2, { scrollback: 3 });
  alt.write('\x1b[?1049hx\r\ny\r\nz');
  assert.equal(alt.history.length, 0, 'an app that owns the screen leaves no history');
});

test('rowAnsi can show the cursor cell reversed', () => {
  const vt = new VirtualTerminal(4, 1);
  vt.write('abc');
  assert.match(vt.rowAnsi(0, 1), /a\x1b\[7mb\x1b\[27mc/);
  assert.doesNotMatch(vt.rowAnsi(0), /\x1b\[7m/);
});

test('fit keeps what is on the screen: columns cut or padded, rows from the top into history, the cursor on its text', () => {
  const vt = new VirtualTerminal(6, 4, { scrollback: 10 });
  vt.write('one\r\ntwo\r\nthree\r\nfour');
  const text = () => Array.from({ length: vt.rows }, (_, y) => vt.rowText(y));
  vt.fit(6, 2);
  assert.deepEqual(text(), ['three', 'four']);
  assert.equal(vt.history.length, 2, 'the rows taken from the top are kept');
  assert.equal(vt.y, 1);
  vt.fit(3, 3);
  assert.deepEqual(text(), ['thr', 'fou', ''], 'columns are cut and a row comes in at the bottom');
  assert.equal(vt.columns, 3);
  vt.write('\r\nx');
  assert.equal(vt.rowText(2), 'x');
  assert.doesNotThrow(() => vt.historyAnsi(0), 'a row from when the screen was wider still draws');
  vt.fit(8, 3);
  assert.equal(vt.chars[0].length, 8);
});

test('a stream draws the same however its chunks are cut, colours looked up again from where they started', () => {
  const stream =
    '\x1b[H\x1b[38;2;1;2;3mab\x1b[1mcd\x1b[22;48;5;200mef\x1b[0mgh\r\n\x1b[38:2::9:8:7mij\x1b[4:3mkl\x1b[m' +
    '\x1b]0;t\x07\x1b[2;3Hwö🎉\x1b[K\x1b7\x1b[31mx\x1b8y\x1b[?25l';
  const run = (chunks) => {
    const vt = new VirtualTerminal(12, 3);
    const out = chunks.map((c) => vt.write(c)).join('');
    return { out, rows: [0, 1, 2].map((y) => vt.rowAnsi(y)), x: vt.x, y: vt.y, style: vt.style, attrs: vt.attrs };
  };
  const whole = run([stream]);
  assert.match(whole.rows[0], /\x1b\[0;38;2;1;2;3mab\x1b\[0;1;38;2;1;2;3mcd/);
  // Cut anywhere but inside a character: the host's StringDecoder only ever hands over whole ones.
  for (let cut = 1; cut < stream.length; cut++) {
    if (/[\uDC00-\uDFFF]/.test(stream[cut])) continue;
    assert.deepEqual(run([stream.slice(0, cut), stream.slice(cut)]), whole, `cut at ${cut}`);
  }
  // The same colour change from the same style, in a terminal of its own, lands on the same style.
  const other = new VirtualTerminal(4, 1);
  other.write('\x1b[1m\x1b[38;2;1;2;3mz');
  assert.equal(other.style, '1;38;2;1;2;3');
  other.write('\x1b[22m');
  assert.equal(other.style, '38;2;1;2;3', 'a style looked up is never changed in place by the next');
});
