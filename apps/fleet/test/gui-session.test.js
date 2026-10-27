// `fleet gui` without a browser: the session runs small fake apps (test/fixtures/fake-app.js, hosted as
// the real ones are) and the tests read the frames it would send the window, and its server's
// guards and actions over HTTP.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuiSession } from '../src/gui/session.js';
import { guiServer, loadClient } from '../src/gui/server.js';
import { appSpawner } from '../src/launch.js';
import { FAKE, quietEnv, until } from './helpers.js';

const SPACES = [
  { id: 'one', title: 'One', letter: 'o', accent: '#5fd787' },
  { id: 'two', title: 'Two', letter: 'w', accent: '#5fafff' },
];

const sessions = [];
const folders = [];
after(() => {
  for (const s of sessions) s.stop();
  for (const s of sessions) for (const sp of s.spaces) sp.child?.kill(true);
  for (const d of folders) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-gui-'));
  folders.push(dir);
  return dir;
}

/** A session over fake apps, with what it sent kept: `events`, and each space's screen as text. */
function start({ env = quietEnv(), size = { columns: 100, rows: 6 } } = {}) {
  const family = tempDir();
  const session = new GuiSession({
    spawn: appSpawner({ env, command: (id, args) => [process.execPath, [FAKE, id, ...args]] }),
    spaces: SPACES,
    size,
    familyHome: family,
    attentionEvery: 100,
  });
  sessions.push(session);
  const events = [];
  const screens = {};
  session.listen((e) => {
    events.push(e);
    if (e.type !== 'frame') return;
    const rows = (screens[e.id] = e.whole ? [] : (screens[e.id] ?? []));
    for (const [y, runs] of e.rows) {
      let line = '';
      for (const [x, text] of runs) line = line.padEnd(x) + text;
      rows[y] = line;
    }
  });
  const screen = (id) => (screens[id] ?? []).map((l) => l ?? '');
  return { session, events, screen, family };
}

test('a space shown starts its app, and its screen comes as frames of runs', async () => {
  const { session, screen, events } = start();
  session.show(['one']);
  assert.equal(session.space('one').state, 'running');
  await until(() => screen('one')[0] === 'one 100x6', 'the first frame');
  assert.equal(screen('one')[1], 'keys: ""');
  assert.ok(events.some((e) => e.type === 'spaces' && e.spaces.find((s) => s.id === 'one').state === 'running'));
  // Keys typed in the window reach it.
  await until(() => session.space('one').ready, 'it reads keys');
  session.input('one', 'hi');
  await until(() => screen('one')[1] === 'keys: "hi"', 'the keys');
  // The window's pane size is the app's.
  session.resize('one', 50, 8);
  await until(() => screen('one')[0] === 'one 50x8', 'the new size');
  // A snapshot carries every started screen whole, for a window opening now.
  const hello = session.snapshot();
  assert.equal(hello.type, 'hello');
  assert.equal(hello.frames.length, 1);
  assert.ok(hello.frames[0].rows.some(([, runs]) => runs.some(([, t]) => t === 'one 50x8')));
});

test("a hand-off shows the app it's for and types the line once it reads keys; the clipboard and bell reach the window", async () => {
  const { session, screen, events } = start({ env: quietEnv({ FAKE_HANDOFF: 'two' }) });
  session.show(['one']);
  await until(() => session.space('one').ready, 'one reads keys');
  session.input('one', 'H');
  await until(() => session.shown[0] === 'two' && session.space('two').state === 'running', 'two shown and started');
  assert.ok(events.some((e) => e.type === 'focus' && e.id === 'two'));
  await until(() => screen('two')[1] === `keys: "/take family:v1:commit:eyJoYXNoIjoiYWJjIn0"`, 'the line typed into two');
  session.input('two', 'C');
  await until(() => events.some((e) => e.type === 'copy' && e.text === 'copied') && events.some((e) => e.type === 'bell' && e.id === 'two'), 'the copy and the bell');
});

test('mouse reports reach only an app that asked for them', async () => {
  const { session, screen } = start();
  session.show(['one']);
  await until(() => session.space('one').ready, 'one reads keys');
  session.input('one', 'a\x1b[<0;3;2Mb');
  await until(() => screen('one')[1] === 'keys: "ab"', 'the report taken out');
  session.input('one', 'M');
  await until(() => session.space('one').filter.wantsMouse(), 'the mouse on');
  session.input('one', '\x1b[<0;3;2M');
  await until(() => screen('one')[1].includes('\\u001b[<0;3;2M'), 'the report passed on');
});

test('an app that exits says so with its code, and ↵ or restart starts it again', async () => {
  const { session, events } = start();
  session.show(['one']);
  await until(() => session.space('one').ready, 'one reads keys');
  session.input('one', 'X');
  await until(() => session.space('one').state === 'exited', 'exited');
  assert.equal(session.space('one').code, 3);
  assert.ok(events.some((e) => e.type === 'spaces' && e.spaces.find((s) => s.id === 'one').code === 3));
  session.input('one', '\r');
  await until(() => session.space('one').state === 'running', 'started again');
  await until(() => session.space('one').ready, 'reads keys again');
  session.restart('one');
  await until(() => session.space('one').state === 'running' && session.space('one').ready, 'restarted by hand');
});

test('moving the fleet starts every running app again in the new folder', async () => {
  const { session, screen } = start();
  const dir = tempDir();
  session.show(['one']);
  await until(() => session.space('one').ready, 'one reads keys');
  const before = session.space('one').child;
  session.moveTo(dir);
  await until(() => session.space('one').child && session.space('one').child !== before && session.space('one').ready, 'started again');
  session.input('one', 'P');
  await until(() => screen('one')[1]?.includes(dir.replace(/\\/g, '\\\\')), 'it runs in the new folder');
});

test('a worried app off screen gets a badge; showing it clears it', async () => {
  const { session, family, events } = start();
  session.start();
  session.show(['one']);
  writeFileSync(join(family, 'two.mood.json'), JSON.stringify({ app: 'two', mood: 'worried', reason: 'api crashed', at: Date.now() + 1000 }));
  await until(() => session.space('two').badge?.alert, 'the badge');
  assert.ok(events.some((e) => e.type === 'attention' && e.id === 'two' && e.reason === 'api crashed'));
  session.show(['two']);
  assert.equal(session.space('two').badge, null);
});

test("the server: the run's key, the loopback host, the x-fleet header, then the window's actions", async () => {
  const { session, screen } = start();
  const server = guiServer(session, { files: await loadClient(), token: 'ab12' });
  const url = await server.listen(0);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    assert.equal(url, `${base}/?t=ab12`);
    assert.equal((await fetch(`${base}/`)).status, 403);
    assert.equal((await fetch(`${base}/?t=nope`)).status, 403);
    // The key in the address becomes a cookie, and leaves the address.
    const first = await fetch(url, { redirect: 'manual' });
    assert.equal(first.status, 303);
    const cookie = first.headers.get('set-cookie').split(';')[0];
    assert.equal(cookie, 'fleet=ab12');
    assert.match(first.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const page = await fetch(`${base}/`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Fleet<\/title>/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(`${base}/app.js`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/logo/splice.svg`, { headers: { cookie } })).headers.get('content-type'), 'image/svg+xml');
    // Another host name (DNS rebinding) is turned away, key or not.
    const { request } = await import('node:http');
    const status = await new Promise((resolve) => {
      request({ host: '127.0.0.1', port: server.port, path: '/?t=ab12', headers: { host: `evil.example:${server.port}` } }, (res) => resolve(res.statusCode)).end();
    });
    assert.equal(status, 421);
    // An action needs the header no other site's form can send.
    const post = (action, body, headers = { 'x-fleet': '1' }) => fetch(`${base}/api/${action}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('show', { ids: ['one'] }, {})).status, 403);
    assert.deepEqual(await (await post('show', { ids: ['one'] })).json(), { ok: true });
    await until(() => session.space('one').ready, 'one reads keys');
    await post('input', { id: 'one', data: 'zz' });
    await until(() => screen('one')[1] === 'keys: "zz"', 'keys through the server');
    const moved = await (await post('move', { folder: '/no/such/folder/anywhere' })).json();
    assert.equal(moved.ok, false);
    assert.equal((await post('nonsense', {})).status, 404);
    // The events stream starts with everything a window needs.
    const ac = new AbortController();
    const events = await fetch(`${base}/events`, { headers: { cookie }, signal: ac.signal });
    const reader = events.body.getReader();
    const { value } = await reader.read();
    const hello = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ''));
    assert.equal(hello.type, 'hello');
    assert.deepEqual(hello.spaces.map((s) => s.id), ['one', 'two']);
    ac.abort();
  } finally {
    await server.close();
  }
});
