// What the host's end-to-end tests share: a terminal of fixed size that keeps what's drawn on it as
// text (vt.js), the host started on it with apps of the tests' choosing, and waiting for the screen.
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Host } from '../src/host.js';
import { appSpawner } from '../src/launch.js';
import { Screen } from './vt.js';

/** Every host the tests started, for `stopAll` to stop what a failed test left running. */
export const hosts = [];

/** The family folders the tests made, taken away by `stopAll`. */
const folders = [];

/** Stops every app of every host the tests started (a test that failed halfway leaves them running), and takes their family folders away. */
export const stopAll = () => {
  hosts.forEach((h) => h.killAll());
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
};

export const FAKE = fileURLToPath(new URL('./fixtures/fake-app.js', import.meta.url));
export const PREFIX = '\x1d';

/** The terminal the host draws on: columns, rows, 'resize', and a screen of what it drew. */
export class Terminal extends EventEmitter {
  constructor(columns = 70, rows = 14) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.screen = new Screen(columns, rows);
    this.written = '';
  }

  write(data) {
    this.written += data;
    this.screen.write(data);
    return true;
  }

  resize(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    this.screen.resize(columns, rows);
    this.emit('resize');
  }

  text() {
    return this.screen.text();
  }
}

/** The environment without CI's variables: Ink draws nothing in CI (is-in-ci), and the apps here must. */
export function quietEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key === 'CI' || key === 'CONTINUOUS_INTEGRATION' || key.startsWith('CI_')) delete env[key];
  return env;
}

/** A new empty folder for the family's moods and activity, so no test reads the real ~/.family. */
export const familyHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-family-'));
  folders.push(dir);
  return dir;
};

/**
 * The host on a Terminal, its apps started by `command(id, args)` ([file, args]; the fake app by
 * default, named after its space) with `env`. Returns { host, term, keys(text), done }. The family's
 * folder is a new empty one unless `family` names one, read every `attentionEvery` ms.
 */
export function startHost({ spaces, first = spaces[0].id, command = (id, args) => [process.execPath, [FAKE, id, ...args]], env = quietEnv(), columns, rows, cwd, family = familyHome(), attentionEvery = 100, bell } = {}) {
  const term = new Terminal(columns, rows);
  const input = new PassThrough();
  const spawn = appSpawner({ env, cwd, command: (id, args) => command(id, args) });
  const host = new Host({ input, output: term, spawn, spaces, familyHome: family, attentionEvery, bell });
  hosts.push(host);
  const done = host.start(first);
  return { host, term, input, done, keys: (text) => input.write(text) };
}

export async function until(check, what, { term, ms = 10000 } = {}) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch {
      // Not yet.
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}.${term ? `\nScreen:\n${term.text()}` : ''}`);
}

/** Whether process `pid` is still running. */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
