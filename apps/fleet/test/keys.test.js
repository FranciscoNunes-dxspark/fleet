import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFIX, keyLength, prefixAction, prefixByte, prefixName, prefixesFor, readKeys, takeBarClicks, PREFIX } from '../src/keys.js';

const run = (input, state = { prefix: false }) => readKeys(state, input);
const sent = (actions) => actions.filter((a) => a.type === 'send').map((a) => a.data).join('');

test('keys go to the app as they came, pastes and mouse reports too', () => {
  const input = 'hello\x1b[A\x1b[<0;5;7M\x1b[<0;5;7m\r';
  const { state, actions } = run(input);
  assert.deepEqual(actions, [{ type: 'send', data: input }]);
  assert.deepEqual(state, { prefix: false });
});

test('the prefix and a key switch, move, quit and help', () => {
  assert.deepEqual(run(`${PREFIX}2`).actions, [{ type: 'prefix', on: true }, { type: 'prefix', on: false }, { type: 'switch', id: 'trawl' }]);
  assert.deepEqual(prefixAction('o'), { type: 'switch', id: 'sonar' });
  assert.deepEqual(prefixAction('6'), { type: 'switch', id: 'locker' });
  assert.deepEqual(prefixAction('8'), { type: 'switch', id: 'bilge' });
  assert.deepEqual(prefixAction('g'), { type: 'switch', id: 'bilge' });
  assert.equal(prefixAction('9'), null);
  assert.deepEqual(prefixAction('l'), { type: 'switch', id: 'locker' });
  assert.deepEqual(prefixAction('7'), { type: 'switch', id: 'mooring' });
  assert.deepEqual(prefixAction('U'), { type: 'switch', id: 'mooring' });
  assert.equal(prefixAction('0'), null);
  assert.deepEqual(prefixAction(']'), { type: 'move', by: 1 });
  assert.deepEqual(prefixAction('n'), { type: 'move', by: 1 });
  assert.deepEqual(prefixAction('p'), { type: 'move', by: -1 });
  assert.deepEqual(prefixAction('q'), { type: 'quit' });
  assert.deepEqual(prefixAction('?'), { type: 'help' });
});

test('the prefix and | or \\ split the screen, x puts it back, tab or an arrow goes to the other pane', () => {
  assert.deepEqual(prefixAction('|'), { type: 'split' });
  assert.deepEqual(prefixAction('\\'), { type: 'split' });
  assert.deepEqual(prefixAction('x'), { type: 'unsplit' });
  for (const key of ['\t', '\x1b[C', '\x1b[D', '\x1bOC']) assert.deepEqual(prefixAction(key), { type: 'pane' });
  // The arrow is read whole after the prefix: nothing of it reaches the app.
  assert.deepEqual(run(`${PREFIX}\x1b[Cz`).actions, [{ type: 'prefix', on: true }, { type: 'prefix', on: false }, { type: 'pane' }, { type: 'send', data: 'z' }]);
  assert.equal(prefixAction('\x1b[A'), null);
});

test('the prefix and m ask for a folder to move the fleet to', () => {
  assert.deepEqual(prefixAction('m'), { type: 'folder' });
  assert.deepEqual(prefixAction('M'), { type: 'folder' });
});

test('the prefix twice sends it, and anything else after it is dropped whole', () => {
  assert.equal(sent(run(`a${PREFIX}${PREFIX}b`).actions), `a${PREFIX}b`);
  // An arrow after the prefix cancels it; its bytes never reach the app as "[A".
  const { actions } = run(`${PREFIX}\x1b[Ax`);
  assert.equal(sent(actions), 'x');
  assert.ok(!actions.some((a) => a.type === 'switch'));
});

test('the prefix waits across reads, and keys before and after it keep their order', () => {
  const first = run(`ab${PREFIX}`);
  assert.deepEqual(first.state, { prefix: PREFIX });
  assert.equal(sent(first.actions), 'ab');
  const second = readKeys(first.state, 'hcd');
  assert.deepEqual(second.actions, [{ type: 'prefix', on: false }, { type: 'switch', id: 'hail' }, { type: 'send', data: 'cd' }]);
  assert.deepEqual(second.state, { prefix: false });
});

test('a key is an escape sequence whole, or one character', () => {
  assert.equal(keyLength('\x1b[1;5A', 0), 6);
  assert.equal(keyLength('\x1bOP', 0), 3);
  assert.equal(keyLength('\x1bx', 0), 2);
  assert.equal(keyLength('\x1b', 0), 1);
  assert.equal(keyLength('😀a', 0), 2);
  assert.equal(keyLength('é', 0), 1);
});

test("clicks on the bar's row are the host's; the rest stay for the app", () => {
  const data = 'a\x1b[<0;12;30M\x1b[<0;12;30m\x1b[<0;3;4Mb\x1b[<64;5;30M';
  const { data: rest, clicks } = takeBarClicks(data, 30);
  assert.equal(rest, 'a\x1b[<0;3;4Mb');
  // Only the press of the left button counts; the release and the wheel go nowhere.
  assert.deepEqual(clicks, [11]);
});

test('alt+1 to alt+9 switch without the prefix, and the keys around them still go to the app', () => {
  const { actions } = run('a\x1b3b\x1b0');
  assert.deepEqual(actions, [
    { type: 'send', data: 'a' },
    { type: 'switch', id: 'sonar' },
    { type: 'send', data: 'b\x1b0' },
  ]);
});

test('the prefix: ctrl+b unless host.json names another, ctrl+] always, and twice is the key itself', () => {
  assert.equal(DEFAULT_PREFIX, 'ctrl+b');
  assert.equal(prefixByte('ctrl+b'), '\x02');
  assert.equal(prefixByte('Ctrl+A'), '\x01');
  assert.equal(prefixByte('C-g'), '\x07');
  assert.equal(prefixByte('ctrl+]'), '\x1d');
  assert.equal(prefixByte('ctrl+\\'), '\x1c');
  assert.equal(prefixByte('ctrl+space'), '\x00');
  for (const bad of ['ctrl+c', 'ctrl+m', 'ctrl+s', 'ctrl+q', 'ctrl+z', 'alt+b', 'b', '', null, 'ctrl+bb']) assert.equal(prefixByte(bad), null, String(bad));
  assert.equal(prefixName('\x02'), 'ctrl+b');
  assert.equal(prefixName('\x1d'), 'ctrl+]');
  assert.equal(prefixName('\x00'), 'ctrl+space');
  assert.deepEqual(prefixesFor(), ['\x02', '\x1d']);
  assert.deepEqual(prefixesFor('\x1d'), ['\x1d']);
  const sent = (actions) => actions.filter((a) => a.type === 'send').map((a) => a.data).join('');
  const b = readKeys({ prefix: false }, '\x02h');
  assert.deepEqual(b.actions.at(-1), { type: 'switch', id: 'hail' });
  assert.equal(sent(readKeys({ prefix: false }, 'a\x02\x02b').actions), 'a\x02b');
  // ctrl+] after ctrl+b isn't a literal: it cancels, as any other key would.
  assert.equal(sent(readKeys({ prefix: false }, '\x02\x1db').actions), 'b');
  // Another prefix: ctrl+b is the app's again.
  const a = readKeys({ prefix: false }, '\x02\x01h', undefined, prefixesFor('\x01'));
  assert.equal(sent(a.actions), '\x02');
  assert.deepEqual(a.actions.at(-1), { type: 'switch', id: 'hail' });
});
