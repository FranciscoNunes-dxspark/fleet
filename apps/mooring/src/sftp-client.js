// An SFTP connection that stays open: one `ssh -s host sftp` whose stdin and stdout carry the protocol
// (sftp-proto.js), so there is one sign-in for the whole session, several requests in flight at once,
// real progress for transfers, and a cancelled transfer leaves the connection as it was. ssh runs with
// no terminal (BatchMode): a key or the agent only, and a host already in known_hosts.
import { spawn as spawnProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import { SessionError } from './errors.js';
import { FrameReader, OPEN, ProtocolError, Reader, STATUS, T, Writer, entryOf } from './sftp-proto.js';
import { missingProgram, problemFrom, sftpServerArgs } from './sftp.js';

// A transfer keeps this many requests in flight, each this many bytes (what every server accepts).
const WINDOW = 16;
const CHUNK = 32 * 1024;

const STATUS_TEXT = {
  [STATUS.NO_SUCH_FILE]: 'No such file or directory',
  [STATUS.PERMISSION_DENIED]: 'Permission denied',
  [STATUS.OP_UNSUPPORTED]: 'The server does not support that',
};

const cancelled = () => new SessionError('Cancelled', { cancelled: true });

export class SftpClient {
  nextId = 1;
  pending = new Map();
  frames = new FrameReader();
  /** The error the connection ended with, once it has. */
  closed = null;

  /** `write(buffer)` sends to the server, `kill()` ends the connection. */
  constructor({ write, kill, onClose }) {
    this.transport = { write, kill };
    this.onClose = onClose;
    this.hello = new Promise((resolve, reject) => (this.greeted = { resolve, reject }));
    this.hello.catch(() => {});
    this.version = null;
  }

  /** Sends INIT; resolves with the server's version once it answers. */
  start() {
    this.transport.write(new Writer().u32(3).toPacket(T.INIT));
    return this.hello;
  }

  receive(chunk) {
    let frames;
    try {
      frames = this.frames.push(chunk);
    } catch (e) {
      return this.fail(new SessionError(e.message));
    }
    for (const { type, payload } of frames) {
      const r = new Reader(payload);
      if (this.version == null) {
        if (type !== T.VERSION) return this.fail(new SessionError("The server didn't answer as an SFTP server does."));
        this.version = r.u32();
        this.greeted.resolve(this.version);
        continue;
      }
      const id = r.u32();
      const waiting = this.pending.get(id);
      // An answer nobody waits for (its transfer was cancelled) is dropped.
      if (!waiting) continue;
      this.pending.delete(id);
      waiting.resolve({ type, r });
    }
  }

  /** The connection is over: every request still waiting fails with `error`. */
  fail(error) {
    if (this.closed) return;
    this.closed = error;
    this.greeted.reject(error);
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    this.transport.kill();
    this.onClose?.(error);
  }

  close() {
    this.fail(new SessionError('The connection was closed.'));
  }

  /**
   * One request: { type, r } of the answer, or a SessionError for a STATUS that isn't OK (`status`
   * says which; `path` names what it was about).
   */
  async call(type, fill, path) {
    if (this.closed) throw this.closed;
    const id = this.nextId;
    this.nextId = (this.nextId + 1) >>> 0 || 1;
    const w = new Writer().u32(id);
    fill?.(w);
    const answer = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.write(w.toPacket(type));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
    if (answer.type === T.STATUS) {
      const code = answer.r.u32();
      if (code !== STATUS.OK) {
        const said = answer.r.text();
        throw new SessionError(`${path ? `${path}: ` : ''}${STATUS_TEXT[code] ?? (said || 'Failure')}`, { status: code });
      }
    }
    return answer;
  }

  async expect(type, fill, path, want) {
    const answer = await this.call(type, fill, path);
    if (answer.type !== want) throw new ProtocolError('The server answered with the wrong kind of reply.');
    return answer.r;
  }

  async realpath(path) {
    const r = await this.expect(T.REALPATH, (w) => w.string(path), path, T.NAME);
    r.u32();
    return r.text();
  }

  stat(path) {
    return this.expect(T.STAT, (w) => w.string(path), path, T.ATTRS).then((r) => r.attrs());
  }

  lstat(path) {
    return this.expect(T.LSTAT, (w) => w.string(path), path, T.ATTRS).then((r) => r.attrs());
  }

  async readlink(path) {
    const r = await this.expect(T.READLINK, (w) => w.string(path), path, T.NAME);
    r.u32();
    return r.text();
  }

  async open(path, flags, attrs) {
    const r = await this.expect(T.OPEN, (w) => (w.string(path), w.u32(flags), w.attrs(attrs)), path, T.HANDLE);
    return r.string();
  }

  async closeHandle(handle) {
    await this.call(T.CLOSE, (w) => w.string(handle));
  }

  /** The entries of a folder: { name, kind, size, mode, modified }, `.` and `..` left out, in the server's order. */
  async readdir(path) {
    const r = await this.expect(T.OPENDIR, (w) => w.string(path), path, T.HANDLE);
    const handle = r.string();
    const entries = [];
    try {
      for (;;) {
        let answer;
        try {
          answer = await this.expect(T.READDIR, (w) => w.string(handle), path, T.NAME);
        } catch (e) {
          if (e.status === STATUS.EOF) break;
          throw e;
        }
        for (let n = answer.u32(); n > 0; n--) {
          const name = answer.text();
          answer.string();
          const attrs = answer.attrs();
          if (name !== '.' && name !== '..') entries.push(entryOf(name, attrs));
        }
      }
    } finally {
      await this.closeHandle(handle).catch(() => {});
    }
    return entries;
  }

  mkdir(path, permissions) {
    return this.call(T.MKDIR, (w) => (w.string(path), w.attrs({ permissions })), path);
  }

  rmdir(path) {
    return this.call(T.RMDIR, (w) => w.string(path), path);
  }

  remove(path) {
    return this.call(T.REMOVE, (w) => w.string(path), path);
  }

  rename(from, to) {
    return this.call(T.RENAME, (w) => (w.string(from), w.string(to)), `${from} → ${to}`);
  }

  /**
   * Reads `remote` (open as `handle`, `size` bytes when the server said) with `WINDOW` reads in
   * flight, handing each piece to `write(data, offset)`. A short answer is asked for again from where
   * it stopped. Resolves with the bytes read.
   */
  readAll(handle, remote, size, write, signal) {
    let next = 0;
    let inflight = 0;
    let total = 0;
    let eofAt = Infinity;
    let failed = null;
    const retry = [];
    const more = () => retry.length > 0 || (next < eofAt && (size == null || next < size));
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const fail = (e) => {
        failed ??= e;
        cleanup();
        reject(failed);
      };
      const onAbort = () => fail(cancelled());
      const read = (chunk) =>
        this.call(T.READ, (w) => (w.string(handle), w.u64(chunk.offset), w.u32(chunk.len)), remote).then(
          async (answer) => {
            if (answer.type !== T.DATA) throw new ProtocolError('The server answered with the wrong kind of reply.');
            const data = answer.r.string();
            if (data.length === 0) {
              eofAt = Math.min(eofAt, chunk.offset);
              return;
            }
            await write(data, chunk.offset);
            total += data.length;
            if (data.length < chunk.len) retry.push({ offset: chunk.offset + data.length, len: chunk.len - data.length });
          },
          (e) => {
            if (e.status !== STATUS.EOF) throw e;
            eofAt = Math.min(eofAt, chunk.offset);
          },
        );
      const pump = () => {
        if (failed) return;
        while (inflight < WINDOW && more()) {
          // What a short answer left over first, else the next piece (no longer than the file).
          const fresh = retry.length === 0;
          const chunk = fresh ? { offset: next, len: size == null ? CHUNK : Math.min(CHUNK, size - next) } : retry.shift();
          if (fresh) next += CHUNK;
          if (chunk.offset >= eofAt) continue;
          inflight++;
          read(chunk).then(() => (inflight--, pump()), fail);
        }
        if (!failed && inflight === 0 && !more()) {
          cleanup();
          resolve(total);
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pump();
    });
  }

  /**
   * Copies the server's file `remote` to `localFile`. `onBytes(n)` hears each piece written. The file
   * ending before its size said it would is an error. A failed or cancelled copy removes what it wrote.
   */
  async download(remote, localFile, { signal, onBytes } = {}) {
    if (signal?.aborted) throw cancelled();
    const handle = await this.open(remote, OPEN.READ);
    let fh;
    try {
      const attrs = await this.expect(T.FSTAT, (w) => w.string(handle), remote, T.ATTRS).then((r) => r.attrs());
      fh = await fsp.open(localFile, 'w');
      const written = await this.readAll(
        handle,
        remote,
        attrs.size,
        async (data, offset) => {
          await fh.write(data, 0, data.length, offset);
          onBytes?.(data.length);
        },
        signal,
      );
      if (attrs.size != null && written !== attrs.size) throw new SessionError(`${remote}: the file changed while it was copied.`);
      await fh.close();
      fh = null;
      if (attrs.mtime != null) await fsp.utimes(localFile, attrs.atime ?? attrs.mtime, attrs.mtime).catch(() => {});
    } catch (e) {
      await fh?.close().catch(() => {});
      fh = null;
      await fsp.rm(localFile, { force: true }).catch(() => {});
      throw e;
    } finally {
      await fh?.close().catch(() => {});
      await this.closeHandle(handle).catch(() => {});
    }
  }

  /**
   * Copies `localFile` to the server's `remote`, `WINDOW` writes in flight, keeping its modification
   * time. `onBytes(n)` hears each piece the server has taken. A failed or cancelled copy removes what
   * it left on the server.
   */
  async upload(localFile, remote, { signal, onBytes } = {}) {
    if (signal?.aborted) throw cancelled();
    const fh = await fsp.open(localFile, 'r');
    let handle;
    try {
      const st = await fh.stat();
      handle = await this.open(remote, OPEN.WRITE | OPEN.CREAT | OPEN.TRUNC);
      const inflight = new Set();
      let failed = null;
      let offset = 0;
      while (offset < st.size && !failed) {
        if (signal?.aborted) throw cancelled();
        if (inflight.size >= WINDOW) await Promise.race(inflight);
        if (failed) break;
        const buffer = Buffer.allocUnsafe(Math.min(CHUNK, st.size - offset));
        const { bytesRead } = await fh.read(buffer, 0, buffer.length, offset);
        if (bytesRead === 0) throw new SessionError(`${localFile}: the file changed while it was copied.`);
        const at = offset;
        offset += bytesRead;
        const piece = buffer.subarray(0, bytesRead);
        const sent = this.call(T.WRITE, (w) => (w.string(handle), w.u64(at), w.string(piece)), remote).then(
          () => onBytes?.(bytesRead),
          (e) => (failed ??= e),
        );
        inflight.add(sent);
        sent.then(() => inflight.delete(sent));
      }
      await Promise.all(inflight);
      if (failed) throw failed;
      const mtime = Math.floor(st.mtimeMs / 1000);
      await this.call(T.FSETSTAT, (w) => (w.string(handle), w.attrs({ atime: mtime, mtime })), remote).catch(() => {});
    } catch (e) {
      if (handle) {
        await this.closeHandle(handle).catch(() => {});
        handle = null;
        await this.remove(remote).catch(() => {});
      }
      throw e;
    } finally {
      await fh.close().catch(() => {});
      if (handle) await this.closeHandle(handle).catch(() => {});
    }
  }
}

// The connections open now, ended when this process exits however it exits.
const live = new Set();
let exitHook = false;

/**
 * Starts ssh for `host` and returns a connected SftpClient, or rejects with ssh's own words (a
 * missing key, an unknown host, a server without SFTP). `command`, `argsFor` and `spawn` are for the tests.
 */
export async function openClient(host, { command = 'ssh', argsFor = sftpServerArgs, spawn = spawnProcess, timeout = 30000 } = {}) {
  let said = '';
  const child = spawn(command, argsFor(host), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const client = new SftpClient({
    write: (buffer) => child.stdin?.write(buffer),
    kill: () => {
      live.delete(child);
      child.kill();
    },
  });
  live.add(child);
  if (!exitHook) {
    exitHook = true;
    process.once('exit', () => {
      for (const c of live) c.kill();
    });
  }
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (d) => (said = (said + d).slice(-4000)));
  child.stdout?.on('data', (chunk) => client.receive(chunk));
  child.stdin?.on('error', () => {});
  child.once('error', (e) => client.fail(new SessionError(missingProgram(command, e))));
  child.once('close', () => client.fail(new SessionError(said.trim() ? problemFrom(said, { command }) : 'The connection closed.')));
  const timer = setTimeout(() => client.fail(new SessionError(`${command} didn't open an SFTP connection within ${Math.round(timeout / 1000)} seconds${said.trim() ? `: ${problemFrom(said, { command })}` : '.'}`)), timeout);
  try {
    await client.start();
  } finally {
    clearTimeout(timer);
  }
  return client;
}
