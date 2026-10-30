import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameReader, ProtocolError, Reader, T, Writer, entryOf, kindOf, modeText } from '../src/sftp-proto.js';

test('a packet: length, type, payload; strings, numbers and attributes read back', () => {
  const packet = new Writer().u32(7).string('héllo').u64(2 ** 40 + 5).attrs({ size: 12, permissions: 0o100644, atime: 1, mtime: 2 }).toPacket(T.OPEN);
  assert.equal(packet.readUInt32BE(0), packet.length - 4);
  assert.equal(packet[4], T.OPEN);
  const r = new Reader(packet.subarray(5));
  assert.equal(r.u32(), 7);
  assert.equal(r.text(), 'héllo');
  assert.equal(r.u64(), 2 ** 40 + 5);
  assert.deepEqual(r.attrs(), { size: 12, permissions: 0o100644, atime: 1, mtime: 2 });
});

test('an attributes block with nothing in it, and one with extensions the reader skips', () => {
  assert.deepEqual(new Reader(new Writer().attrs().toPacket(0).subarray(5)).attrs(), {});
  const w = new Writer().u32(0x80000000 | 1).u64(9).u32(2).string('a').string('b').string('c').string('d').u32(99);
  const r = new Reader(Buffer.concat(w.parts));
  assert.deepEqual(r.attrs(), { size: 9 });
  assert.equal(r.u32(), 99);
});

test('reading past the end is a ProtocolError, not a crash', () => {
  assert.throws(() => new Reader(Buffer.from([0, 0])).u32(), ProtocolError);
  assert.throws(() => new Reader(Buffer.from([0, 0, 0, 9, 1])).string(), ProtocolError);
});

test('frames are cut from a stream however it arrives, and a silly length is refused', () => {
  const a = new Writer().u32(1).toPacket(T.STATUS);
  const b = new Writer().u32(2).string('x').toPacket(T.DATA);
  const all = Buffer.concat([a, b]);
  const reader = new FrameReader();
  const got = [];
  for (let i = 0; i < all.length; i += 3) got.push(...reader.push(all.subarray(i, i + 3)));
  assert.deepEqual(got.map((f) => f.type), [T.STATUS, T.DATA]);
  assert.equal(new Reader(got[1].payload).u32(), 2);
  assert.throws(() => new FrameReader().push(Buffer.from([0x7f, 0xff, 0xff, 0xff, 1])), ProtocolError);
  assert.throws(() => new FrameReader().push(Buffer.from([0, 0, 0, 0])), ProtocolError);
});

test('kinds and modes from permissions', () => {
  assert.equal(kindOf(0o040755), 'dir');
  assert.equal(kindOf(0o100644), 'file');
  assert.equal(kindOf(0o120777), 'link');
  assert.equal(kindOf(0o010644), 'other');
  assert.equal(kindOf(undefined), 'file');
  assert.equal(modeText(0o100640), 'rw-r-----');
  assert.deepEqual(entryOf('a', { size: 5, permissions: 0o040755, mtime: 10 }), { name: 'a', kind: 'dir', size: 5, mode: 'rwxr-xr-x', modified: 10000 });
});
