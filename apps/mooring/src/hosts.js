// Saved hosts: { name, host, user?, port?, key?, folder? }, pure. A host is reached by the system's
// ssh and sftp, signing in with a key (`key`, a path) or the agent; nothing secret is kept here.
import { splitArgs } from '@fleet/kit/family.js';

const HOST_NAME = /^[A-Za-z0-9_.-]+$/;

/** Whether `name` can name a saved host (it ends up on the command line and in /connect). */
export const isHostName = (name) => HOST_NAME.test(String(name ?? ''));

/**
 * `user@host[:port]` (a bracketed IPv6 address too) as { user, host, port }, or { error }. A host
 * starting with `-` would be read by ssh as an option, so it is refused.
 */
export function parseTarget(text) {
  const m = String(text ?? '').trim().match(/^(?:([^@\s]+)@)?(\[[0-9a-fA-F:.]+\]|[^\s:@\[\]]+)(?::(\d{1,5}))?$/);
  if (!m) return { error: `"${text}" isn't user@host[:port].` };
  const [, user, bracketed, port] = m;
  const host = bracketed.replace(/^\[|\]$/g, '');
  if (host.startsWith('-') || user?.startsWith('-')) return { error: `"${text}" starts with a dash, which ssh would read as an option.` };
  if (port && (Number(port) < 1 || Number(port) > 65535)) return { error: `Port ${port} is out of range.` };
  return { user, host, port: port ? Number(port) : undefined };
}

/**
 * The words after `/add`: `<name> <user@host[:port]> [key=<file>] [folder=<folder>] [password]`, as a host to
 * save or an { error }, the options in any order. `password` says to ask for one on every connect: only
 * that it is asked for is saved, never the password.
 */
export function parseAdd(rest) {
  const words = splitArgs(String(rest ?? ''));
  const [name, target, ...more] = words;
  if (!name || !target) return { error: 'Usage: /add <name> <user@host[:port]> [key=<file>] [folder=<remote folder>] [password]' };
  if (!isHostName(name)) return { error: `"${name}" isn't a name: letters, digits, dots, dashes and underscores.` };
  const t = parseTarget(target);
  if (t.error) return t;
  const host = { name, host: t.host };
  if (t.user) host.user = t.user;
  if (t.port) host.port = t.port;
  for (const word of more) {
    if (word === 'password') {
      host.password = true;
      continue;
    }
    const m = word.match(/^(key|folder)=(.+)$/);
    if (!m) return { error: `"${word}" isn't key=<file>, folder=<remote folder> or password.` };
    host[m[1]] = m[2];
  }
  return host;
}

/** `user@host:port` as written back to the user. */
export const hostText = (h) => `${h.user ? `${h.user}@` : ''}${h.host.includes(':') ? `[${h.host}]` : h.host}${h.port ? `:${h.port}` : ''}`;

/** The host a name or a prefix of one means, among `hosts`; undefined when none or several do. */
export function findHost(hosts, name) {
  const all = hosts ?? [];
  const exact = all.find((h) => h.name === name);
  if (exact) return exact;
  const prefixed = all.filter((h) => h.name.toLowerCase().startsWith(String(name ?? '').toLowerCase()));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** `hosts` with `host` added, or replacing the one of its name. */
export const withHost = (hosts, host) => [...(hosts ?? []).filter((h) => h.name !== host.name), host].sort((a, b) => a.name.localeCompare(b.name));

/** `hosts` without the one called `name`. */
export const withoutHost = (hosts, name) => (hosts ?? []).filter((h) => h.name !== name);
