import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSession, removeTree, SessionError } from '../src/session.js';
import { demoSession } from '../src/demo.js';
import { fakeSession, tempDir } from './helpers.js';

test('a session over one connection: home, a listing with folders first, and the work on files', async () => {
  const { dir, done } = tempDir();
  const out = tempDir();
  const s = createSession({ host: 'h', user: 'me' }, fakeSession(dir));
  try {
    mkdirSync(join(dir, 'zdir'));
    writeFileSync(join(dir, 'a.txt'), 'hello');
    assert.equal(await s.home(), '/home/me');
    assert.deepEqual((await s.list('/')).map((e) => [e.name, e.kind]), [['zdir', 'dir'], ['a.txt', 'file']]);
    await s.mkdir('/new');
    await s.rename('/a.txt', '/new/a.txt');
    await s.get('/new/a.txt', join(out.dir, 'a.txt'));
    assert.equal(readFileSync(join(out.dir, 'a.txt'), 'utf8'), 'hello');
    await s.put(join(out.dir, 'a.txt'), '/again.txt');
    assert.equal(readFileSync(join(dir, 'again.txt'), 'utf8'), 'hello');
    await s.rm('/again.txt');
    await assert.rejects(s.list('/nope'), (e) => e instanceof SessionError && /No such file/.test(e.message));
    await removeTree(s, '/new');
    assert.deepEqual((await s.list('/')).map((e) => e.name), ['zdir']);
  } finally {
    s.close();
    done();
    out.done();
  }
});

test('after the connection is closed the next call opens another', async () => {
  const { dir, done } = tempDir();
  let starts = 0;
  const options = fakeSession(dir);
  const s = createSession({ host: 'h' }, { ...options, spawn: (...args) => (starts++, options.spawn(...args)) });
  try {
    await s.home();
    await s.home();
    assert.equal(starts, 1);
    s.close();
    await s.home();
    assert.equal(starts, 2);
  } finally {
    s.close();
    done();
  }
});

test('a missing ssh says so', async () => {
  const s = createSession({ host: 'h' }, { sshCommand: 'mooring-no-such-program' });
  await assert.rejects(s.home(), /isn't installed/);
});

test("exec: output, the command's own exit code, and ssh's 255 as a failure", async () => {
  const { dir, done } = tempDir();
  const s = createSession({ host: 'h', user: 'me' }, fakeSession(dir));
  try {
    assert.deepEqual(await s.exec('uptime'), { code: 0, stdout: 'ran: uptime\n', stderr: '' });
    assert.equal((await s.exec('fail')).code, 3);
    await assert.rejects(s.exec('unreachable'), (e) => e.code === 255 && /ssh-add/.test(e.message));
    const seen = [];
    await s.exec('echo hi', { onData: (d) => seen.push(d) });
    assert.equal(seen.join(''), 'ran: echo hi\n');
  } finally {
    done();
  }
});

test('cancelling a command stops it', async () => {
  const { dir, done } = tempDir();
  const s = createSession({ host: 'h' }, fakeSession(dir));
  try {
    const ac = new AbortController();
    const call = s.exec('hang', { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(call, (e) => e.cancelled);
    await assert.rejects(s.exec('hang', { signal: AbortSignal.abort() }), (e) => e.cancelled);
  } finally {
    done();
  }
});

test('the demo host keeps a tree: list, mkdir, rename, rm, put, progress, cancelling and removeTree', async () => {
  const d = demoSession();
  assert.equal(await d.home(), '/home/demo');
  assert.deepEqual((await d.list('/home/demo')).map((e) => e.name), ['backups', 'site', 'notes.txt']);
  await d.mkdir('/home/demo/new');
  const seen = [];
  await d.put('C:\\x\\a.txt', '/home/demo/new/a.txt', { size: 8, onProgress: (p) => seen.push(p.bytes) });
  assert.deepEqual(seen, [0, 2, 4, 6, 8]);
  await d.rename('/home/demo/new', '/home/demo/renamed');
  assert.deepEqual((await d.list('/home/demo/renamed')).map((e) => [e.name, e.size]), [['a.txt', 8]]);
  await assert.rejects(d.rmdir('/home/demo/renamed'), /Failure/);
  const gone = [];
  await removeTree(d, '/home/demo/site', { onEach: (p) => gone.push(p) });
  assert.equal(gone.at(-1), '/home/demo/site');
  assert.ok(gone.indexOf('/home/demo/site/img/logo.png') < gone.indexOf('/home/demo/site/img'));
  assert.equal(d.state.tree.has('/home/demo/site'), false);
  await assert.rejects(d.list('/nope'), /No such file/);
  assert.equal((await d.exec('ls /nope')).code, 2);
  assert.equal((await d.exec('frobnicate')).code, 127);
  const ac = new AbortController();
  const slow = demoSession({ tick: async () => ac.abort() });
  await assert.rejects(slow.get('/home/demo/notes.txt', 'x', { signal: ac.signal }), (e) => e.cancelled);
});
