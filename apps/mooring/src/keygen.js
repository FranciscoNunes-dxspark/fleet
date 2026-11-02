// Making an ssh key from inside Mooring: OpenSSH's own `ssh-keygen`, an ed25519 key with no passphrase (Mooring
// runs ssh with no terminal, so it could not ask for one when signing in; a key with a passphrase needs the
// agent anyway). The passphrase is left empty rather than passed in an argument, where any process could read it.
// The private key stays where ssh-keygen wrote it: Mooring keeps only its path (the host's `key=`).
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultRun } from './hostkeys.js';

export const DEFAULT_KEY_NAME = 'id_ed25519_mooring';

/** A key's file name: letters, digits, dots, dashes, underscores; not starting with a dash (ssh-keygen would read an option). */
export const validKeyName = (name) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name ?? '');

/**
 * `generate(name)` → { path, publicKey, fingerprint } for `<dir>/<name>` (`dir` is ~/.ssh), or throws; it never
 * replaces a key that is there. `run`, `dir` and the tool's name are for the tests.
 */
export function createKeygen({ run = defaultRun, dir = join(homedir(), '.ssh'), tool = 'ssh-keygen' } = {}) {
  return {
    dir,
    path: (name) => join(dir, name),
    async generate(name) {
      if (!validKeyName(name)) throw new Error('A key name is letters, digits, . - and _ (no slash, and no dash first).');
      const path = join(dir, name);
      if (existsSync(path) || existsSync(`${path}.pub`)) throw new Error(`${path} is there already: pick another name (Mooring never replaces a key).`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const r = await run(tool, ['-q', '-t', 'ed25519', '-N', '', '-C', `mooring ${name}`, '-f', path], { timeout: 30000 });
      if (r.missing) throw new Error("ssh-keygen isn't installed: it comes with OpenSSH.");
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'ssh-keygen failed.');
      const publicKey = readFileSync(`${path}.pub`, 'utf8').trim();
      const l = await run(tool, ['-l', '-E', 'sha256', '-f', `${path}.pub`]);
      return { path, publicKey, fingerprint: l.stdout.match(/(SHA256:\S+)/)?.[1] ?? null };
    },
  };
}
