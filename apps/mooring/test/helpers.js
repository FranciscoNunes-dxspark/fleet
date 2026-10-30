import { spawn as spawnProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** A temporary folder, removed by the returned `done()`. */
export function tempDir(prefix = 'mooring-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** spawn() that runs the fake SFTP server (`node fake-sftp-server.js`) over `root`, with its settings in the environment. */
export const serverSpawn = (root, env = {}) => (_command, _args, options) =>
  spawnProcess(process.execPath, [script('fake-sftp-server.js')], { ...options, env: { ...process.env, FAKE_ROOT: root, ...env } });

/** Options for createSession: the fake server for the files, the fake ssh for commands. */
export const fakeSession = (root, env) => ({
  sshCommand: process.execPath,
  spawn: (command, args, options) => (args[0] === '-T' ? spawnProcess(process.execPath, [script('fake-ssh.js'), args.at(-1)], options) : serverSpawn(root, env)(command, args, options)),
});
