import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseName, commands, joinRemote, parseLs, parentOf, parsePwd, problemFrom, quotePath, resolveRemote, sftpArgs, sortEntries, sshArgs } from '../src/sftp.js';

const NOW = Date.UTC(2026, 9, 30, 12, 0);

test('sftp arguments: batch from stdin, BatchMode, -P for the port, the key and the target', () => {
  assert.deepEqual(sftpArgs({ host: 'web.example.com', user: 'me', port: 2222, key: '/k/id' }), [
    '-b', '-', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-P', '2222', '-i', '/k/id', 'me@web.example.com',
  ]);
  assert.equal(sftpArgs({ host: '::1' }).at(-1), '[::1]');
  assert.deepEqual(sshArgs({ host: 'h', user: 'u', port: 22 }, 'ls -l').slice(-4), ['-p', '22', 'u@h', 'ls -l']);
});

test('quotePath escapes quotes and backslashes, and refuses a line break', () => {
  assert.equal(quotePath('/a b/c'), '"/a b/c"');
  assert.equal(quotePath('/a"b\\c'), '"/a\\"b\\\\c"');
  assert.throws(() => quotePath('/a\nrm -rf /'));
  assert.equal(commands.rename('/a', '/b c'), 'rename "/a" "/b c"');
  assert.equal(commands.put('C:\\f\\x.txt', '/up/x.txt'), 'put -p "C:\\\\f\\\\x.txt" "/up/x.txt"');
});

test("a server's paths", () => {
  assert.equal(joinRemote('/', 'a'), '/a');
  assert.equal(joinRemote('/home/me', 'a'), '/home/me/a');
  assert.equal(parentOf('/home/me'), '/home');
  assert.equal(parentOf('/home'), '/');
  assert.equal(parentOf('/'), '/');
  assert.equal(baseName('/home/me/'), 'me');
  assert.equal(resolveRemote('/home/me', '../you/./x'), '/home/you/x');
  assert.equal(resolveRemote('/home/me', '/etc'), '/etc');
  assert.equal(resolveRemote('/', '..'), '/');
});

test('ls -la: kinds, sizes, names with spaces, links, dates, and what is left out', () => {
  const out = [
    'sftp> ls -la "/home/me"',
    'drwxr-xr-x    5 me       me           4096 Oct 30 10:00 .',
    'drwxr-xr-x    3 root     root         4096 Jan  2  2025 ..',
    'drwxr-xr-x    2 me       me           4096 Oct 29 09:30 my docs',
    '-rw-r--r--    1 me       me          12345 Jan  2  2025 notes.txt',
    'lrwxrwxrwx    1 me       me             11 Dec 31 23:59 latest -> releases/42',
    '-rw-r-----+   1 me       me              0 Oct 30 11:59 acl.log',
  ].join('\r\n');
  const entries = parseLs(out, NOW);
  assert.deepEqual(entries.map((e) => [e.name, e.kind, e.size]), [
    ['my docs', 'dir', 4096],
    ['notes.txt', 'file', 12345],
    ['latest', 'link', 11],
    ['acl.log', 'file', 0],
  ]);
  assert.equal(entries[2].link, 'releases/42');
  assert.equal(entries[1].modified, Date.UTC(2025, 0, 2));
  assert.equal(entries[0].modified, Date.UTC(2026, 9, 29, 9, 30));
  // December 31 is later than the 30th of October: last year's.
  assert.equal(entries[2].modified, Date.UTC(2025, 11, 31, 23, 59));
  assert.equal(entries[0].mode, 'rwxr-xr-x');
});

test('sorting puts folders first, then names by case-insensitive order', () => {
  const sorted = sortEntries([
    { name: 'b.txt', kind: 'file' },
    { name: 'Zed', kind: 'dir' },
    { name: 'A.txt', kind: 'file' },
    { name: 'app', kind: 'dir' },
  ]);
  assert.deepEqual(sorted.map((e) => e.name), ['app', 'Zed', 'A.txt', 'b.txt']);
});

test('pwd, and errors with what to do about them', () => {
  assert.equal(parsePwd('Remote working directory: /home/me\n'), '/home/me');
  assert.equal(parsePwd('nothing'), null);
  assert.match(problemFrom('me@h: Permission denied (publickey).'), /ssh-add/);
  assert.match(problemFrom('Host key verification failed.'), /plain ssh/);
  assert.equal(problemFrom(''), 'It said nothing.');
  assert.equal(problemFrom('Connection refused\nConnection refused'), 'Connection refused');
});
