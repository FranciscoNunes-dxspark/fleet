// The terminal app signed in to a Keel server (cli/remote.js): a server in sign-in mode on demo
// data, a browser session that allows the terminal's code, then the app working through the server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The server's config reads these on import, so they come first.
const dataDir = mkdtempSync(join(tmpdir(), 'keel-remote-'));
Object.assign(process.env, { AZDO_MOCK: '1', AUTH_MODE: 'login', DATA_DIR: dataDir, ADMIN_SETUP_CODE: 'remote-test-code', SESSION_SECRET: 'r'.repeat(48) });

const express = (await import('express')).default;
const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { createAuth } = await import('../server/auth.js');
const { apiRouter } = await import('../server/routes.js');
const remote = await import('../cli/remote.js');
const { App } = await import('../cli/ui/App.jsx');

let server;
let url;
let cookie;
const browser = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${url}/api${path}`, { method, headers: { 'x-keel': '1', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body) });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, data: await res.json() };
};

before(async () => {
  // As server/index.js wires sign-in mode.
  const auth = createAuth();
  const app = express();
  app.use('/api/auth', auth.router);
  app.use('/api', auth.requireUser, apiRouter());
  await new Promise((done) => {
    server = app.listen(0, '127.0.0.1', done);
  });
  url = `http://127.0.0.1:${server.address().port}`;
  // In the browser: the first admin, with an Azure DevOps token (on demo data, any token-shaped value works).
  assert.equal((await browser('/auth/setup', { method: 'POST', body: { code: 'remote-test-code', name: 'Ana Lead', email: 'ana@example.com', password: 'correct horse battery' } })).status, 200);
  assert.equal((await browser('/auth/token', { method: 'POST', body: { pat: 'a'.repeat(52) } })).status, 200);
});
after(() => {
  server?.closeAllConnections?.();
  server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** `keel login` against the test server, with the browser side answering `allow`. */
async function login(allow = true) {
  let shown = '';
  const output = { write: (s) => (shown += s) };
  const openUrl = async (page) => {
    assert.equal(page, `${url}/terminal`, 'the page to type the code in, without the code');
    const code = shown.match(/[A-Z]{4}-[A-Z]{4}/)[0];
    const seen = await browser(`/auth/device/${code}`);
    assert.equal(seen.data.name, 'ana on test-box (Linux)');
    await browser(`/auth/device/${code}`, { method: 'POST', body: { allow } });
  };
  return remote.deviceLogin({ server: url, output, openUrl, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 30))), name: 'ana on test-box (Linux)' });
}

const until = async (check, what, frame, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame?.()}`);
};

test('Keel addresses: https, or http to this computer only', () => {
  assert.equal(remote.serverUrlFrom('keel.example.com'), 'https://keel.example.com');
  assert.equal(remote.serverUrlFrom(' https://keel.example.com/inbox?x=1 '), 'https://keel.example.com');
  assert.equal(remote.serverUrlFrom('localhost:4280'), 'http://localhost:4280');
  assert.equal(remote.serverUrlFrom('http://127.0.0.1:4280/'), 'http://127.0.0.1:4280');
  for (const bad of ['', 'http://keel.example.com', 'https://me:pw@keel.example.com', 'nothing', 'ftp://keel.example.com']) assert.equal(remote.serverUrlFrom(bad), null, bad);
});

test('server-sent events are read across chunks, pings skipped', async () => {
  async function* body() {
    yield new TextEncoder().encode('retry: 5000\n\n: ping\n\nevent: status\ndata: {"ok":');
    yield new TextEncoder().encode('true}\r\n\r\nevent: notify\ndata: {"items":[]}\n\n');
  }
  const got = [];
  for await (const ev of remote.sseEvents(body())) got.push(ev);
  assert.deepEqual(got, [{ event: 'status', data: '{"ok":true}' }, { event: 'notify', data: '{"items":[]}' }]);
});

test('a refused sign-in gets no token', async () => {
  await assert.rejects(login(false), /refused in the browser/);
});

test('signed in through the browser, the app shows the Inbox as you, votes through the server, and signs out', async () => {
  const { token, user } = await login(true);
  assert.equal(user.email, 'ana@example.com');
  assert.match(token, /^keel_/);

  // The terminal's token reaches /api, never the account pages.
  const asTerminal = remote.keelClient(url, token);
  assert.ok((await asTerminal.call('/meta')).account);
  await assert.rejects(asTerminal.call('/auth/terminals'), (e) => e.status === 401);
  // The browser lists it, by the name it gave.
  assert.deepEqual((await browser('/auth/terminals')).data.map((x) => x.name), ['ana on test-box (Linux)']);

  const keel = await remote.connectKeel({ server: url, token });
  assert.equal(keel.signIn, 'keel');
  const app = render(React.createElement(App, { keel, poll: false, openUrl: () => {} }));
  const frame = () => app.lastFrame() ?? '';
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox', frame);
  assert.match(frame(), /Ana Lead · 127\.0\.0\.1/);

  // Approve the first pull request waiting on review, through the server's /api.
  app.stdin.write('2');
  await until(() => frame().includes('Waiting on your review'), 'the Pull requests tab', frame);
  app.stdin.write('a');
  await until(() => frame().includes('Approved.'), 'the vote', frame);
  app.unmount();

  // Work items too, by number and organization.
  const { items } = await keel.service.workItems();
  const w = items.find((x) => x.priority !== 1);
  await keel.service.workItemAction(w.id, { type: 'update', changes: { priority: 1 } }, w.org);
  assert.equal((await keel.service.workItem(w.id, w.org)).priority, 1);
  assert.ok((await keel.service.newWorkItemOptions()).length);

  // Live updates come from the server's event stream.
  const statuses = [];
  const stop = keel.live.stream({ changed: () => {}, notify: () => {}, status: (s) => statuses.push(s) });
  await until(() => statuses.length > 0, 'a status from the stream');
  stop();
  assert.equal(statuses[0].ok, true);

  // keel logout: the token stops working, and the next start asks to sign in again.
  await keel.logout();
  await assert.rejects(remote.connectKeel({ server: url, token }), (e) => e.code === 'signin-required' && /keel login/.test(e.message));
  assert.deepEqual((await browser('/auth/terminals')).data, []);
});

test('a new password signs every terminal out', async () => {
  const { token } = await login(true);
  assert.ok(await remote.connectKeel({ server: url, token }));
  await browser('/auth/password', { method: 'POST', body: { current: 'correct horse battery', next: 'another horse battery' } });
  await assert.rejects(remote.connectKeel({ server: url, token }), (e) => e.code === 'signin-required');
});
