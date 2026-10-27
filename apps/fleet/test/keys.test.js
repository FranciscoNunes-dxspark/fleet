import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyLength, prefixAction, readKeys, takeBarClicks, PREFIX } from '../src/keys.js';

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
  assert.deepEqual(prefixAction('K'), { type: 'switch', id: 'keel' });
  assert.deepEqual(prefixAction('6'), { type: 'switch', id: 'keel' });
  assert.deepEqual(prefixAction('7'), { type: 'switch', id: 'wharf' });
  assert.deepEqual(prefixAction('W'), { type: 'switch', id: 'wharf' });
  assert.equal(prefixAction('8'), null);
  assert.deepEqual(prefixAction(']'), { type: 'move', by: 1 });
  assert.deepEqual(prefixAction('n'), { type: 'move', by: 1 });
  assert.deepEqual(prefixAction('p'), { type: 'move', by: -1 });
  assert.deepEqual(prefixAction('q'), { type: 'quit' });
  assert.deepEqual(prefixAction('?'), { type: 'help' });
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
  assert.deepEqual(first.state, { prefix: true });
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

test('alt+1 to alt+6 switch without the prefix, and the keys around them still go to the app', () => {
  const { actions } = run('a\x1b3b\x1b9');
  assert.deepEqual(actions, [
    { type: 'send', data: 'a' },
    { type: 'switch', id: 'sonar' },
    { type: 'send', data: 'b\x1b9' },
  ]);
});
