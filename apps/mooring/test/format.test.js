import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateText, durationText, percentOf, plainText, rateText, sizeText } from '../src/format.js';
import { shellQuote } from '../src/sftp.js';

const ESC = '\x1b';

test('sizes, rates and durations', () => {
  assert.equal(sizeText(0), '0 B');
  assert.equal(sizeText(1023), '1023 B');
  assert.equal(sizeText(1536), '1.5 KB');
  assert.equal(sizeText(20 * 1024), '20 KB');
  assert.equal(sizeText(5 * 1024 * 1024 * 1024), '5.0 GB');
  assert.equal(sizeText(null), '');
  assert.equal(rateText(2 * 1024 * 1024), '2.0 MB/s');
  assert.equal(rateText(0), '');
  assert.equal(durationText(5), '5s');
  assert.equal(durationText(125), '2m 05s');
  assert.equal(durationText(3720), '1h 02m');
});

test('dates: this year with the time, earlier years with the year', () => {
  const now = new Date(2026, 9, 30, 12, 0).getTime();
  assert.equal(dateText(new Date(2026, 9, 5, 9, 7).getTime(), now), 'Oct  5 09:07');
  assert.equal(dateText(new Date(2025, 0, 22, 9, 7).getTime(), now), 'Jan 22  2025');
  assert.equal(dateText(null, now), '');
});

test('percent: capped, and unknown without a total', () => {
  assert.equal(percentOf(50, 200), 25);
  assert.equal(percentOf(300, 200), 100);
  assert.equal(percentOf(0, 0), 100);
  assert.equal(percentOf(5, null), null);
});

test('output from a server is made safe to draw: colours, cursor moves, titles and links go', () => {
  assert.equal(plainText(`${ESC}[31mred${ESC}[0m and ${ESC}[2J${ESC}[Hgone`), 'red and gone');
  assert.equal(plainText(`a${ESC}]0;title\x07b${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\c`), 'ablinkc');
  assert.equal(plainText('a\tb\r\nc\x07'), 'a    b\nc');
  assert.equal(plainText(`x${ESC}My`), 'xy');
});

test('a word for a POSIX shell: single quotes, closed and reopened around a quote', () => {
  assert.equal(shellQuote('/var/www'), "'/var/www'");
  assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
  assert.equal(shellQuote('$(rm -rf /); `x`'), "'$(rm -rf /); `x`'");
});
