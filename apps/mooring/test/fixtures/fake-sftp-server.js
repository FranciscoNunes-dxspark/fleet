// Stands in for `ssh -s host sftp`: an SFTP v3 server on stdin and stdout over the folder FAKE_ROOT
// (remote `/x` is `<root>/x`). FAKE_SHORT=<n> answers reads with at most n bytes, FAKE_SLOW=<ms>
// delays each read, FAKE_DIE_AFTER=<n> exits after n requests, FAKE_BANNER prints it on stderr first.
import fs from 'node:fs';
import path from 'node:path';
import { FrameReader, Reader, STATUS, T, Writer } from '../../src/sftp-proto.js';

const root = process.env.FAKE_ROOT;
const short = Number(process.env.FAKE_SHORT) || Infinity;
const slow = Number(process.env.FAKE_SLOW) || 0;
const dieAfter = Number(process.env.FAKE_DIE_AFTER) || Infinity;
if (process.env.FAKE_BANNER) {
  console.error(process.env.FAKE_BANNER);
  process.exit(255);
}
const real = (p) => path.join(root, ...p.split('/').filter(Boolean));
const handles = new Map();
let nextHandle = 1;
let served = 0;

const send = (type, w) => process.stdout.write(w.toPacket(type));
const status = (id, code, message = '') => send(T.STATUS, new Writer().u32(id).u32(code).string(message).string('en'));
const attrsOf = (st) => ({ size: st.size, permissions: (st.isDirectory() ? 0o040000 : st.isSymbolicLink() ? 0o120000 : 0o100000) | (st.mode & 0o777), atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
const fail = (id, e) => status(id, e.code === 'ENOENT' ? STATUS.NO_SUCH_FILE : e.code === 'EACCES' ? STATUS.PERMISSION_DENIED : STATUS.FAILURE, e.message);
const handleFor = (h) => handles.get(h.toString());

function handle(type, r) {
  const id = r.u32();
  try {
    switch (type) {
      case T.REALPATH: {
        const p = r.text();
        send(T.NAME, new Writer().u32(id).u32(1).string(p === '.' ? '/home/me' : `/${p.split('/').filter(Boolean).join('/')}`).string('').attrs());
        break;
      }
      case T.STAT:
      case T.LSTAT: {
        const st = (type === T.STAT ? fs.statSync : fs.lstatSync)(real(r.text()));
        send(T.ATTRS, new Writer().u32(id).attrs(attrsOf(st)));
        break;
      }
      case T.FSTAT:
        send(T.ATTRS, new Writer().u32(id).attrs(attrsOf(fs.fstatSync(handleFor(r.string()).fd))));
        break;
      case T.OPENDIR: {
        const dir = real(r.text());
        const names = fs.readdirSync(dir);
        const h = String(nextHandle++);
        handles.set(h, { dir, names: ['.', '..', ...names], done: false });
        send(T.HANDLE, new Writer().u32(id).string(h));
        break;
      }
      case T.READDIR: {
        const h = handleFor(r.string());
        if (h.done) return status(id, STATUS.EOF, 'EOF');
        h.done = true;
        const w = new Writer().u32(id).u32(h.names.length);
        for (const n of h.names) w.string(n).string(n).attrs(attrsOf(fs.lstatSync(path.join(h.dir, n))));
        send(T.NAME, w);
        break;
      }
      case T.OPEN: {
        const p = real(r.text());
        const flags = r.u32();
        const fd = fs.openSync(p, flags & 0x02 ? ((flags & 0x10) ? 'w' : 'r+') : 'r');
        const h = String(nextHandle++);
        handles.set(h, { fd });
        send(T.HANDLE, new Writer().u32(id).string(h));
        break;
      }
      case T.READ: {
        const h = handleFor(r.string());
        const offset = r.u64();
        const len = Math.min(r.u32(), short);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(h.fd, buf, 0, len, offset);
        const reply = () => (n === 0 ? status(id, STATUS.EOF, 'EOF') : send(T.DATA, new Writer().u32(id).string(buf.subarray(0, n))));
        if (slow) setTimeout(reply, slow);
        else reply();
        break;
      }
      case T.WRITE: {
        const h = handleFor(r.string());
        const offset = r.u64();
        const data = r.string();
        fs.writeSync(h.fd, data, 0, data.length, offset);
        status(id, STATUS.OK);
        break;
      }
      case T.FSETSTAT: {
        const h = handleFor(r.string());
        const a = r.attrs();
        if (a.mtime != null) fs.futimesSync(h.fd, a.atime, a.mtime);
        status(id, STATUS.OK);
        break;
      }
      case T.CLOSE: {
        const key = r.string().toString();
        const h = handles.get(key);
        if (h?.fd != null) fs.closeSync(h.fd);
        handles.delete(key);
        status(id, STATUS.OK);
        break;
      }
      case T.REMOVE:
        fs.unlinkSync(real(r.text()));
        status(id, STATUS.OK);
        break;
      case T.MKDIR:
        fs.mkdirSync(real(r.text()));
        status(id, STATUS.OK);
        break;
      case T.RMDIR:
        fs.rmdirSync(real(r.text()));
        status(id, STATUS.OK);
        break;
      case T.RENAME: {
        const from = real(r.text());
        fs.renameSync(from, real(r.text()));
        status(id, STATUS.OK);
        break;
      }
      case T.READLINK:
        send(T.NAME, new Writer().u32(id).u32(1).string(fs.readlinkSync(real(r.text()))).string('').attrs());
        break;
      default:
        status(id, STATUS.OP_UNSUPPORTED, 'unsupported');
    }
  } catch (e) {
    fail(id, e);
  }
}

const frames = new FrameReader();
let greeted = false;
process.stdin.on('data', (chunk) => {
  for (const { type, payload } of frames.push(chunk)) {
    if (!greeted) {
      greeted = true;
      send(T.VERSION, new Writer().u32(3));
      continue;
    }
    if (++served > dieAfter) process.exit(1);
    handle(type, new Reader(payload));
  }
});
