// The host names the crew is reached by (a process's "host", an IIS site's bindings) and whether this
// machine can find them: a site bound to shop.local answers nothing until the hosts file says where
// shop.local is. Pre-flight says which are missing; /hosts adds them, after asking. The hosts file's
// reading and writing are pure; the look-up and the file are injectable.
import { lookup } from 'node:dns/promises';
import { join } from 'node:path';

/** Where the hosts file is. */
export const hostsPath = (platform = process.platform, env = process.env) => (platform === 'win32' ? join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts') : '/etc/hosts');

/** The names a hosts file maps, lower-cased (comments left out). */
export function hostsNames(text) {
  const names = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const words = line.replace(/#.*/, '').trim().split(/\s+/);
    if (words.length > 1) for (const name of words.slice(1)) names.add(name.toLowerCase());
  }
  return names;
}

// Names every machine finds without the hosts file.
const ALWAYS = /^(localhost|.*\.localhost)$|^\d+\.\d+\.\d+\.\d+$|^\[?[0-9a-f:]+\]?$/i;

/** The names worth asking about: not localhost, not an address, once each. */
export const hostNamesToCheck = (names) => [...new Set(names.filter(Boolean).map((n) => n.toLowerCase()))].filter((n) => !ALWAYS.test(n));

/** `text` with `names` mapped to 127.0.0.1, after a comment saying Bosun added them (the file's own line endings kept). */
export function withHosts(text, names) {
  const t = String(text ?? '');
  const eol = t.includes('\r\n') ? '\r\n' : '\n';
  const body = t && !t.endsWith('\n') ? `${t}${eol}` : t;
  return `${body}${eol}# Added by Bosun for this project's crew${eol}${names.map((n) => `127.0.0.1\t${n}`).join(eol)}${eol}`;
}

/** The crew's host names: each process's "host", and the host names an IIS site is bound to (`bindings(p)`, when known). */
export function crewHosts(procs, bindings = () => []) {
  const out = [];
  for (const p of procs) {
    if (p.host) out.push({ proc: p.name, host: p.host });
    for (const b of bindings(p) ?? []) if (b.host) out.push({ proc: p.name, host: b.host });
  }
  const seen = new Set();
  return out.filter((h) => hostNamesToCheck([h.host]).length && !seen.has(h.host.toLowerCase()) && seen.add(h.host.toLowerCase()));
}

/** Whether this machine finds `host`, within `timeout` ms. */
export async function resolves(host, { timeout = 1500, find = lookup } = {}) {
  let timer;
  try {
    return await Promise.race([find(host).then(() => true, () => false), new Promise((r) => (timer = setTimeout(() => r(false), timeout)))]);
  } finally {
    clearTimeout(timer);
  }
}
