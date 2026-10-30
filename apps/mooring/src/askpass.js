// Signing in with a password without a terminal: ssh asks a program for it (SSH_ASKPASS, which
// SSH_ASKPASS_REQUIRE=force makes it use even where it could ask on a terminal) instead of reading it
// from one. The program is a tiny script Mooring writes to a folder of its own: it prints
// $MOORING_ASKPASS_PASSWORD, so the password reaches it through the environment of the ssh that
// Mooring starts, never through a command line, a file or the settings. Asked for on every connection
// and kept only in memory while it is open.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The variable the helper reads. */
export const PASSWORD_VARIABLE = 'MOORING_ASKPASS_PASSWORD';

/**
 * The helper for `platform`: { name, body, mode }. On Windows it is a .cmd that has PowerShell write the
 * variable out: the password is never put in the script's text (cmd would read an & or a % in it as
 * its own), and the script takes no arguments, for the same reason: ssh's prompt, which names the host
 * and the server's key, is never expanded into a command line.
 */
export function helperScript(platform = process.platform) {
  if (platform === 'win32') {
    return { name: 'askpass.cmd', mode: 0o700, body: `@echo off\r\npowershell -NoProfile -NonInteractive -Command "[Console]::Out.WriteLine($env:${PASSWORD_VARIABLE})"\r\n` };
  }
  return { name: 'askpass.sh', mode: 0o700, body: `#!/bin/sh\nprintf '%s\\n' "$${PASSWORD_VARIABLE}"\n` };
}

let helperPath = null;
let folder = null;

/** Where the helper is, written on first use to a folder only this user can open and removed when the process ends. */
export function ensureHelper({ platform = process.platform, base = tmpdir() } = {}) {
  if (helperPath) return helperPath;
  mkdirSync(base, { recursive: true });
  folder = mkdtempSync(join(base, 'mooring-askpass-'));
  const script = helperScript(platform);
  helperPath = join(folder, script.name);
  writeFileSync(helperPath, script.body, { mode: script.mode });
  process.once('exit', () => {
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch {
      // Left in the temporary folder, holding no secret.
    }
  });
  return helperPath;
}

/**
 * What to add to the environment of an ssh that signs in with `password`. DISPLAY is set when there is
 * none, as older OpenSSH only uses a helper when it sees one.
 */
export function askpassEnv(password, env = process.env, helper = ensureHelper()) {
  return {
    SSH_ASKPASS: helper,
    SSH_ASKPASS_REQUIRE: 'force',
    ...(env.DISPLAY ? {} : { DISPLAY: 'mooring:0' }),
    [PASSWORD_VARIABLE]: password,
  };
}
