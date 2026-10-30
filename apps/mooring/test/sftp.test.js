import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseName, joinRemote, missingProgram, parentOf, problemFrom, resolveRemote, sftpServerArgs, sortEntries, sshArgs } from '../src/sftp.js';

test('ssh arguments for the SFTP subsystem and for a command: BatchMode, port, key, target', () => {
  assert.deepEqual(sftpServerArgs({ host: 'web.example.com', user: 'me', port: 2222, key: '/k/id' }), [
    '-s', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-p', '2222', '-i', '/k/id', 'me@web.example.com', 'sftp',
  ]);
  assert.deepEqual(sshArgs({ host: 'h', user: 'u', port: 22 }, 'ls -l').slice(-4), ['-p', '22', 'u@h', 'ls -l']);
  assert.equal(sshArgs({ host: 'h' }, 'uptime')[0], '-T');
  assert.equal(sftpServerArgs({ host: 'h' }).at(-2), 'h');
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

test('sorting puts folders (and links to them) first, then names by case-insensitive order', () => {
  const sorted = sortEntries([
    { name: 'b.txt', kind: 'file' },
    { name: 'Zed', kind: 'dir' },
    { name: 'A.txt', kind: 'file' },
    { name: 'app', kind: 'dir' },
    { name: 'latest', kind: 'link', isDir: true },
  ]);
  assert.deepEqual(sorted.map((e) => e.name), ['app', 'latest', 'Zed', 'A.txt', 'b.txt']);
});

test('errors, with what to do about them', () => {
  assert.match(problemFrom('me@h: Permission denied (publickey).'), /ssh-add/);
  assert.match(problemFrom('Host key verification failed.'), /plain ssh/);
  assert.match(problemFrom('subsystem request failed on channel 0'), /no SFTP subsystem/);
  assert.equal(problemFrom(''), 'It said nothing.');
  assert.equal(problemFrom('Connection refused\nConnection refused'), 'Connection refused');
  assert.match(missingProgram('ssh', { code: 'ENOENT' }), /isn't installed/);
});
