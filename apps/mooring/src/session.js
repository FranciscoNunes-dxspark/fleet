// A host as the rest of the app sees it: `list`, `mkdir`, `get`, `exec`… Each call is one run of the
// system's sftp (a batch on its stdin) or ssh, so nothing is kept open between calls: no native module,
// nothing secret in the config, and a call can be cancelled by stopping its process. The demo
// (`demo.js`) has the same interface.
import { spawn as spawnProcess } from 'node:child_process';
import { commands, joinRemote, missingProgram, parseLs, parsePwd, problemFrom, sftpArgs, sortEntries, sshArgs } from './sftp.js';

/** A failed call; `cancelled` when it was stopped on purpose, `code` the program's exit code. */
export class SessionError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'SessionError';
    Object.assign(this, extra);
  }
}

// The programs running now, stopped when this process exits however it exits.
const live = new Set();
let exitHook = false;

const MAX_OUT = 32 * 1024 * 1024;

/**
 * Runs `command` with `args`, writing `input` to its stdin. Resolves { code, stdout, stderr } however
 * it ends; rejects when it can't start or is cancelled. `onData(text)` sees stdout as it arrives.
 */
function run({ command, args, input, signal, spawn, onData }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new SessionError('Cancelled', { cancelled: true }));
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    // A program that exits before reading everything closes the pipe on us: its own words say why.
    child.stdin?.on('error', () => {});
    if (input != null) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

/**
 * The session for `host` ({ user, host, port, key }). `command` and `sshCommand` name the programs;
 * `argsFor` and `sshArgsFor` and `spawn` stand in for them in the tests.
 */
export function createSession(host, { command = 'sftp', sshCommand = 'ssh', argsFor = sftpArgs, sshArgsFor = sshArgs, spawn = spawnProcess } = {}) {
  // One batch: the lines are the commands, and the first to fail stops the rest (sftp's batch rule).
  const batch = async (lines, signal) => {
    const r = await run({ command, args: argsFor(host), input: `${lines.join('\n')}\n`, signal, spawn });
    if (r.code !== 0) throw new SessionError(problemFrom(r.stderr || r.stdout, { command }), { code: r.code });
    return r;
  };
  return {
    host,
    async home(signal) {
      return parsePwd((await batch([commands.pwd()], signal)).stdout) ?? '/';
    },
    async list(dir, signal) {
      return sortEntries(parseLs((await batch([commands.ls(dir)], signal)).stdout));
    },
    mkdir: (dir, signal) => batch([commands.mkdir(dir)], signal),
    rename: (from, to, signal) => batch([commands.rename(from, to)], signal),
    rm: (file, signal) => batch([commands.rm(file)], signal),
    rmdir: (dir, signal) => batch([commands.rmdir(dir)], signal),
    /** Downloads `remote` to `local` (a folder's whole tree with `recursive`). */
    get: (remote, local, { recursive, signal } = {}) => batch([(recursive ? commands.getDir : commands.get)(remote, local)], signal),
    /** Uploads `local` to `remote` (a folder's whole tree with `recursive`). */
    put: (local, remote, { recursive, signal } = {}) => batch([(recursive ? commands.putDir : commands.put)(local, remote)], signal),
    /**
     * Runs a command line on the host with no terminal: { code, stdout, stderr }. A non-zero code is the
     * command's own (the console shows it); ssh's own 255 is a failure to reach or sign in.
     */
    async exec(line, { signal, onData } = {}) {
      const r = await run({ command: sshCommand, args: sshArgsFor(host, line), signal, spawn, onData });
      if (r.code === 255) throw new SessionError(problemFrom(r.stderr, { command: sshCommand }), { code: 255 });
      return r;
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
