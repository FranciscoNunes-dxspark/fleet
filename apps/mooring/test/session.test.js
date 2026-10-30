import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createSession, removeTree, SessionError } from '../src/session.js';
import { demoSession } from '../src/demo.js';

const fake = fileURLToPath(new URL('./fixtures/fake-sftp.js', import.meta.url));
const real = () =>
  createSession(
    { host: 'h', user: 'me' },
    { command: process.execPath, sshCommand: process.execPath, argsFor: () => [fake], sshArgsFor: (_h, line) => [fake, '--ssh', line] },
  );

test('a real run of the program: home, a listing sorted folders first, and a failure in its words', async () => {
  const s = real();
  assert.equal(await s.home(), '/home/me');
  assert.deepEqual((await s.list('/home/me')).map((e) => [e.name, e.kind]), [['a dir', 'dir'], ['b.txt', 'file']]);
  await assert.rejects(s.list('/nope'), (e) => e instanceof SessionError && /not found/.test(e.message) && e.code === 1);
});

test('a program that is not there says so', async () => {
  const s = createSession({ host: 'h' }, { command: 'mooring-no-such-program' });
  await assert.rejects(s.home(), /isn't installed/);
});

test('exec: output, the command\'s own exit code, and ssh\'s 255 as a failure', async () => {
  const s = real();
  assert.deepEqual(await s.exec('uptime'), { code: 0, stdout: 'ran: uptime\n', stderr: '' });
  assert.equal((await s.exec('fail')).code, 3);
  await assert.rejects(s.exec('unreachable'), (e) => e.code === 255 && /ssh-add/.test(e.message));
  const seen = [];
  await s.exec('echo hi', { onData: (d) => seen.push(d) });
  assert.equal(seen.join(''), 'ran: echo hi\n');
});

test('cancelling stops the program', async () => {
  const s = real();
  const ac = new AbortController();
  const call = s.exec('hang', { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(call, (e) => e.cancelled);
  await assert.rejects(s.exec('hang', { signal: AbortSignal.abort() }), (e) => e.cancelled);
});

test('the demo host keeps a tree: list, mkdir, rename, rm, put and removeTree', async () => {
  const d = demoSession();
  assert.equal(await d.home(), '/home/demo');
  assert.deepEqual((await d.list('/home/demo')).map((e) => e.name), ['backups', 'site', 'notes.txt']);
  await d.mkdir('/home/demo/new');
  await d.put('C:\\x\\a.txt', '/home/demo/new/a.txt', { size: 5 });
  await d.rename('/home/demo/new', '/home/demo/renamed');
  assert.deepEqual((await d.list('/home/demo/renamed')).map((e) => [e.name, e.size]), [['a.txt', 5]]);
  await assert.rejects(d.rmdir('/home/demo/renamed'), /Failure/);
  const gone = [];
  await removeTree(d, '/home/demo/site', { onEach: (p) => gone.push(p) });
  assert.equal(gone.at(-1), '/home/demo/site');
  assert.ok(gone.indexOf('/home/demo/site/img/logo.png') < gone.indexOf('/home/demo/site/img'));
  assert.equal(d.state.tree.has('/home/demo/site'), false);
  await assert.rejects(d.list('/nope'), /No such file/);
  assert.equal((await d.exec('ls /nope')).code, 2);
  assert.equal((await d.exec('frobnicate')).code, 127);
});
