// What the end-to-end tests share: rendering App with a temporary home, waiting for frames, typing.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.jsx';

export const KEYS = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b', backspace: '\x7f', tab: '\t' };

let lastApp = null;

/** A home folder of its own, so the settings a test saves never reach the real one; returns the cleanup. */
export function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'bosun-'));
  process.env.BOSUN_HOME = dir;
  // The family's moods too (family.js), never the real ~/.family.
  process.env.FAMILY_HOME = join(dir, 'family');
  return () => rmSync(dir, { recursive: true, force: true });
}

/** A crew that's never started (nothing runs): for the tests about the UI, not the processes. */
export const quietCrew = (names = ['api', 'web', 'worker']) => async () => ({
  dir: '.',
  file: null,
  from: 'a test',
  procs: names.map((name, i) => ({ name, run: `node ${name}.js`, cwd: '.', port: i === 0 ? 4999 : null, health: null, env: {}, after: null })),
  profiles: {},
  problems: [],
});

/** A project folder with this bosun.json (and any other files, by name); returns its path. */
export function project(spec, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bosun-project-'));
  writeFileSync(join(dir, 'bosun.json'), JSON.stringify(spec));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/**
 * Renders App with `props` (a config of its own unless given), remembered for until's message. Unless
 * given a folder or a crew, it's a quiet one that starts nothing, and Claude, the browser and the
 * port lookups are stubs.
 */
export function start(props = {}) {
  const quiet = !props.dir && !props.load;
  lastApp = render(
    React.createElement(App, {
      config: { history: [] },
      ...(quiet ? { load: quietCrew(), autostart: false } : {}),
      askClaude: async () => 'Claude is not here in the tests.',
      openUrl: () => {},
      pidsOnPort: () => [],
      killPids: () => {},
      listPorts: () => [],
      runHail: async () => ({ missing: true }),
      ...props,
    }),
  );
  return lastApp;
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
