// What the end-to-end tests share: rendering App over the demo project with a temporary home, waiting for frames, typing.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.jsx';
import { demoDrill } from '../src/demo.js';

export const KEYS = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b', backspace: '\x7f', tab: '\t', ctrlR: '\x12' };

let lastApp = null;

/** A home folder of its own, so the settings and history a test saves never reach the real ones; returns the cleanup. */
export function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'drill-'));
  process.env.DRILL_HOME = dir;
  // The family's moods and activity too (family.js), never the real ~/.family.
  process.env.FAMILY_HOME = join(dir, 'family');
  return () => rmSync(dir, { recursive: true, force: true });
}

/** Renders App over a fresh demo project (`provider.state` has what it holds), with the clipboard as a recorder. */
export function start(props = {}) {
  const provider = props.provider ?? demoDrill();
  const copied = [];
  lastApp = render(
    React.createElement(App, {
      config: { history: [], editor: 'code' },
      provider,
      cwd: join(tmpdir(), 'shop'),
      moodEvery: 0,
      copy: (text) => copied.push(text),
      ...props,
    }),
  );
  return Object.assign(lastApp, { provider, copied });
}

export async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
    if (check()) return new Promise((r) => setTimeout(r, 200));
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
