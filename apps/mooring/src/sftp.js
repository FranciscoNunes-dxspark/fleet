// The system's sftp, driven through a batch (`sftp -b -`), pure: arguments, quoting, the paths of a
// server (always `/`, whatever this machine is), the parsing of `ls -l`, and what its errors mean.
// BatchMode means a key or the agent only: sftp runs with no terminal, so it can never ask for a
// password, a passphrase or whether to trust a new host key. It fails instead, and says so.
import { homedir } from 'node:os';

/** ~/ at the start of a key file is the home folder, as a shell would have it. */
const expandHome = (path) => (/^~[/\\]/.test(path) ? `${homedir()}${path.slice(1)}` : path);

/** sftp's arguments to read its commands from stdin and sign in as `host` ({ user, host, port, key }). */
export function sftpArgs(host) {
  return [
    '-b',
    '-',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=30',
    // sftp's port is -P (ssh's is -p).
    ...(host.port ? ['-P', String(host.port)] : []),
    ...(host.key ? ['-i', expandHome(host.key)] : []),
    `${host.user ? `${host.user}@` : ''}${host.host.includes(':') ? `[${host.host}]` : host.host}`,
  ];
}

/** ssh's arguments to run `command` on `host` with no terminal (the console). */
export function sshArgs(host, command) {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=30',
    ...(host.port ? ['-p', String(host.port)] : []),
    ...(host.key ? ['-i', expandHome(host.key)] : []),
    `${host.user ? `${host.user}@` : ''}${host.host}`,
    command,
  ];
}

/**
 * A path as one word of an sftp batch line: double quoted, with `"` and `\` escaped. A line break
 * would end the command and start another, so a name holding one is refused rather than escaped.
 */
export function quotePath(path) {
  const s = String(path);
  if (/[\r\n\0]/.test(s)) throw new Error('A path with a line break in it can not be sent to sftp.');
  return `"${s.replace(/["\\]/g, '\\$&')}"`;
}

// The commands of a batch, one per line. `-` before a command (sftp's own) lets the batch go on when it fails.
export const commands = {
  ls: (dir) => `ls -la ${quotePath(dir)}`,
  pwd: () => 'pwd',
  mkdir: (dir) => `mkdir ${quotePath(dir)}`,
  rename: (from, to) => `rename ${quotePath(from)} ${quotePath(to)}`,
  rm: (file) => `rm ${quotePath(file)}`,
  rmdir: (dir) => `rmdir ${quotePath(dir)}`,
  get: (remote, local) => `get -p ${quotePath(remote)} ${quotePath(local)}`,
  put: (local, remote) => `put -p ${quotePath(local)} ${quotePath(remote)}`,
  getDir: (remote, local) => `get -pR ${quotePath(remote)} ${quotePath(local)}`,
  putDir: (local, remote) => `put -pR ${quotePath(local)} ${quotePath(remote)}`,
};

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

// ---------------------------------------------------------------------------------------------------
// `ls -la`, as OpenSSH's sftp prints it: `drwxr-xr-x    2 user  group  4096 Oct 30 10:00 name`.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const LS_LINE = /^([-dlbcps])([rwxsStT-]{9})[+@.]?\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s(.+)$/;

/** The time of a listing's date: `10:00` means the latest such time not in the future, `2024` midnight. */
function listedTime(month, day, when, now) {
  const m = MONTHS.indexOf(month.toLowerCase());
  if (m < 0) return null;
  if (!when.includes(':')) return Date.UTC(Number(when), m, Number(day));
  const [h, min] = when.split(':').map(Number);
  const year = new Date(now).getUTCFullYear();
  const t = Date.UTC(year, m, Number(day), h, min);
  // A date later than now is last year's.
  return t > now + 24 * 3600 * 1000 ? Date.UTC(year - 1, m, Number(day), h, min) : t;
}

/**
 * The entries of an `ls -la` output: { name, kind: 'dir' | 'file' | 'link' | 'other', size, mode,
 * modified (ms, null when unreadable), link? }. `.` and `..` and the lines that aren't entries
 * (sftp echoing the command, `total`) are left out.
 */
export function parseLs(output, now = Date.now()) {
  const entries = [];
  for (const raw of String(output).split(/\r?\n/)) {
    const m = raw.match(LS_LINE);
    if (!m) continue;
    const [, type, mode, size, month, day, when, rest] = m;
    let name = rest;
    let link;
    if (type === 'l') {
      const i = rest.indexOf(' -> ');
      if (i > 0) [name, link] = [rest.slice(0, i), rest.slice(i + 4)];
    }
    if (name === '.' || name === '..') continue;
    entries.push({
      name,
      kind: type === 'd' ? 'dir' : type === '-' ? 'file' : type === 'l' ? 'link' : 'other',
      size: Number(size),
      mode,
      modified: listedTime(month, day, when, now),
      ...(link != null ? { link } : {}),
    });
  }
  return entries;
}

/** Folders first, then by name without regard to case; a link counts as what it is, a file until followed. */
export function sortEntries(entries) {
  const rank = (e) => (e.kind === 'dir' || e.isDir ? 0 : 1);
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** The folder `pwd` printed: "Remote working directory: /home/me". */
export function parsePwd(output) {
  const m = String(output).match(/Remote working directory:\s*(.+)/);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------------------------------
// Errors: ssh's own words, and what to do about the common ones.

/**
 * What went wrong in sftp's or ssh's stderr, in its own last words plus, for the usual causes, what to
 * do (Mooring has no terminal to ask in, so a key, the agent and a known host are the way in).
 */
export function problemFrom(stderr, { command = 'sftp' } = {}) {
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
  return said;
}

/** The message for a program that can't be started. */
export const missingProgram = (command, error) =>
  error?.code === 'ENOENT' ? `${command} isn't installed, or isn't on the PATH: Mooring uses the system's ${command}.` : `Couldn't start ${command}: ${error?.message ?? error}`;
