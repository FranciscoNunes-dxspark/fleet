// /compare: the same request in two environments, the pure parts and through the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeLine, compareAnswers, headerChanges, jsonChanges } from '../src/compare.js';
import { hailEnvironmentNamed } from '../src/project.js';
import { suggestionsFor } from '../src/commands.js';
import { KEYS, start, tempHome, until } from './helpers.js';

test('JSON compared by path: added, removed and changed values, arrays index by index', () => {
  const a = { id: 1, name: 'ana', tags: ['x', 'y'], price: { amount: 9.5 }, gone: true, 'odd key': 1 };
  const b = { id: 1, name: 'Ana', tags: ['x'], price: { amount: 10, currency: 'EUR' }, 'odd key': '1' };
  assert.deepEqual(jsonChanges(a, b), [
    { path: '.name', kind: 'changed', before: 'ana', after: 'Ana' },
    { path: '.tags[1]', kind: 'removed', before: 'y' },
    { path: '.price.amount', kind: 'changed', before: 9.5, after: 10 },
    { path: '.price.currency', kind: 'added', after: 'EUR' },
    { path: '.gone', kind: 'removed', before: true },
    { path: '."odd key"', kind: 'changed', before: 1, after: '1' },
  ]);
  assert.deepEqual(jsonChanges([1, { a: 1 }], [1, { a: 1 }]), []);
  assert.deepEqual(jsonChanges({ a: 1 }, [1]), [{ path: '', kind: 'changed', before: { a: 1 }, after: [1] }]);
  assert.equal(changeLine({ path: '.price.amount', kind: 'changed', before: 9.5, after: 10 }), '~ .price.amount  9.5 → 10');
  assert.equal(changeLine({ path: '', kind: 'added', after: 'x' }), '+ .  "x"');
  assert.equal(jsonChanges(Array.from({ length: 50 }, (_, i) => i), [], { max: 10 }).length, 10);
});

test("headers: the ones that always differ left out, cookies by name, the rest compared", () => {
  const a = [['Date', 'Mon'], ['X-Request-Id', '1'], ['ETag', '"a"'], ['Server-Timing', 'db;dur=3'], ['Content-Type', 'application/json'], ['Set-Cookie', 'sid=abc; Path=/'], ['X-Version', '1.2'], ['Cache-Control', 'no-store']];
  const b = [['date', 'Tue'], ['x-request-id', '2'], ['etag', '"b"'], ['content-type', 'application/json'], ['set-cookie', 'sid=xyz; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT, theme=dark'], ['x-version', '1.3'], ['x-new', 'yes']];
  assert.deepEqual(headerChanges(a, b), [
    { name: 'cache-control', before: 'no-store', after: undefined },
    { name: 'set-cookie', before: 'sid', after: 'sid, theme' },
    { name: 'x-new', before: undefined, after: 'yes' },
    { name: 'x-version', before: '1.2', after: '1.3' },
  ]);
  assert.deepEqual(headerChanges([['Set-Cookie', 'sid=1']], [['set-cookie', 'sid=2']]), [], "a cookie's value always differs");
});

test('two answers: the same apart from their time, or differing in status, headers and body; text line by line', () => {
  const json = (body, extra = []) => ({ status: 200, statusText: 'OK', ms: 10, headers: [['Content-Type', 'application/json'], ...extra], body: JSON.stringify(body) });
  const same = compareAnswers(json({ a: 1 }, [['Date', 'x']]), { ...json({ a: 1 }), ms: 99 });
  assert.equal(same.same, true);
  assert.deepEqual(same.ms, { before: 10, after: 99 });
  const c = compareAnswers(json({ a: 1 }), { ...json({ a: 2 }, [['X-Env', 'b']]), status: 500 });
  assert.equal(c.same, false);
  assert.deepEqual(c.status, { before: 200, after: 500, same: false });
  assert.deepEqual(c.headers, [{ name: 'x-env', before: undefined, after: 'b' }]);
  assert.deepEqual(c.body, { kind: 'json', changes: [{ path: '.a', kind: 'changed', before: 1, after: 2 }] });
  const text = compareAnswers({ status: 200, headers: [], body: 'one\ntwo\nthree' }, { status: 200, headers: [], body: 'one\n2\nthree' });
  assert.equal(text.body.kind, 'text');
  assert.deepEqual(text.body.diff.filter(([m]) => m !== ' '), [['-', 'two'], ['+', '2']]);
});

let cleanup;
let dir;
let server;
const seen = [];
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-compare-'));
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, '.fleet'));
  writeFileSync(join(dir, '.fleet', 'project.json'), JSON.stringify({ default: 'dev', environments: { dev: { hail: { env: 'local' } }, live: { prod: true, hail: { env: 'production' } } } }));
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    const prod = req.url.startsWith('/prod');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Request-Id', String(seen.length));
    res.setHeader('X-Version', prod ? '1.2' : '1.3');
    res.end(JSON.stringify({ id: 42, total: prod ? 9.5 : 10, items: prod ? ['a', 'b'] : ['a'], ...(prod ? {} : { currency: 'EUR' }) }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(dir, 'http-client.env.json'), JSON.stringify({ local: { host: `${host}/local` }, production: { host: `${host}/prod` }, staging: { host: `${host}/local` } }));
  writeFileSync(join(dir, 'api.http'), '### Order\nGET {{host}}/orders/42\n\n### Pay\nPOST {{host}}/orders/42/pay\n');
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

async function run(app, line) {
  app.stdin.write('/');
  await new Promise((r) => setTimeout(r, 50));
  app.stdin.write(line.replace(/^\//, ''));
  await new Promise((r) => setTimeout(r, 50));
  app.stdin.write(KEYS.enter);
}

test("a name for /compare: Hail's own, or a project environment's by the Hail environment it names", () => {
  const names = ['local', 'production', 'staging'];
  assert.deepEqual(hailEnvironmentNamed('PRODUCTION', { names, dir }), { env: 'production' });
  assert.deepEqual(hailEnvironmentNamed('live', { names, dir }), { env: 'production', via: 'live' });
  assert.match(hailEnvironmentNamed('nope', { names, dir }).error, /Hail's: local, production, staging; the project's: dev, live/);
  assert.match(hailEnvironmentNamed('live', { names: ['local'], dir }).error, /doesn't have/);
  const data = { requests: [], environments: { names } };
  assert.deepEqual(suggestionsFor('/compare ', { data, environment: 'local', projectEnvs: ['dev', 'live'] }).map((s) => s.label), ['production', 'staging', 'dev', 'live']);
});

test('/compare sends the request in both environments and shows the differences; a POST to production asks first', async () => {
  const app = start({ initialFile: join(dir, 'api.http'), cwd: dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Order') && /env local/.test(frame()), 'the file, in local');
    await run(app, '/compare live');
    await until(() => frame().includes('Compared Order: local and production'), 'the comparison');
    const f = frame();
    assert.ok(seen.some((s) => s.url === '/local/orders/42') && seen.some((s) => s.url === '/prod/orders/42'), 'sent in both');
    assert.match(f, /~ x-version: 1\.3 → 1\.2/);
    assert.match(f, /~ \.total {2}10 → 9\.5/);
    assert.match(f, /\+ \.items\[1\] {2}"b"/);
    assert.match(f, /- \.currency {2}"EUR"/);
    assert.ok(!/x-request-id/i.test(f), 'request ids left out');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Compared Order'), 'closed');
    // The same answers: said so.
    await run(app, '/compare staging');
    await until(() => frame().includes('The same status, headers and body.'), 'the same');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('The same status'), 'closed');
    // alt+c on a POST: the picker, then production's question; No sends nothing.
    app.stdin.write(KEYS.down);
    await new Promise((r) => setTimeout(r, 100));
    const before = seen.length;
    app.stdin.write('\x1bc');
    await until(() => frame().includes('Compare Pay: local and'), 'the picker');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('live is production. Send Pay in local and production to compare?'), 'the question');
    app.stdin.write('1');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(seen.length, before, 'nothing sent');
  } finally {
    app.unmount();
  }
});
