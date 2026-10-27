// What the end-to-end tests share: rendering App over the demo Docker with a temporary home, waiting for frames, typing.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.jsx';
import { demoDocker } from '../src/demo.js';
import { demoKube } from '../src/demokube.js';

export const KEYS = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b', backspace: '\x7f', tab: '\t' };

let lastApp = null;

/** A home folder of its own, so the settings a test saves never reach the real one; returns the cleanup. */
export function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'wharf-'));
  process.env.WHARF_HOME = dir;
  // The family's moods and activity too (family.js), never the real ~/.family.
  process.env.FAMILY_HOME = join(dir, 'family');
  return () => rmSync(dir, { recursive: true, force: true });
}

/** Renders App over a fresh demo Docker (`provider.state` has what it holds), with the clipboard and the browser as recorders. */
export function start(props = {}) {
  const provider = props.provider ?? demoDocker();
  const kube = props.kube ?? demoKube();
  const copied = [];
  const opened = [];
  lastApp = render(
    React.createElement(App, {
      config: { history: [] },
      provider,
      kube,
      pollEvery: 0,
      copy: (text) => copied.push(text),
      openUrl: (url) => opened.push(url),
      ...props,
    }),
  );
  return Object.assign(lastApp, { provider, kube, copied, opened });
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
