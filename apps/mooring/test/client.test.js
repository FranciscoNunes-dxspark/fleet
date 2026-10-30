import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openClient } from '../src/sftp-client.js';
import { download, upload } from '../src/transfer.js';
import { serverSpawn, tempDir } from './helpers.js';

const open = (root, env, options) => openClient({ host: 'h' }, { command: process.execPath, argsFor: () => [], spawn: serverSpawn(root, env), ...options });
const bytes = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + 3) % 251));

test('one connection serves a listing, stats, folders, renames and removals', async () => {
  const { dir, done } = tempDir();
  const client = await open(dir);
  try {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    mkdirSync(join(dir, 'sub'));
    assert.equal(await client.realpath('.'), '/home/me');
    const entries = await client.readdir('/');
    assert.deepEqual(entries.map((e) => [e.name, e.kind]).sort(), [['a.txt', 'file'], ['sub', 'dir']]);
    assert.equal(entries.find((e) => e.name === 'a.txt').size, 5);
    assert.equal((await client.stat('/a.txt')).size, 5);
    await client.mkdir('/sub/deeper');
    await client.rename('/a.txt', '/sub/b.txt');
    assert.equal(readFileSync(join(dir, 'sub', 'b.txt'), 'utf8'), 'hello');
    await client.remove('/sub/b.txt');
    await client.rmdir('/sub/deeper');
    assert.equal(existsSync(join(dir, 'sub', 'b.txt')), false);
    // Several requests at once, answered by their ids.
    const many = await Promise.all(Array.from({ length: 20 }, () => client.stat('/sub')));
    assert.equal(many.length, 20);
  } finally {
    client.close();
    done();
  }
});

test("a missing file, a refused call: the server's status becomes the error, with the path", async () => {
  const { dir, done } = tempDir();
  const client = await open(dir);
  try {
    await assert.rejects(client.stat('/nope'), (e) => e.status === 2 && /^\/nope: No such file/.test(e.message));
    await assert.rejects(client.readdir('/nope'), (e) => e.status === 2);
  } finally {
    client.close();
    done();
  }
});

test('a download is byte for byte, in pieces, with progress, and keeps the time', async () => {
  const { dir, done } = tempDir();
  const out = tempDir();
  const client = await open(dir);
  try {
    const data = bytes(32 * 1024 * 5 + 123);
    writeFileSync(join(dir, 'big.bin'), data);
    utimesSync(join(dir, 'big.bin'), 1_700_000_000, 1_700_000_000);
    const seen = [];
    await download(client, '/big.bin', join(out.dir, 'big.bin'), { onProgress: (p) => seen.push(p) });
    assert.ok(readFileSync(join(out.dir, 'big.bin')).equals(data));
    assert.equal(statSync(join(out.dir, 'big.bin')).mtimeMs, 1_700_000_000_000);
    assert.deepEqual([seen[0].bytes, seen.at(-1).bytes, seen.at(-1).total], [0, data.length, data.length]);
    // An empty file.
    writeFileSync(join(dir, 'empty'), '');
    await download(client, '/empty', join(out.dir, 'empty'));
    assert.equal(statSync(join(out.dir, 'empty')).size, 0);
  } finally {
    client.close();
    done();
    out.done();
  }
});

test('a server that answers reads short is asked again for the rest', async () => {
  const { dir, done } = tempDir();
  const out = tempDir();
  const client = await open(dir, { FAKE_SHORT: '10000' });
  try {
    const data = bytes(70000);
    writeFileSync(join(dir, 'f'), data);
    await client.download('/f', join(out.dir, 'f'));
    assert.ok(readFileSync(join(out.dir, 'f')).equals(data));
  } finally {
    client.close();
    done();
    out.done();
  }
});

test('an upload arrives whole, with progress and the time, and a folder goes with its tree', async () => {
  const { dir, done } = tempDir();
  const src = tempDir();
  const back = tempDir();
  const client = await open(dir);
  try {
    const data = bytes(32 * 1024 * 3 + 7);
    writeFileSync(join(src.dir, 'up.bin'), data);
    utimesSync(join(src.dir, 'up.bin'), 1_700_000_000, 1_700_000_000);
    const seen = [];
    await upload(client, join(src.dir, 'up.bin'), '/up.bin', { onProgress: (p) => seen.push(p) });
    assert.ok(readFileSync(join(dir, 'up.bin')).equals(data));
    assert.equal(statSync(join(dir, 'up.bin')).mtimeMs, 1_700_000_000_000);
    assert.equal(seen.at(-1).bytes, data.length);

    mkdirSync(join(src.dir, 'tree', 'inner'), { recursive: true });
    writeFileSync(join(src.dir, 'tree', 'one.txt'), '1');
    writeFileSync(join(src.dir, 'tree', 'inner', 'two.txt'), '22');
    const tree = [];
    await upload(client, join(src.dir, 'tree'), '/tree', { recursive: true, onProgress: (p) => tree.push(p) });
    assert.equal(readFileSync(join(dir, 'tree', 'inner', 'two.txt'), 'utf8'), '22');
    assert.deepEqual([tree.at(-1).bytes, tree.at(-1).total], [3, 3]);
    // Again over the folders that are there already.
    await upload(client, join(src.dir, 'tree'), '/tree', { recursive: true });

    await download(client, '/tree', join(back.dir, 'tree'), { recursive: true });
    assert.equal(readFileSync(join(back.dir, 'tree', 'one.txt'), 'utf8'), '1');
    assert.equal(readFileSync(join(back.dir, 'tree', 'inner', 'two.txt'), 'utf8'), '22');
  } finally {
    client.close();
    done();
    src.done();
    back.done();
  }
});

test('a link in a folder being copied is skipped, not followed', async (t) => {
  const { dir, done } = tempDir();
  const out = tempDir();
  const client = await open(dir);
  try {
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'real'), 'r');
    try {
      symlinkSync(join(dir, 'd', 'real'), join(dir, 'd', 'alias'));
    } catch {
      return t.skip('no symbolic links here (Windows without the right to make them)');
    }
    await download(client, '/d', join(out.dir, 'd'), { recursive: true });
    assert.equal(existsSync(join(out.dir, 'd', 'real')), true);
    assert.equal(existsSync(join(out.dir, 'd', 'alias')), false);
  } finally {
    client.close();
    done();
    out.done();
  }
});

test('cancelling a download stops it, removes the half file and leaves the connection working', async () => {
  const { dir, done } = tempDir();
  const out = tempDir();
  const client = await open(dir, { FAKE_SLOW: '20' });
  try {
    writeFileSync(join(dir, 'big'), bytes(32 * 1024 * 200));
    const ac = new AbortController();
    const call = client.download('/big', join(out.dir, 'big'), { signal: ac.signal, onBytes: () => ac.abort() });
    await assert.rejects(call, (e) => e.cancelled);
    assert.equal(existsSync(join(out.dir, 'big')), false);
    assert.equal((await client.stat('/big')).size, 32 * 1024 * 200);
    await assert.rejects(client.download('/big', join(out.dir, 'big'), { signal: AbortSignal.abort() }), (e) => e.cancelled);
  } finally {
    client.close();
    done();
    out.done();
  }
});

test('cancelling an upload removes what reached the server', async () => {
  const { dir, done } = tempDir();
  const src = tempDir();
  const client = await open(dir);
  try {
    writeFileSync(join(src.dir, 'big'), bytes(32 * 1024 * 100));
    const ac = new AbortController();
    await assert.rejects(client.upload(join(src.dir, 'big'), '/big', { signal: ac.signal, onBytes: () => ac.abort() }), (e) => e.cancelled);
    assert.equal(existsSync(join(dir, 'big')), false);
  } finally {
    client.close();
    done();
    src.done();
  }
});

test("the connection dropping fails what is waiting, and later calls fail at once", async () => {
  const { dir, done } = tempDir();
  const client = await open(dir, { FAKE_DIE_AFTER: '2' });
  try {
    await client.stat('/');
    await client.stat('/');
    await assert.rejects(client.stat('/'), (e) => e.name === 'SessionError');
    await assert.rejects(client.stat('/'), (e) => e.name === 'SessionError');
    assert.ok(client.closed);
  } finally {
    done();
  }
});

test("ssh failing before SFTP starts: its words, with what to do", async () => {
  const { dir, done } = tempDir();
  try {
    await assert.rejects(open(dir, { FAKE_BANNER: 'me@h: Permission denied (publickey).' }), /ssh-add/);
    await assert.rejects(openClient({ host: 'h' }, { command: 'mooring-no-such-program', argsFor: () => [] }), /isn't installed/);
  } finally {
    done();
  }
});
