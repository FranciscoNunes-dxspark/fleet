// Trusting a host from inside Mooring, what ssh's "continue connecting?" question does (Mooring runs ssh
// with no terminal, so it can't be asked there): is the host in known_hosts (`ssh-keygen -F`), and if not,
// the key it offers (`ssh-keyscan`) with its fingerprint (`ssh-keygen -l`), and on a yes that one key
// added to the file ssh reads. Only a host with no entry at all is offered: a key that has *changed* is
// never taken over, it stays ssh's error. The tools are OpenSSH's own, the same ones that ship with ssh.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const TYPES = ['ED25519', 'ECDSA', 'RSA'];

/** `command` with `args`, never through a shell: { code, stdout, stderr, missing } however it ends. */
function defaultRun(command, args, { input, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), missing: error?.code === 'ENOENT' }),
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

/** How known_hosts names a host: `host`, or `[host]:port` off port 22. */
export const entryName = (host) => (host.port && Number(host.port) !== 22 ? `[${host.host}]:${host.port}` : host.host);

const expandHome = (path) => (/^~[/\\]/.test(path) ? join(homedir(), path.slice(2)) : path);

// What ssh -G prints is ssh's idea of a path: `~` for home, `__PROGRAMDATA__` in Windows' OpenSSH, and Git for
// Windows' ssh says `/c/Users/me/.ssh/known_hosts` (MSYS), which Node would read as `C:\c\Users\…`.
function fixPath(path, { platform = process.platform, env = process.env } = {}) {
  let p = path;
  if (platform === 'win32') {
    p = p.replace(/^__PROGRAMDATA__/, env.ProgramData ?? 'C:\\ProgramData');
    const msys = p.match(/^\/([a-zA-Z])\/(.*)$/);
    if (msys) p = `${msys[1].toUpperCase()}:/${msys[2]}`;
  }
  return expandHome(p);
}

/** The files `ssh -G` says it reads (its output's `userknownhostsfile` and `globalknownhostsfile` lines), `~` filled in. */
export function knownHostsFiles(output, options) {
  const pick = (key) =>
    String(output)
      .split(/\r?\n/)
      .filter((l) => l.toLowerCase().startsWith(`${key} `))
      .flatMap((l) => l.slice(key.length + 1).trim().split(/\s+/))
      .filter((f) => f && f !== 'none')
      .map((f) => fixPath(f, options));
  return { user: pick('userknownhostsfile'), global: pick('globalknownhostsfile') };
}

/**
 * The keys in `ssh-keyscan`'s output as { line, type } (ED25519, ECDSA, RSA), the strongest kind first;
 * comments and anything that isn't `<host> <keytype> <key>` are left out.
 */
export function parseScan(output) {
  const keys = [];
  for (const raw of String(output).split(/\r?\n/)) {
    const m = raw.trim().match(/^(\S+)\s+(ssh-ed25519|ecdsa-sha2-\S+|ssh-rsa)\s+([A-Za-z0-9+/=]+)$/);
    if (!m) continue;
    const type = m[2] === 'ssh-ed25519' ? 'ED25519' : m[2] === 'ssh-rsa' ? 'RSA' : 'ECDSA';
    keys.push({ line: `${m[1]} ${m[2]} ${m[3]}`, type });
  }
  return keys.sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type));
}

/** The fingerprint (`SHA256:…`) in `ssh-keygen -l`'s output, or null. */
export const parseFingerprint = (output) => String(output).match(/^\d+\s+(SHA256:\S+)\s/m)?.[1] ?? null;

/**
 * Host keys as the app uses them: `inspect(host)` → { known: true } | { known: false, keys: [{ line, type,
 * fingerprint }] } | { skip: true } (the tools aren't there, or the host didn't answer: ssh's own error
 * will say what is wrong), and `trust(host, key)`. `run`, `files` (known_hosts files to use instead of
 * what ssh says) and the tools' names are for the tests.
 */
export function createHostKeys({ run = defaultRun, files, tools = { ssh: 'ssh', keygen: 'ssh-keygen', keyscan: 'ssh-keyscan' } } = {}) {
  // A name starting with a dash would be read by these tools as an option (hosts.js refuses one, a hand-edited config might not).
  const safe = (host) => typeof host?.host === 'string' && host.host && !host.host.startsWith('-');
  const filesFor = async (host) => {
    if (files) return { user: files, global: [] };
    const r = await run(tools.ssh, ['-G', ...(host.port ? ['-p', String(host.port)] : []), host.user ? `${host.user}@${host.host}` : host.host]);
    const found = r.code === 0 ? knownHostsFiles(r.stdout) : { user: [], global: [] };
    return found.user.length ? found : { user: [join(homedir(), '.ssh', 'known_hosts')], global: found.global };
  };
  return {
    async inspect(host) {
      if (!safe(host)) return { skip: true };
      const { user, global } = await filesFor(host);
      const name = entryName(host);
      for (const file of [...user, ...global]) {
        if (!existsSync(file)) continue;
        const r = await run(tools.keygen, ['-F', name, '-f', file]);
        if (r.missing) return { skip: true };
        if (r.code === 0 && r.stdout.trim()) return { known: true };
      }
      const scan = await run(tools.keyscan, ['-T', '8', ...(host.port ? ['-p', String(host.port)] : []), host.host], { timeout: 20000 });
      if (scan.missing) return { skip: true };
      const keys = [];
      for (const key of parseScan(scan.stdout)) {
        const fp = parseFingerprint((await run(tools.keygen, ['-l', '-E', 'sha256', '-f', '-'], { input: `${key.line}\n` })).stdout);
        if (fp) keys.push({ ...key, fingerprint: fp });
      }
      return keys.length ? { known: false, keys } : { skip: true };
    },
    /** Adds the key (as scanned: the one that was shown) to the first file ssh reads for this host. */
    async trust(host, key) {
      if (!safe(host) || !/^\S+ \S+ \S+$/.test(key?.line ?? '')) throw new Error('Not a host key to trust.');
      const [file] = (await filesFor(host)).user;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
      appendFileSync(file, `${existing && !existing.endsWith('\n') ? '\n' : ''}${key.line}\n`, { mode: 0o600 });
      return file;
    },
  };
}
