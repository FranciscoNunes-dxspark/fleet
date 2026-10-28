// /replay: a request sent again elsewhere and the answers compared, the pure parts and through the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeContext, encodeContext, takeLine } from '@fleet/kit/family.js';
import { environmentsFrom } from '../src/environments.js';
import { compareResponses, lastResponseTo, normaliseBase, rebaseUrl, replayHeaders, replayTargets, statusLine, targetNamed } from '../src/replay.js';
import { KEYS, start, tempHome, until } from './helpers.js';

test('the headers sent again: no hop-by-hop ones, no credentials, and the environment\'s own credentials in their place', () => {
  const headers = { Host: 'prod', Connection: 'keep-alive', 'Content-Length': '9', Accept: 'application/json', Authorization: 'Bearer PRODTOKEN', Cookie: 'sid=1', 'X-Api-Key': 'k', 'X-Session-Token': 't', 'X-Trace': 'a' };
  const none = replayHeaders(headers, {});
  assert.deepEqual(none.headers, [['Accept', 'application/json'], ['X-Trace', 'a']]);
  assert.deepEqual(none.dropped, ['Authorization', 'Cookie', 'X-Api-Key', 'X-Session-Token']);
  assert.deepEqual(none.added, []);
  assert.ok(!JSON.stringify(none).includes('PRODTOKEN'));
  // A token variable becomes a bearer header, an API key one the key header, each as a variable to fill in.
  const env = replayHeaders(headers, { host: 'http://localhost:5000', Token: 'dev-token', apiKey: 'dev-key' });
  assert.deepEqual(env.headers.slice(2), [['Authorization', 'Bearer {{Token}}'], ['X-Api-Key', '{{apiKey}}']]);
  assert.deepEqual(env.added, ['Authorization', 'X-Api-Key']);
  // A kept entry's list, its credentials already hidden by History.
  assert.deepEqual(replayHeaders([['Authorization', '••••••'], ['Accept', '*/*']], { authorization: 'Basic a:b' }).headers, [['Accept', '*/*'], ['Authorization', '{{authorization}}']]);
});

test('the address: typed bases, the path kept under the base, environments and Bosun\'s ports', () => {
  assert.equal(normaliseBase(':5000'), 'http://localhost:5000');
  assert.equal(normaliseBase('localhost:5000/'), 'http://localhost:5000');
  assert.equal(normaliseBase('https://dev.example.com/api/'), 'https://dev.example.com/api');
  assert.equal(normaliseBase('not an address'), null);
  assert.equal(normaliseBase('ftp://x'), null);
  assert.equal(rebaseUrl('https://prod.example.com/api/orders/42?full=1', 'http://localhost:5000'), 'http://localhost:5000/api/orders/42?full=1');
  assert.equal(rebaseUrl('https://prod.example.com/orders', 'http://localhost:5000/api'), 'http://localhost:5000/api/orders');
  assert.equal(rebaseUrl('https://prod.example.com/api/orders', 'http://localhost:5000/api/'), 'http://localhost:5000/api/orders');
  assert.equal(rebaseUrl('{{host}}/players/1', 'http://localhost:1'), 'http://localhost:1/players/1');
  const envs = environmentsFrom([{ $shared: { token: 'x' }, local: { host: 'http://localhost:5000' }, staging: { baseUrl: 'https://staging.example.com' }, other: { name: 'n' } }]);
  const bosun = { procs: { api: { run: 'dotnet run', port: 5000, https: true }, worker: { run: 'node w.js' }, web: { run: 'vite', port: 5173 } } };
  assert.deepEqual(
    replayTargets({ envs, bosun }).map((t) => [t.label, t.base ?? t.hostVar]),
    [['local', 'host'], ['staging', 'baseUrl'], ["Bosun's api", 'http://localhost:5000'], ["Bosun's api (https)", 'https://localhost:5001'], ["Bosun's web", 'http://localhost:5173']],
  );
  assert.deepEqual(targetNamed('STAGING', { envs }), { label: 'staging', env: 'staging', hostVar: 'baseUrl' });
  assert.match(targetNamed('other', { envs }).error, /no host/);
  assert.deepEqual(targetNamed(':8080', { envs }), { label: 'http://localhost:8080', base: 'http://localhost:8080' });
  assert.equal(targetNamed('nonsense here', { envs }), null);
});

test('the answers compared: status, the headers that say something and the body; or the status alone without a body', () => {
  const prod = { status: 500, statusText: 'Internal Server Error', headers: [['Content-Type', 'application/json'], ['Date', 'Mon'], ['X-Request-Id', '1']], body: '{"error":"boom","id":42}' };
  const local = { status: 200, statusText: 'OK', headers: [['content-type', 'application/json'], ['Date', 'Tue'], ['X-Request-Id', '2']], body: '{"id":42,"error":"boom"}' };
  const c = compareResponses(prod, local);
  assert.equal(c.compared, 'all');
  assert.equal(c.status, false);
  const changed = c.diff.filter(([m]) => m !== ' ');
  assert.deepEqual(changed.slice(0, 2), [['-', '500'], ['+', '200']]);
  // The bodies are compared as indented JSON, the headers that change on every response left out.
  assert.ok(changed.some(([m, l]) => m === '-' && l === '  "error": "boom",'));
  assert.ok(!c.diff.some(([, l]) => /date|x-request-id/i.test(l)));
  assert.ok(c.diff.some(([m, l]) => m === ' ' && l === 'content-type: application/json'));
  assert.ok(compareResponses({ ...local, headers: [['Date', 'x'], ['content-type', 'application/json']] }, local).same, 'volatile headers and status text aside, the same');
  // Sonar's request: a status and a time, no body; History's last response to it stands in for one.
  const sonar = { status: 500, ms: 4211 };
  assert.deepEqual(compareResponses(sonar, local), { same: false, status: false, diff: [['-', '500'], ['+', '200']], compared: 'status' });
  const kept = compareResponses(sonar, local, { bodyFrom: { headers: [['Content-Type', 'application/json']], body: '{"id":41}' } });
  assert.equal(kept.compared, 'all');
  assert.ok(kept.diff.some(([m, l]) => m === '-' && l.includes('41')));
  assert.equal(statusLine(sonar), '500 · 4211 ms');
  assert.equal(statusLine(null), 'unknown');
});

test('the last response kept to the same request, whatever host it went to', () => {
  const e = (at, method, url) => ({ at, request: { method, url } });
  const entries = [e(1, 'GET', 'http://a/orders/1'), e(2, 'POST', 'http://a/orders/1'), e(3, 'GET', 'http://b/orders/1?x=1'), e(4, 'GET', 'http://b/orders/1')];
  assert.equal(lastResponseTo(entries, { method: 'get', url: 'https://prod/orders/1' }).at, 4);
  assert.equal(lastResponseTo(entries, { method: 'GET', url: 'https://prod/orders/1' }, { not: entries[3] }).at, 1);
  assert.equal(lastResponseTo(entries, { url: 'https://prod/orders/1?x=1' }).at, 3);
  assert.equal(lastResponseTo(entries, { method: 'DELETE', url: 'https://prod/orders/1' }), null);
});

test("Sonar's request context carries its response, and older ones without it still read", () => {
  const data = { method: 'GET', url: 'https://prod/x', headers: {}, body: '', name: 'GET /x', app: 'shop', response: { status: 500, ms: 12 } };
  assert.deepEqual(decodeContext(encodeContext('request', data)), { kind: 'request', data });
  assert.equal(decodeContext(encodeContext('request', { method: 'GET', url: 'https://prod/x' })).data.response, undefined);
});

let cleanup;
let dir;
let server;
const seen = [];
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-replay-'));
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 42, status: req.url.includes('broken') ? 'broken' : 'fine' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(dir, 'http-client.env.json'), JSON.stringify({ local: { host, token: 'local-token' } }));
  writeFileSync(join(dir, 'api.http'), '### Order\nGET {{host}}/orders/42\n');
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

test("a request taken from Sonar replayed against the environment and compared with production's answer", async () => {
  const app = start({ initialFile: join(dir, 'api.http') });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Order'), 'the requests');
    // Sent once first, so History has a body to compare with.
    app.stdin.write(KEYS.enter);
    await until(() => seen.length === 1, 'the first send');
    await run(app, takeLine('request', { method: 'GET', url: 'https://prod.example.com/orders/42', headers: { Authorization: 'Bearer PRODTOKEN', Accept: 'application/json' }, body: '', name: 'GET /orders/42', app: 'shop', response: { status: 500, ms: 4211 } }));
    await until(() => frame().includes('Replay it elsewhere and compare'), 'the question');
    assert.match(frame(), /500 · 4211 ms/);
    app.stdin.write(KEYS.down);
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write(KEYS.down);
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('send it there and compare'), 'where to');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Replayed GET /orders/42'), 'the comparison');
    assert.equal(seen.length, 2);
    assert.equal(seen[1].url, '/orders/42');
    // Production's token stayed behind; the environment's went instead.
    assert.equal(seen[1].auth, 'Bearer local-token');
    assert.match(frame(), /500 · 4211 ms/);
    assert.match(frame(), /- 500/);
    assert.match(frame(), /\+ 200/);
    assert.match(frame(), /Left out Authorization; Authorization from the environment instead/);
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Replayed GET'), 'the comparison closed');
    // By name, to an address typed, and from History's alt+r.
    await run(app, '/replay :1');
    await until(() => /Couldn't reach|failed|ECONNREFUSED|refused/i.test(frame()), 'a closed port said');
    app.stdin.write('4');
    await until(() => frame().includes('─ History'), 'History');
    app.stdin.write('\x1bR');
    await until(() => frame().includes('send it there and compare'), 'where to, from History');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('The same status, headers and body.'), 'the same answer');
    assert.equal(seen.length, 3);
  } finally {
    app.unmount();
  }
});
