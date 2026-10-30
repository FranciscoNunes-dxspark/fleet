// A host as the rest of the app sees it: `list`, `mkdir`, `get`, `exec`… The files go over one SFTP
// connection kept open (sftp-client.js: opened by the first call, again after it drops), so there is
// one sign-in, calls can overlap, and a transfer reports progress and can be cancelled without losing
// the connection. `exec` runs a command through the system's ssh with no terminal, one run per call.
// The demo (`demo.js`) has the same interface.
import { spawn as spawnProcess } from 'node:child_process';
import { SessionError } from './errors.js';
import { openClient } from './sftp-client.js';
import { joinRemote, missingProgram, problemFrom, sftpServerArgs, sortEntries, sshArgs } from './sftp.js';
import { download, upload } from './transfer.js';

export { SessionError };

// The commands running now, stopped when this process exits however it exits.
const live = new Set();
let exitHook = false;

const MAX_OUT = 32 * 1024 * 1024;

/**
 * Runs `command` with `args`. Resolves { code, stdout, stderr } however it ends; rejects when it can't
 * start or is cancelled. `onData(text)` sees stdout as it arrives.
 */
function run({ command, args, signal, spawn, onData }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new SessionError('Cancelled', { cancelled: true }));
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      live.delete(child);
      fn(value);
    };
    const onAbort = () => {
      child.kill();
      finish(reject, new SessionError('Cancelled', { cancelled: true }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (!exitHook) {
      exitHook = true;
      process.once('exit', () => {
        for (const c of live) c.kill();
      });
    }
    live.add(child);
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (d) => {
      if (stdout.length < MAX_OUT) stdout += d;
      onData?.(d);
    });
    child.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-8000)));
    child.once('error', (e) => finish(reject, new SessionError(missingProgram(command, e))));
    child.once('close', (code, sig) => finish(resolve, { code: code ?? (sig ? 1 : 0), stdout, stderr }));
  });
}

/**
 * The session for `host` ({ user, host, port, key }). `sshCommand` names ssh; `argsFor`, `sshArgsFor`
 * and `spawn` stand in for it in the tests.
 */
export function createSession(host, { sshCommand = 'ssh', argsFor = sftpServerArgs, sshArgsFor = sshArgs, spawn = spawnProcess } = {}) {
  let client = null;
  let connecting = null;
  // The open connection, or a new one (one at a time: calls made meanwhile share it).
  const connection = async () => {
    if (client && !client.closed) return client;
    connecting ??= openClient(host, { command: sshCommand, argsFor, spawn }).then(
      (c) => ((connecting = null), (client = c)),
      (e) => ((connecting = null), Promise.reject(e)),
    );
    return connecting;
  };
  // A call on the connection. One cut off by the connection dropping fails (it may have been carried
  // out, so it is never made again by itself); the next call opens a new connection.
  const call = async (fn) => fn(await connection());
  return {
    host,
    home: () => call((c) => c.realpath('.')),
    async list(dir) {
      return call(async (c) => {
        const entries = await c.readdir(dir);
        // A link is a folder if what it points at is: the listing can't say, so ask (a dead link stays a link).
        await Promise.all(
          entries
            .filter((e) => e.kind === 'link')
            .map(async (e) => {
              const path = joinRemote(dir, e.name);
              const [target, attrs] = await Promise.all([c.readlink(path).catch(() => null), c.stat(path).catch(() => null)]);
              if (target != null) e.link = target;
              if (attrs && (attrs.permissions & 0o170000) === 0o040000) e.isDir = true;
            }),
        );
        return sortEntries(entries);
      });
    },
    mkdir: (dir) => call((c) => c.mkdir(dir)),
    rename: (from, to) => call((c) => c.rename(from, to)),
    rm: (file) => call((c) => c.remove(file)),
    rmdir: (dir) => call((c) => c.rmdir(dir)),
    /** Downloads `remote` to `local` (a folder's whole tree with `recursive`); `onProgress({ bytes, total, file })`. */
    get: (remote, local, { recursive, signal, onProgress } = {}) => call((c) => download(c, remote, local, { recursive, signal, onProgress })),
    /** Uploads `local` to `remote` (a folder's whole tree with `recursive`). */
    put: (local, remote, { recursive, signal, onProgress } = {}) => call((c) => upload(c, local, remote, { recursive, signal, onProgress })),
    /**
     * Runs a command line on the host with no terminal: { code, stdout, stderr }. A non-zero code is the
     * command's own (the console shows it); ssh's own 255 is a failure to reach or sign in.
     */
    async exec(line, { signal, onData } = {}) {
      const r = await run({ command: sshCommand, args: sshArgsFor(host, line), signal, spawn, onData });
      if (r.code === 255) throw new SessionError(problemFrom(r.stderr, { command: sshCommand }), { code: 255 });
      return r;
    },
    /** Ends the connection (the next call opens another). */
    close() {
      client?.close();
      client = null;
    },
  };
}

/**
 * Deletes `path` and everything under it through `session` (any: the demo's too), deepest first.
 * Links are removed as the links they are, never followed. `onEach(path)` hears each removal.
 */
export async function removeTree(session, path, { signal, onEach } = {}) {
  const entries = await session.list(path, signal);
  for (const e of entries) {
    const child = joinRemote(path, e.name);
    if (e.kind === 'dir') await removeTree(session, child, { signal, onEach });
    else {
      await session.rm(child, signal);
      onEach?.(child);
    }
  }
  await session.rmdir(path, signal);
  onEach?.(path);
}
