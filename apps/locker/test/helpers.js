// What the end-to-end tests share: rendering App over the demo Azure and folder with a temporary home,
// waiting for frames, typing.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.jsx';
import { demoAzure, demoLocal } from '../src/demo.js';

export const KEYS = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b', backspace: '\x7f', tab: '\t', ctrlP: '\x10' };

let lastApp = null;

/** A home folder of its own, so the settings a test saves never reach the real one; returns the cleanup. */
export function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'locker-'));
  process.env.LOCKER_HOME = dir;
  // The family's moods and activity too (family.js), never the real ~/.family.
  process.env.FAMILY_HOME = join(dir, 'family');
  return () => rmSync(dir, { recursive: true, force: true });
}

/**
 * Renders App over a fresh demo Azure and folder (`provider.state`, `local.state` have what they hold),
 * with the clipboard, its guard, the notifications and the browser as recorders.
 */
export function start(props = {}) {
  const provider = props.provider ?? demoAzure();
  const local = props.local ?? demoLocal();
  const copied = [];
  const secrets = [];
  const notified = [];
  const opened = [];
  lastApp = render(
    React.createElement(App, {
      config: { history: [] },
      provider,
      local,
      cwd: local.dir,
      moodEvery: 0,
      copy: (text) => copied.push(text),
      guard: { put: async (v) => secrets.push(v), flush: async () => {}, pending: () => false },
      notify: (title, body) => notified.push({ title, body }),
      openUrl: (url) => opened.push(url),
      ...props,
    }),
  );
  return Object.assign(lastApp, { provider, local, copied, secrets, notified, opened });
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
