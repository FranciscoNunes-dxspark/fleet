// bilge-ignore-file: the tests send made-up credentials on purpose, to see them hidden.
// What the tests share: App over the demo with a temporary home, waiting for frames, typing; and for
// the proxy's tests, origin servers (HTTP and HTTPS with a certificate of a test CA of their own) and
// clients that go through the proxy, plainly and through a CONNECT tunnel.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.jsx';
import { demoLookout } from '../src/demo.js';
import { issue, makeCA, makeLeafKey } from '../src/certs.js';

export const KEYS = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b', backspace: '\x7f', tab: '\t' };

let lastApp = null;
const mounted = new Set();

/** Unmounts what a test left mounted (one that failed before its own unmount), so its timers don't keep the run alive. */
export function unmountAll() {
  for (const app of mounted) app.unmount();
  mounted.clear();
}

/** A home folder of its own (settings, the CA, the family's moods and log), never the real ones; returns { dir, cleanup }. */
export function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'lookout-'));
  process.env.LOOKOUT_HOME = dir;
  process.env.FAMILY_HOME = join(dir, 'family');
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return Object.assign(cleanup, { dir });
}

/** Renders App over the demo (`provider.state` has what it holds), with the clipboard and the browser as recorders. */
export function start(props = {}) {
  const provider = props.provider ?? demoLookout();
  const copied = [];
  const opened = [];
  lastApp = render(
    React.createElement(App, {
      config: { history: [] },
      provider,
      cwd: join(tmpdir(), 'shop'),
      moodEvery: 0,
      copy: (text) => copied.push(text),
      openUrl: (url) => opened.push(url),
      ...props,
    }),
  );
  const app = lastApp;
  const unmount = app.unmount.bind(app);
  mounted.add(app);
  return Object.assign(app, { provider, copied, opened, unmount: () => mounted.delete(app) && unmount() });
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

/** Waits for `check()` to be true (the proxy's records arrive a moment after the response). */
export async function eventually(check, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Two origin servers on 127.0.0.1, HTTP and HTTPS (the latter's certificate for localhost and
 * 127.0.0.1, signed by a CA of the tests' own, `ca`), answering each request with what they got:
 * { method, url, headers, body } as JSON. /gzip answers gzipped, /big a megabyte, /cookie sets cookies.
 */
export async function origins() {
  const ca = makeCA({ cn: 'Lookout tests origin CA' });
  const key = makeLeafKey();
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url === '/big') return res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(1024 * 1024));
      if (req.url === '/gzip') {
        const { gzipSync } = await import('node:zlib');
        return res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end(gzipSync(JSON.stringify({ zipped: true })));
      }
      const headers = { 'content-type': 'application/json' };
      if (req.url === '/cookie') headers['set-cookie'] = ['session=abc123; Path=/', 'theme=dark; Path=/; Secure'];
      res.writeHead(200, headers).end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
    });
  };
  const plain = http.createServer(handler);
  const secure = https.createServer({ key, cert: issue('localhost', ca, key) }, handler);
  await Promise.all([plain, secure].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  return {
    ca,
    http: plain.address().port,
    https: secure.address().port,
    close: () => Promise.all([plain, secure].map((s) => new Promise((r) => (s.closeAllConnections?.(), s.close(r))))),
  };
}

/** A request's answer: { status, headers, body (text) }. */
const collect = (req) =>
  new Promise((done, fail) => {
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), socket: res.socket }));
    });
    req.on('error', fail);
  });

/** A plain HTTP request through the proxy on `proxyPort`: the absolute URL in the request line, as clients send to a proxy. */
export function viaProxy(proxyPort, url, { method = 'GET', headers = {}, body } = {}) {
  const req = http.request({ host: '127.0.0.1', port: proxyPort, method, path: url, headers, agent: false });
  const answer = collect(req);
  req.end(body);
  return answer;
}

/**
 * An agent that reaches HTTPS servers through the proxy: CONNECT host:port, then TLS over the tunnel,
 * trusting `ca` (Lookout's while intercepting, the origin's while tunnelling) and offering `alpn`.
 */
export function tunnelAgent(proxyPort, { ca, alpn = ['http/1.1'] } = {}) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `${options.host}:${options.port}`, agent: false });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return callback(new Error(`CONNECT answered ${res.statusCode}`));
      const s = tls.connect({ socket, servername: options.servername ?? options.host, ca, ALPNProtocols: alpn });
      s.once('secureConnect', () => callback(null, s));
      s.once('error', (e) => callback(e));
    });
    req.on('error', callback);
    req.end();
  };
  return agent;
}

/** An HTTPS request through the proxy with `agent` (tunnelAgent's). */
export function viaTunnel(agent, url, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(url);
  const req = https.request({ host: u.hostname, port: u.port, method, path: `${u.pathname}${u.search}`, headers, agent });
  const answer = collect(req);
  req.end(body);
  return answer;
}

/** A TLS handshake through a CONNECT tunnel alone: resolves the socket, or rejects with the client's error. */
export function handshake(proxyPort, host, port, { ca, alpn = ['http/1.1'], servername = host } = {}) {
  return new Promise((done, fail) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `${host}:${port}`, agent: false });
    req.on('connect', (res, socket) => {
      const s = tls.connect({ socket, servername, ca, ALPNProtocols: alpn });
      s.once('secureConnect', () => done(s));
      s.once('error', fail);
    });
    req.on('error', fail);
    req.end();
  });
}
