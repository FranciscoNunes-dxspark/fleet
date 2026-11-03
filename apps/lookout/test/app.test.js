// bilge-ignore-file: the demo's made-up credentials are looked for, to be sure they never show.
// End to end: App over the demo session (and once over the real proxy), typing keys and reading the
// frame, the files it writes, what it copies, and what reaches the family's log and moods.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { contextIn } from '@fleet/kit/family.js';
import { KEYS, eventually, origins, start, tempHome, type, unmountAll, until, viaProxy } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { createLookout } from '../src/provider.js';

let home;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => {
  unmountAll();
  home();
});

const shows = (app, text) => () => app.lastFrame().includes(text);
const JWT_START = 'eyJhbGciOiJIUzI1NiJ9';
const cwd = join(tmpdir(), 'shop');

/** Moves the cursor to the row whose line matches `re`, a step at a time, each seen before the next. */
async function cursorTo(app, re) {
  const cursorLine = () => app.lastFrame().split('\n').find((l) => l.includes('❯')) ?? '';
  app.stdin.write('g');
  await until(() => /❯/.test(app.lastFrame()), 'a cursor');
  for (let i = 0; i < 20 && !re.test(cursorLine()); i++) {
    const before = cursorLine();
    app.stdin.write('j');
    await until(() => cursorLine() !== before, 'the cursor moving');
  }
  assert.match(cursorLine(), re);
}

test('it listens on opening and lists what passes, a refused handshake and a tunnel among them', async () => {
  const app = start();
  await until(shows(app, 'pinned.bank.test'), 'the session');
  const frame = app.lastFrame();
  assert.match(frame, /127\.0\.0\.1:8888/);
  assert.match(frame, /11 captured/);
  assert.match(frame, /\/v1\/products\?page=1/);
  assert.match(frame, /refused/);
  assert.match(frame, /tunnel|tun/);
  assert.match(frame, /1 Requests 11/);
  assert.deepEqual(app.provider.state.calls[0], ['start', 8888]);
  assert.ok(!frame.includes(JWT_START));
  app.unmount();
});

test('↵ shows a request with its credentials hidden; s shows them, and they are hidden again next time', async () => {
  const app = start();
  await until(shows(app, 'pinned.bank.test'), 'the session');
  await cursorTo(app, /\/v1\/me/);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Request headers'), 'the detail');
  assert.match(app.lastFrame(), /Authorization: Bearer ••••/);
  assert.match(app.lastFrame(), /1 hidden, s shows/);
  assert.ok(!app.lastFrame().includes(JWT_START));
  app.stdin.write('s');
  await until(shows(app, JWT_START), 'the token shown');
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Request headers'), 'the list');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Request headers'), 'the detail again');
  assert.ok(!app.lastFrame().includes(JWT_START));
  app.unmount();
});

test('d opens a JSON body (gzipped on the wire) in the data viewer; esc goes back to the request', async () => {
  const app = start();
  await until(shows(app, 'pinned.bank.test'), 'the session');
  await cursorTo(app, /\/v1\/products/);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Request headers'), 'the detail');
  app.stdin.write('d');
  await until(shows(app, 'Response body · GET api.shop.test'), 'the data viewer');
  app.stdin.write(KEYS.esc);
  await until(shows(app, 'Request headers'), 'the detail again');
  app.unmount();
});

test('h writes the request to lookout.http with {{token}} in place of the token, and hands Hail the file', async () => {
  const app = start();
  await until(shows(app, 'pinned.bank.test'), 'the session');
  await cursorTo(app, /POST.*\/v1\/orders/);
  app.stdin.write('h');
  const file = join(cwd, 'lookout.http');
  await until(() => app.provider.state.written.has(file), 'the file');
  const text = app.provider.state.written.get(file);
  assert.match(text, /# @name post-orders\nPOST https:\/\/api\.shop\.test\/v1\/orders\n/);
  assert.match(text, /Authorization: Bearer \{\{token\}\}/);
  assert.match(text, /Cookie: \{\{cookie\}\}/);
  assert.ok(!text.includes(JWT_START) && !text.includes('s3ss10n'));
  assert.deepEqual(app.copied, [`/open ${file.includes(' ') ? `"${file}"` : file}`]);
  await until(shows(app, 'Copied for Hail'), 'the note');
  // Again: a name of its own, added after the first.
  app.stdin.write('h');
  await until(() => /post-orders-2/.test(app.provider.state.written.get(file)), 'the second');
  app.unmount();
});

test("t copies the request as a context for Hail's /take, with no credential in it", async () => {
  const app = start();
  await until(shows(app, 'pinned.bank.test'), 'the session');
  await cursorTo(app, /\/v1\/me/);
  app.stdin.write('t');
  await until(() => app.copied.length === 1, 'the copy');
  const c = contextIn(app.copied[0]);
  assert.equal(c.kind, 'request');
  assert.equal(c.data.url, 'http://api.shop.test:8080/v1/me');
  assert.equal(c.data.headers.Authorization, 'Bearer {{token}}');
  assert.ok(!app.copied[0].includes(JWT_START));
  app.unmount();
});

test('p on a refused row asks, then passes its host through: kept in the settings and told to the proxy', async () => {
  const app = start();
  await until(shows(app, 'pinned.bank.test'), 'the session');
  await cursorTo(app, /pinned\.bank\.test/);
  app.stdin.write('p');
  await until(shows(app, 'Pass pinned.bank.test through untouched?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(() => (loadConfig().passThrough ?? []).includes('pinned.bank.test'), 'the setting');
  assert.ok(app.provider.state.calls.some((c) => c[0] === 'configure' && c[1].passThrough?.includes('pinned.bank.test')));
  app.unmount();
});

test('/intercept on asks before making the CA, then the Setup view says how to trust it', async () => {
  const app = start();
  await until(shows(app, 'pinned.bank.test'), 'the session');
  await type(app.stdin, '/intercept on');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Make a certificate authority for Lookout?'), 'the question');
  assert.ok(!app.provider.state.calls.some((c) => c[0] === 'ensureCA'), 'nothing made before the answer');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'NODE_EXTRA_CA_CERTS=~/.lookout/ca.crt'), 'the Setup view, trusting the CA');
  assert.ok(app.provider.state.calls.some((c) => c[0] === 'ensureCA'));
  assert.ok(app.provider.state.calls.some((c) => c[0] === 'configure' && c[1].intercept === true));
  assert.equal(loadConfig().intercept, true);
  assert.match(app.lastFrame(), /HTTPS_PROXY=http:\/\/127\.0\.0\.1:8888/);
  app.stdin.write('y');
  await until(() => app.copied.includes('HTTPS_PROXY=http://127.0.0.1:8888'), 'the line copied');
  // alt+g: the bottom (a capital letter is alt's, so caps lock can't fire it).
  app.stdin.write('\x1bg');
  await until(shows(app, 'take it out again'), 'the trust steps, at the end');
  app.unmount();
});

test('/filter narrows the list; the Security view says what the traffic shows; /export writes a masked HAR', async () => {
  const app = start();
  await until(shows(app, 'pinned.bank.test'), 'the session');
  await type(app.stdin, '/filter status:5xx');
  app.stdin.write(KEYS.enter);
  await until(shows(app, '1 of 11'), 'the filter');
  assert.match(app.lastFrame(), /\/v1\/orders\/9001/);
  assert.ok(!app.lastFrame().includes('/v1/products'));
  await type(app.stdin, '/export demo.har');
  app.stdin.write(KEYS.enter);
  const file = join(cwd, 'demo.har');
  await until(() => app.provider.state.written.has(file), 'the HAR');
  assert.equal(JSON.parse(app.provider.state.written.get(file)).log.entries.length, 1, 'what is shown');
  await type(app.stdin, '/filter');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Showing all 11'), 'all again');
  await type(app.stdin, '/export all.har');
  app.stdin.write(KEYS.enter);
  const all = join(cwd, 'all.har');
  await until(() => app.provider.state.written.has(all), 'the second HAR');
  const har = app.provider.state.written.get(all);
  assert.ok(!har.includes(JWT_START) && !har.includes('hunter2'));
  app.stdin.write('3');
  await until(shows(app, 'Authorization sent over plain HTTP'), 'the findings');
  assert.match(app.lastFrame(), /Credentials in the query string \(key\)/);
  app.unmount();
});

test('the family hears counts and hosts only: the activity log on /clear, the mood, and /take says whose', async () => {
  const app = start();
  await until(shows(app, 'pinned.bank.test'), 'the session');
  await type(app.stdin, '/take family:v1:commit:eyJoYXNoIjoiYWJjZGVmIn0');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'for Splice'), 'whose it is');
  await type(app.stdin, '/clear');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Forget 11 captured exchanges?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Forgot 11'), 'cleared');
  const familyDir = process.env.FAMILY_HOME;
  const log = readFileSync(join(familyDir, 'activity.jsonl'), 'utf8');
  assert.match(log, /Captured \d+ requests to api\.shop\.test and \d+ to \d+ other hosts/);
  const everything = readdirSync(familyDir).map((f) => readFileSync(join(familyDir, f), 'utf8')).join('\n');
  for (const secret of [JWT_START, 'hunter2', 's3ss10n', '/login', '/v1/', 'AIza']) assert.ok(!everything.includes(secret), `${secret} stays out of the family's files`);
  app.unmount();
});

test('over the real proxy: a request sent through it shows up, and the session\'s findings are kept for lookout security', async () => {
  const origin = await origins();
  const app = start({ provider: createLookout(), port: 0 });
  try {
    await until(() => /127\.0\.0\.1:(\d+)/.test(app.lastFrame()) && !app.lastFrame().includes(':0 '), 'listening');
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(app.lastFrame())[1]);
    const r = await viaProxy(port, `http://127.0.0.1:${origin.http}/api/me`, { headers: { authorization: 'Bearer real-token-123456' } });
    assert.equal(r.status, 200);
    await until(shows(app, '/api/me'), 'the row');
    assert.match(app.lastFrame(), /1 captured/);
    const file = join(home.dir, 'findings.json');
    await eventually(() => existsSync(file), 'the findings kept', 5000);
    const kept = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(kept.app, 'lookout');
    assert.equal(kept.findings[0].rule, 'token-over-http');
    assert.ok(!readFileSync(file, 'utf8').includes('real-token'));
  } finally {
    app.unmount();
    await origin.close();
  }
});
