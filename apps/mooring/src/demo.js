// A made-up host and a made-up machine for --demo and the tests: the same interfaces as session.js and
// local.js over in-memory trees. `state.calls` records what was asked (a name and its arguments), `state.tree` is the files.
import { posix } from 'node:path';
import { baseName, parentOf, sortEntries } from './sftp.js';
import { SessionError } from './errors.js';

const T = Date.UTC(2026, 9, 28, 9, 0);

const seed = () =>
  new Map([
    ['/', { kind: 'dir' }],
    ['/home', { kind: 'dir' }],
    ['/home/demo', { kind: 'dir' }],
    ['/home/demo/site', { kind: 'dir' }],
    ['/home/demo/site/index.html', { kind: 'file', size: 2048 }],
    ['/home/demo/site/app.css', { kind: 'file', size: 9120 }],
    ['/home/demo/site/img', { kind: 'dir' }],
    ['/home/demo/site/img/logo.png', { kind: 'file', size: 48211 }],
    ['/home/demo/backups', { kind: 'dir' }],
    ['/home/demo/backups/db-2026-10-27.bak', { kind: 'file', size: 52428800 }],
    ['/home/demo/notes.txt', { kind: 'file', size: 312 }],
    ['/var', { kind: 'dir' }],
    ['/var/log', { kind: 'dir' }],
    ['/var/log/syslog', { kind: 'file', size: 183422 }],
  ]);

// `tick` is awaited between a transfer's `chunks` progress reports, so a test can stop one half way.
export function demoSession({ host = { name: 'demo', host: 'demo.example.com', user: 'demo' }, tree = seed(), chunks = 4, tick = async () => {} } = {}) {
  const state = { calls: [], tree };
  const say = (...call) => state.calls.push(call);
  const need = (path) => {
    if (!tree.has(path)) throw new SessionError(`${path}: No such file or directory`);
    return tree.get(path);
  };
  // A transfer in `chunks` steps, stopping at the signal.
  const transferring = async (total, file, signal, onProgress) => {
    onProgress?.({ bytes: 0, total, file });
    for (let i = 1; i <= chunks; i++) {
      await tick();
      if (signal?.aborted) throw new SessionError('Cancelled', { cancelled: true });
      onProgress?.({ bytes: Math.round((total * i) / chunks), total, file });
    }
  };
  const childrenOf = (dir) => [...tree.keys()].filter((p) => p !== '/' && parentOf(p) === dir);
  return {
    host,
    state,
    async home() {
      return '/home/demo';
    },
    async list(dir) {
      say('list', dir);
      if (need(dir).kind !== 'dir') throw new SessionError(`${dir}: Not a directory`);
      return childrenOf(dir)
        .map((p) => ({ name: baseName(p), kind: tree.get(p).kind, size: tree.get(p).size ?? 4096, mode: tree.get(p).kind === 'dir' ? 'rwxr-xr-x' : 'rw-r--r--', modified: T }))
        .sort((a, b) => (a.kind === 'dir' ? 0 : 1) - (b.kind === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
    },
    async mkdir(dir) {
      say('mkdir', dir);
      if (tree.has(dir)) throw new SessionError(`${dir}: Failure`);
      need(parentOf(dir));
      tree.set(dir, { kind: 'dir' });
    },
    async rename(from, to) {
      say('rename', from, to);
      need(from);
      if (tree.has(to)) throw new SessionError(`${to}: Failure`);
      for (const p of [...tree.keys()]) {
        if (p === from || p.startsWith(`${from}/`)) {
          tree.set(to + p.slice(from.length), tree.get(p));
          tree.delete(p);
        }
      }
    },
    async rm(file) {
      say('rm', file);
      if (need(file).kind === 'dir') throw new SessionError(`${file}: Failure`);
      tree.delete(file);
    },
    async rmdir(dir) {
      say('rmdir', dir);
      need(dir);
      if (childrenOf(dir).length) throw new SessionError(`${dir}: Failure`);
      tree.delete(dir);
    },
    async get(remote, local, { recursive, signal, onProgress } = {}) {
      say('get', remote, local, { recursive: !!recursive });
      const size = need(remote).size ?? 0;
      await transferring(size, remote, signal, onProgress);
    },
    // `size` is for the demo only: the real sftp reads the file.
    async put(local, remote, { recursive, size = 1024, signal, onProgress } = {}) {
      say('put', local, remote, { recursive: !!recursive });
      need(parentOf(remote));
      await transferring(size, local, signal, onProgress);
      tree.set(remote, recursive ? { kind: 'dir' } : { kind: 'file', size });
    },
    async exec(line) {
      say('exec', line);
      const [cmd, ...rest] = line.trim().split(/\s+/);
      if (cmd === 'uptime') return { code: 0, stdout: ' 09:00:00 up 41 days,  3:12,  1 user,  load average: 0.08, 0.03, 0.01\n', stderr: '' };
      if (cmd === 'echo') return { code: 0, stdout: `${rest.join(' ')}\n`, stderr: '' };
      if (cmd === 'pwd') return { code: 0, stdout: '/home/demo\n', stderr: '' };
      if (cmd === 'ls') {
        const dir = rest.find((a) => !a.startsWith('-')) ?? '/home/demo';
        const names = tree.has(dir) ? childrenOf(dir).map(baseName) : null;
        return names ? { code: 0, stdout: `${names.join('\n')}\n`, stderr: '' } : { code: 2, stdout: '', stderr: `ls: cannot access '${dir}': No such file or directory\n` };
      }
      return { code: 127, stdout: '', stderr: `bash: ${cmd}: command not found\n` };
    },
  };
}

const localSeed = () =>
  new Map([
    ['/', { kind: 'dir' }],
    ['/demo', { kind: 'dir' }],
    ['/demo/Documents', { kind: 'dir' }],
    ['/demo/Documents/report.pdf', { kind: 'file', size: 482113 }],
    ['/demo/Documents/budget.xlsx', { kind: 'file', size: 31220 }],
    ['/demo/Downloads', { kind: 'dir' }],
    ['/demo/Downloads/installer.zip', { kind: 'file', size: 73400320 }],
    ['/demo/site', { kind: 'dir' }],
    ['/demo/site/index.html', { kind: 'file', size: 2310 }],
    ['/demo/site/app.css', { kind: 'file', size: 9400 }],
    ['/demo/todo.txt', { kind: 'file', size: 120 }],
  ]);

/** The demo's own machine: the same shape as local.js's `createLocal`, over an in-memory tree with `/` paths. */
export function demoLocal({ dir = '/demo', tree = localSeed() } = {}) {
  const state = { calls: [], tree };
  const say = (...call) => state.calls.push(call);
  const need = (path) => {
    if (!tree.has(path)) throw new Error(`${path}: no such file or directory`);
    return tree.get(path);
  };
  return {
    kind: 'local',
    dir,
    state,
    sep: '/',
    join: posix.join,
    parent: (d) => posix.dirname(d),
    resolve: (d, path) => posix.resolve(d, path.replace(/^~(?=\/|$)/, '/demo')),
    home: async () => '/demo',
    async list(d) {
      if (need(d).kind !== 'dir') throw new Error(`${d}: not a directory`);
      return sortEntries(
        [...tree.keys()]
          .filter((p) => p !== '/' && posix.dirname(p) === d)
          .map((p) => ({ name: posix.basename(p), kind: tree.get(p).kind, size: tree.get(p).size ?? 0, mode: tree.get(p).kind === 'dir' ? 'rwxr-xr-x' : 'rw-r--r--', modified: T })),
      );
    },
    async mkdir(d) {
      say('mkdir', d);
      if (tree.has(d)) throw new Error(`${d}: file exists`);
      need(posix.dirname(d));
      tree.set(d, { kind: 'dir' });
    },
    async rename(from, to) {
      say('rename', from, to);
      need(from);
      for (const p of [...tree.keys()]) {
        if (p === from || p.startsWith(`${from}/`)) {
          tree.set(to + p.slice(from.length), tree.get(p));
          tree.delete(p);
        }
      }
    },
    async remove(path) {
      say('remove', path);
      need(path);
      for (const p of [...tree.keys()]) if (p === path || p.startsWith(`${path}/`)) tree.delete(p);
    },
    exists: async (path) => tree.has(path),
    /** The size of a file, for queueing an upload. */
    size: async (path) => need(path).size ?? 0,
  };
}
