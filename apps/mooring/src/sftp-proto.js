// The SFTP protocol, version 3 (draft-ietf-secsh-filexfer-02, which OpenSSH speaks), pure: packets
// are a uint32 length, a type byte and the payload; strings are a uint32 length and bytes; numbers
// are big-endian. Mooring runs `ssh -s host sftp` and talks this over its stdin and stdout.
export const T = {
  INIT: 1, VERSION: 2, OPEN: 3, CLOSE: 4, READ: 5, WRITE: 6, LSTAT: 7, FSTAT: 8, SETSTAT: 9, FSETSTAT: 10,
  OPENDIR: 11, READDIR: 12, REMOVE: 13, MKDIR: 14, RMDIR: 15, REALPATH: 16, STAT: 17, RENAME: 18, READLINK: 19,
  STATUS: 101, HANDLE: 102, DATA: 103, NAME: 104, ATTRS: 105,
};

export const STATUS = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, BAD_MESSAGE: 5, NO_CONNECTION: 6, CONNECTION_LOST: 7, OP_UNSUPPORTED: 8 };

// OPEN's flags.
export const OPEN = { READ: 0x01, WRITE: 0x02, APPEND: 0x04, CREAT: 0x08, TRUNC: 0x10, EXCL: 0x20 };

// Which fields an attributes block holds.
const ATTR = { SIZE: 0x01, UIDGID: 0x02, PERMISSIONS: 0x04, ACMODTIME: 0x08, EXTENDED: 0x80000000 };

// The file type bits of `permissions`.
const S_IFMT = 0o170000;
const KINDS = { 0o040000: 'dir', 0o100000: 'file', 0o120000: 'link' };

/** More than this in one packet is not a server we should believe (OpenSSH's own limit is 256 KiB). */
export const MAX_PACKET = 1024 * 1024;

/** What a malformed packet is. */
export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Builds a packet's payload, then `toPacket(type)` frames it. Numbers up to 2^53 are exact. */
export class Writer {
  parts = [];
  u8(n) {
    this.parts.push(Buffer.from([n]));
    return this;
  }
  u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0);
    this.parts.push(b);
    return this;
  }
  u64(n) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    this.parts.push(b);
    return this;
  }
  string(s) {
    const data = Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8');
    this.u32(data.length);
    this.parts.push(data);
    return this;
  }
  /** An attributes block holding what's given: { size, permissions, atime, mtime } (times in seconds). */
  attrs({ size, permissions, atime, mtime } = {}) {
    const times = atime != null && mtime != null;
    this.u32((size != null ? ATTR.SIZE : 0) | (permissions != null ? ATTR.PERMISSIONS : 0) | (times ? ATTR.ACMODTIME : 0));
    if (size != null) this.u64(size);
    if (permissions != null) this.u32(permissions);
    if (times) this.u32(atime).u32(mtime);
    return this;
  }
  toPacket(type) {
    const payload = Buffer.concat(this.parts);
    const head = Buffer.alloc(5);
    head.writeUInt32BE(payload.length + 1);
    head[4] = type;
    return Buffer.concat([head, payload]);
  }
}

/** Reads a payload, throwing a ProtocolError rather than past its end. */
export class Reader {
  pos = 0;
  constructor(buffer) {
    this.buffer = buffer;
  }
  need(n) {
    if (this.pos + n > this.buffer.length) throw new ProtocolError('The server sent a short packet.');
  }
  u8() {
    this.need(1);
    return this.buffer[this.pos++];
  }
  u32() {
    this.need(4);
    const n = this.buffer.readUInt32BE(this.pos);
    this.pos += 4;
    return n;
  }
  u64() {
    this.need(8);
    const n = this.buffer.readBigUInt64BE(this.pos);
    this.pos += 8;
    return Number(n);
  }
  string() {
    const length = this.u32();
    this.need(length);
    const data = this.buffer.subarray(this.pos, this.pos + length);
    this.pos += length;
    return data;
  }
  text() {
    return this.string().toString('utf8');
  }
  /** An attributes block: { size?, uid?, gid?, permissions?, atime?, mtime? }; extensions are skipped. */
  attrs() {
    const flags = this.u32();
    const a = {};
    if (flags & ATTR.SIZE) a.size = this.u64();
    if (flags & ATTR.UIDGID) [a.uid, a.gid] = [this.u32(), this.u32()];
    if (flags & ATTR.PERMISSIONS) a.permissions = this.u32();
    if (flags & ATTR.ACMODTIME) [a.atime, a.mtime] = [this.u32(), this.u32()];
    if ((flags & ATTR.EXTENDED) !== 0) {
      for (let n = this.u32(); n > 0; n--) (this.string(), this.string());
    }
    return a;
  }
}

/** Cuts a byte stream into packets: `push(chunk)` returns the whole ones so far as { type, payload }. */
export class FrameReader {
  buffered = Buffer.alloc(0);
  push(chunk) {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    const frames = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE(0);
      if (length < 1 || length > MAX_PACKET) throw new ProtocolError(`The server sent a packet of ${length} bytes: that isn't SFTP.`);
      if (this.buffered.length < 4 + length) break;
      frames.push({ type: this.buffered[4], payload: this.buffered.subarray(5, 4 + length) });
      this.buffered = this.buffered.subarray(4 + length);
    }
    return frames;
  }
}

/** The kind a `permissions` value says: 'dir', 'file', 'link', else 'other' (and 'file' when it says nothing). */
export function kindOf(permissions) {
  if (permissions == null) return 'file';
  return KINDS[permissions & S_IFMT] ?? 'other';
}

/** `permissions` as the nine letters of `ls -l`. */
export function modeText(permissions) {
  if (permissions == null) return '';
  return 'rwxrwxrwx'
    .split('')
    .map((c, i) => (permissions & (1 << (8 - i)) ? c : '-'))
    .join('');
}

/** A listing entry from a name and its attributes: { name, kind, size, mode, modified (ms) }. */
export function entryOf(name, attrs) {
  return {
    name,
    kind: kindOf(attrs.permissions),
    size: attrs.size ?? 0,
    mode: modeText(attrs.permissions),
    modified: attrs.mtime != null ? attrs.mtime * 1000 : null,
  };
}
