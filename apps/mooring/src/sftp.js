// What the system's ssh needs and what comes back, pure: its arguments, the paths of a server (always
// `/`, whatever this machine is), sorting a listing, and what its errors mean. BatchMode means a key or
// the agent only: ssh runs with no terminal, so it can never ask for a password, a passphrase or
// whether to trust a new host key. It fails instead, and says so.
import { homedir } from 'node:os';

/** ~/ at the start of a key file is the home folder, as a shell would have it. */
const expandHome = (path) => (/^~[/\\]/.test(path) ? `${homedir()}${path.slice(1)}` : path);

const target = (host) => `${host.user ? `${host.user}@` : ''}${host.host}`;

const common = (host) => [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=15',
  '-o', 'ServerAliveInterval=30',
  ...(host.port ? ['-p', String(host.port)] : []),
  ...(host.key ? ['-i', expandHome(host.key)] : []),
];

/** ssh's arguments for the SFTP subsystem on `host` ({ user, host, port, key }): the protocol on stdin and stdout. */
export const sftpServerArgs = (host) => ['-s', ...common(host), target(host), 'sftp'];

/** ssh's arguments to run `command` on `host` with no terminal (the console). */
export const sshArgs = (host, command) => ['-T', ...common(host), target(host), command];

// ---------------------------------------------------------------------------------------------------
// A server's paths: `/` separated, whatever the machine Mooring runs on.

/** `name` inside `dir`. */
export const joinRemote = (dir, name) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);

/** The folder above `path` (the root stays the root). */
export function parentOf(path) {
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
}

/** The last part of `path`. */
export const baseName = (path) => path.replace(/\/+$/, '').split('/').pop() || '/';

/** Where `path` goes from `dir`: absolute as it is, else inside `dir`, with `.` and `..` folded away. */
export function resolveRemote(dir, path) {
  const parts = (path.startsWith('/') ? path : joinRemote(dir, path)).split('/');
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return `/${out.join('/')}`;
}

/** Folders first (a link to one too: `isDir`), then by name without regard to case. */
export function sortEntries(entries) {
  const rank = (e) => (e.kind === 'dir' || e.isDir ? 0 : 1);
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// ---------------------------------------------------------------------------------------------------
// Errors: ssh's own words, and what to do about the common ones.

/**
 * What went wrong in ssh's stderr, in its own last words plus, for the usual causes, what to do
 * (Mooring has no terminal to ask in, so a key, the agent and a known host are the way in).
 */
export function problemFrom(stderr, { command = 'ssh' } = {}) {
  const words = String(stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l, i, all) => l && all.indexOf(l) === i)
    .slice(-3)
    .join(' ');
  const said = words || 'It said nothing.';
  if (/Permission denied|passphrase|no such identity/i.test(said)) {
    return `${said}\nMooring runs ${command} without a terminal (BatchMode): it signs in with a key or your ssh agent only. Give the host a key (/add … key=<file>), or ssh-add it.`;
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(said)) {
    return `${said}\nThe host must already be in known_hosts and unchanged: connect to it once with plain ssh yourself.`;
  }
  if (/subsystem request failed/i.test(said)) {
    return `${said}\nThe server has no SFTP subsystem turned on, so there are no files to show. The console still works.`;
  }
  return said;
}

/** The message for a program that can't be started. */
export const missingProgram = (command, error) =>
  error?.code === 'ENOENT' ? `${command} isn't installed, or isn't on the PATH: Mooring uses the system's ${command}.` : `Couldn't start ${command}: ${error?.message ?? error}`;

/** `text` as one word for a POSIX shell: single quoted, with a `'` in it closed, escaped and opened again. */
export const shellQuote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
