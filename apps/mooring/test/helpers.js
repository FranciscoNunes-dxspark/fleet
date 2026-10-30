// What the end-to-end tests share: rendering App over the demo host and machine with a temporary
// home, waiting for frames, typing; and the real-process fixtures the session tests use.
import { spawn as spawnProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.jsx';
import { demoLocal, demoSession } from '../src/demo.js';

export const KEYS = { down: '\x1b[B', up: '\x1b[A', left: '\x1b[D', right: '\x1b[C', enter: '\r', esc: '\x1b', backspace: '\x7f', tab: '\t', ctrlP: '\x10' };

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

let lastApp = null;
// Every app started, unmounted by the cleanup tempHome returns: one a failing test left mounted would keep
// its timers running, and the test process would never exit.
const started = [];

/** A home folder of its own, so the settings a test saves never reach the real one; returns the cleanup. */
export function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'mooring-home-'));
  process.env.MOORING_HOME = dir;
  // The family's moods and activity too (family.js), never the real ~/.family.
  process.env.FAMILY_HOME = join(dir, 'family');
  return () => {
    for (const app of started.splice(0)) app.unmount();
    rmSync(dir, { recursive: true, force: true });
  };
}

/**
 * Renders App over a fresh demo machine and host (`local.state`, `host.state` have what they hold),
 * with the clipboard as a recorder. `connectTo` is 'demo' unless given.
 */
export function start(props = {}) {
  const local = props.local ?? demoLocal();
  const host = props.host ?? demoSession({ tick: props.tick });
  const copied = [];
  lastApp = render(
    React.createElement(App, {
      config: { history: [], hosts: [{ name: 'demo', host: 'demo.example.com', user: 'demo' }, { name: 'build', host: 'build.example.com', user: 'ci', key: '~/.ssh/ci' }, { name: 'secure', host: 'secure.example.com', user: 'me', password: true }] },
      local,
      makeSession: () => host,
      connectTo: 'demo',
      demo: true,
      persist: false,
      copy: (text) => copied.push(text),
      ...props,
    }),
  );
  started.push(lastApp);
  return Object.assign(lastApp, { host, local, copied });
}

export async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

export const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

export const shows = (app, text) => () => app.lastFrame().includes(text);
