import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findHost, hostText, parseAdd, parseTarget, withHost, withoutHost } from '../src/hosts.js';

test('targets: user, host, port, IPv6, and what ssh would read as an option', () => {
  assert.deepEqual(parseTarget('me@web.example.com:2222'), { user: 'me', host: 'web.example.com', port: 2222 });
  assert.deepEqual(parseTarget('web'), { user: undefined, host: 'web', port: undefined });
  assert.deepEqual(parseTarget('me@[::1]:22'), { user: 'me', host: '::1', port: 22 });
  assert.match(parseTarget('-oProxyCommand=x').error, /dash|isn't/);
  assert.match(parseTarget('me@-oProxyCommand=x').error, /dash|isn't/);
  assert.match(parseTarget('h:99999').error, /range/);
  assert.match(parseTarget('a b').error, /isn't/);
});

test('/add: name, target, key and folder in any order', () => {
  assert.deepEqual(parseAdd('web me@web:2222 key=~/.ssh/id_web folder=/var/www'), {
    name: 'web', host: 'web', user: 'me', port: 2222, key: '~/.ssh/id_web', folder: '/var/www',
  });
  assert.deepEqual(parseAdd('web web'), { name: 'web', host: 'web' });
  assert.match(parseAdd('web').error, /Usage/);
  assert.match(parseAdd('we/b h').error, /isn't a name/);
  assert.match(parseAdd('web h nonsense').error, /key=/);
});

test('saved hosts: text, lookup by name or unique prefix, add and remove', () => {
  const a = { name: 'alpha', host: 'a.example.com', user: 'me', port: 22 };
  const b = { name: 'alps', host: '::1' };
  assert.equal(hostText(a), 'me@a.example.com:22');
  assert.equal(hostText(b), '[::1]');
  const hosts = withHost(withHost([], b), a);
  assert.deepEqual(hosts.map((h) => h.name), ['alpha', 'alps']);
  assert.equal(findHost(hosts, 'alps'), b);
  assert.equal(findHost(hosts, 'alph'), a);
  assert.equal(findHost(hosts, 'al'), undefined);
  assert.deepEqual(withoutHost(hosts, 'alpha'), [b]);
  assert.equal(withHost(hosts, { ...a, user: 'you' }).length, 2);
});

test('a command keeps its parameters in view once its name is typed and there is nothing to complete', async () => {
  const { suggestionsFor } = await import('../src/commands.js');
  const [hint] = suggestionsFor('/add web me@web ', { data: { hosts: [], panes: {} } });
  assert.match(hint.hint, /<name> <user@host\[:port\]>/);
  assert.equal(hint.insert, '/add web me@web ', 'enter runs the line as typed');
  assert.equal(hint.run, false);
  assert.equal(suggestionsFor('/hidden on', {})[0].hint, '[on|off]', 'a value typed in full still shows what the command takes');
  assert.equal(suggestionsFor('/last ', {}).length, 0, 'a command with no parameters has nothing to show');
  assert.equal(suggestionsFor('/connect bu', { data: { hosts: [{ name: 'build' }] } })[0].label, 'build', 'candidates still come first');
});
