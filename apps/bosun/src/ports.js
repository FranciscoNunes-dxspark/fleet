// The TCP ports listening on this machine, with the process holding each: /ports. The parsers of
// lsof's, ss's, netstat's and tasklist's output are pure; listeningPorts runs whichever this machine has.
import { spawnSync } from 'node:child_process';

/** The port at the end of a local address: 127.0.0.1:3000, [::]:3000, *:3000, 0.0.0.0%lo:53 → its number and host. */
function splitAddress(addr) {
  const m = /^(.*)[:.](\d+)$/.exec(String(addr));
  if (!m) return null;
  return { host: m[1].replace(/^\[|\]$/g, '').replace(/%\w+$/, '') || '*', port: Number(m[2]) };
}

/** `lsof -nP -iTCP -sTCP:LISTEN`'s lines: [{ port, host, pid, name }]. */
export function parseLsof(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(\S+)\s+(\d+)\s+.*\bTCP\s+(\S+)\s+\(LISTEN\)/.exec(line);
    const a = m && splitAddress(m[3]);
    if (a) out.push({ port: a.port, host: a.host, pid: Number(m[2]), name: m[1].replace(/\\x20/g, ' ') });
  }
  return out;
}

/** `ss -ltnp`'s lines (with or without its header): [{ port, host, pid, name }]; pid and name are null where ss may not say. */
export function parseSs(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'LISTEN' || cols.length < 5) continue;
    const a = splitAddress(cols[3]);
    if (!a) continue;
    const users = /users:\(\("([^"]*)",pid=(\d+)/.exec(line);
    out.push({ port: a.port, host: a.host, pid: users ? Number(users[2]) : null, name: users ? users[1] : null });
  }
  return out;
}

/** Windows' `netstat -ano`: the TCP lines LISTENING, [{ port, host, pid, name: null }]. */
export function parseNetstat(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (!/^TCP/i.test(cols[0] ?? '') || !/^LISTENING$/i.test(cols[3] ?? '')) continue;
    const a = splitAddress(cols[1]);
    if (a) out.push({ port: a.port, host: a.host, pid: Number(cols[4]) || null, name: null });
  }
  return out;
}

/** `tasklist /fo csv /nh`: a Map of pid → image name. */
export function parseTasklist(text) {
  const names = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m) names.set(Number(m[2]), m[1]);
  }
  return names;
}

/** One entry per port and process (IPv4 and IPv6 alike are one), by port. */
export function tidyPorts(list) {
  const seen = new Map();
  for (const p of list) {
    const key = `${p.port}:${p.pid}`;
    const had = seen.get(key);
    if (!had) seen.set(key, { ...p, hosts: [p.host] });
    else if (!had.hosts.includes(p.host)) had.hosts.push(p.host);
  }
  return [...seen.values()].sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0));
}

/** Each entry with `proc`, the name of the crew's process on that port or with that pid, else null. */
export const markCrew = (ports, procs) =>
  ports.map((e) => ({ ...e, proc: procs.find((p) => (p.port && p.port === e.port) || (p.pid && p.pid === e.pid))?.name ?? null }));

/**
 * The ports listening on this machine: netstat and tasklist on Windows; ss where it is (Linux), else
 * lsof. Empty when none of them answers.
 */
export function listeningPorts({ run = spawnSync, platform = process.platform } = {}) {
  const out = (cmd, args) => {
    try {
      const r = run(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      return r.status === 0 || r.stdout ? (r.stdout ?? '') : null;
    } catch {
      return null;
    }
  };
  if (platform === 'win32') {
    const list = parseNetstat(out('netstat', ['-ano']) ?? '');
    const names = parseTasklist(out('tasklist', ['/fo', 'csv', '/nh']) ?? '');
    return tidyPorts(list.map((e) => ({ ...e, name: names.get(e.pid) ?? null })));
  }
  if (platform === 'linux') {
    const ss = out('ss', ['-ltnp']);
    if (ss) return tidyPorts(parseSs(ss));
  }
  return tidyPorts(parseLsof(out('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']) ?? ''));
}
