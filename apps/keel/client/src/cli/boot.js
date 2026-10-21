// The terminal app (cli/), Ink and all, drawn into xterm.js: Ink writes to a stdout that is the
// terminal on the page and reads keys from a stdin that xterm types into. The app reaches Keel
// through this server's /api, as `keel login` does (cli/remote.js), with the page's own sign-in.
import './shims/process.js'; // first: Ink and the terminal app read `process` as they load
import React from 'react';
import { render } from 'ink';
import chalk from 'chalk';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { EventEmitter } from './shims/events.js';
import { keelClient, remoteLive, remoteService } from '../../../cli/remote.js';
import { mouseSession } from '../../../cli/mouse.js';
import { App } from '../../../cli/ui/App.jsx';

// chalk's browser build only trusts Chromium with colours; xterm.js shows them all.
chalk.level = 3;

class TermStdout extends EventEmitter {
  constructor(term) {
    super();
    this.term = term;
    this.isTTY = true;
    this.writable = true;
  }
  get columns() {
    return this.term.cols;
  }
  get rows() {
    return this.term.rows;
  }
  write(data, encoding, done) {
    this.term.write(typeof data === 'string' ? data : new TextDecoder().decode(data));
    (typeof encoding === 'function' ? encoding : done)?.();
    return true;
  }
}

// Ink reads stdin as Node's paused mode: 'readable', then read() until it returns null.
class TermStdin extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.queue = [];
  }
  type(data) {
    this.queue.push(data);
    this.emit('readable');
    this.emit('data', data);
  }
  read() {
    return this.queue.length ? this.queue.shift() : null;
  }
  unshift(data) {
    this.queue.unshift(String(data));
  }
  setRawMode() {
    return this;
  }
  setEncoding() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
}

/** The `keel` the App takes, over this server's /api with the page's cookie. */
async function connect() {
  // remoteLive calls client.fetch(…) as a method, and the browser's fetch refuses any `this` but window.
  const client = keelClient(location.origin, null, { fetch: (...args) => fetch(...args) });
  const [status, meta, orgs] = await Promise.all([client.call('/auth/status'), client.call('/meta'), client.call('/orgs')]);
  const login = status?.mode === 'login';
  return {
    service: remoteService(client),
    orgs,
    signIn: meta.mock ? 'demo' : login ? 'keel' : 'pat',
    account: status?.user,
    server: location.origin,
    live: remoteLive(client),
    orgAdmin: {
      add: (org) => client.call('/orgs', { method: 'POST', body: org }),
      remove: (key) => client.call(`/orgs/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    },
    logout: login ? () => client.call('/auth/logout', { method: 'POST', body: {} }) : undefined,
  };
}

/**
 * Starts the terminal app in `el`. `onExit` runs when it quits (q); the returned function stops it
 * when the page goes. Aborting `signal` before then (the page went while the font loaded) starts nothing.
 */
export async function startTerminal(el, { theme, fontFamily, onExit, signal }) {
  await document.fonts?.load(`14px ${fontFamily}`).catch(() => {});
  if (signal?.aborted) return () => {};
  // convertEol: Ink ends lines with \n alone, which a terminal's driver turns into \r\n.
  const term = new Terminal({ fontFamily, fontSize: 14, lineHeight: 1, cursorBlink: false, theme, convertEol: true, scrollback: 0 });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();
  term.focus();

  const stdout = new TermStdout(term);
  const stdin = new TermStdin();
  const typed = term.onData((d) => stdin.type(d));
  const resized = term.onResize(() => stdout.emit('resize'));
  const observer = new ResizeObserver(() => fit.fit());
  observer.observe(el);

  let app;
  let stopped = false;
  try {
    const keel = await connect();
    const mouse = mouseSession(stdin, stdout);
    // The alternate screen, as cli.jsx draws: no scrollback under the frames.
    stdout.write('\x1b[?1049h\x1b[H');
    app = render(React.createElement(App, { keel, mouse, openUrl: (url) => window.open(url, '_blank', 'noopener,noreferrer') }), {
      stdout: mouse.stdout,
      stdin,
      stderr: stdout,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    // Only when the app quits itself (q), not when the page stops it.
    app.waitUntilExit().then(() => stopped || onExit?.());
  } catch (e) {
    term.write(`\r\n\x1b[31m${e.message}\x1b[39m\r\n`);
  }
  return () => {
    stopped = true;
    app?.unmount();
    observer.disconnect();
    typed.dispose();
    resized.dispose();
    term.dispose();
  };
}
