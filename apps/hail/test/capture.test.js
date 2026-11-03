// Requests from logs: a log line (or a request) a sibling copied, saved as a named request in a .http
// file. The pure parts, and through the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeLine } from '@fleet/kit/family.js';
import { captureBlock, capturedAt, requestInLine, requestName, withVariable } from '../src/capture.js';
import { KEYS, start, tempHome, until } from './helpers.js';

test('a method and URL in a log line: plain text, access logs, structured JSON, with a status or a body', () => {
  assert.deepEqual(requestInLine('10:42:01 info POST /api/orders/42/pay 201 in 12 ms'), { method: 'POST', url: '/api/orders/42/pay', status: 201 });
  assert.deepEqual(requestInLine('127.0.0.1 - - [02/Nov/2026:10:00:00] "GET /health?full=1 HTTP/1.1" 200 2'), { method: 'GET', url: '/health?full=1', status: 200 });
  assert.deepEqual(requestInLine('Request starting HTTP/1.1 POST http://localhost:5000/orders application/json 9 {"id":1}'), { method: 'POST', url: 'http://localhost:5000/orders', body: { id: 1 } });
  assert.deepEqual(requestInLine('handled delete https://api.example.com/v1/users/7 status=500'), { method: 'DELETE', url: 'https://api.example.com/v1/users/7', status: 500 });
  assert.deepEqual(
    requestInLine('{"level":30,"req":{"method":"put","url":"/v1/users/7","headers":{"authorization":"Bearer abc"}},"res":{"statusCode":409}}'),
    { method: 'PUT', url: '/v1/users/7', status: 409, headers: { authorization: 'Bearer abc' } },
  );
  assert.equal(requestInLine('Connection refused to db on port 5432'), null);
  assert.equal(requestInLine('GET'), null);
  assert.equal(requestInLine(undefined), null);
});

test("the URL's origin as the environment's variable, the longest that fits; a path under its host", () => {
  const vars = { host: 'https://api.example.com', apiBase: 'https://api.example.com/v1/', token: 'abc', other: 'https://other' };
  assert.deepEqual(withVariable('https://api.example.com/v1/users?x=1', vars), { url: '{{apiBase}}/users?x=1', variable: 'apiBase' });
  assert.deepEqual(withVariable('https://api.example.com/health', vars), { url: '{{host}}/health', variable: 'host' });
  assert.deepEqual(withVariable('https://api.example.community/x', vars), { url: 'https://api.example.community/x', variable: null }, 'a longer host is another host');
  assert.deepEqual(withVariable('/orders', vars), { url: '{{host}}/orders', variable: 'host' });
  assert.deepEqual(withVariable('/orders', {}), { url: '/orders', variable: null });
  assert.equal(requestName('POST', '/api/orders/42/pay'), 'postApiOrdersPay');
  assert.equal(requestName('GET', 'https://x/users/3f2a9c1e-1111-2222-3333-444455556666/cart-items'), 'getUsersCartItems');
  assert.equal(requestName('GET', '/', ['get']), 'get2');
  assert.equal(capturedAt(undefined, Date.UTC(2026, 10, 2, 10, 0, 0, 123)), '2026-11-02T10:00:00Z');
  assert.equal(capturedAt('10:42:01'), '10:42:01');
});

test('the block: named, where it came from, no credential values, the body indented', () => {
  const seen = { method: 'PUT', url: 'https://api.example.com/v1/users/7', status: 500, headers: { Authorization: 'Bearer SECRET', 'X-Api-Key': 'KEY', Cookie: 'sid=1', Host: 'api', 'Content-Type': 'application/json', 'X-Trace': 'a' }, body: '{"name":"ana"}' };
  const c = captureBlock(seen, { vars: { host: 'https://api.example.com' }, taken: ['putV1Users'], from: 'api', at: '2026-11-02T10:00:00Z' });
  assert.equal(
    c.block,
    '### PUT /v1/users/7\n# from api at 2026-11-02T10:00:00Z, where it answered 500\n# @name putV1Users2\nPUT {{host}}/v1/users/7\nAuthorization: Bearer {{token}}\nX-Api-Key: {{token}}\nContent-Type: application/json\nX-Trace: a\n\n{\n  "name": "ana"\n}\n',
  );
  assert.ok(!/SECRET|KEY\b|sid=/.test(c.block));
  assert.deepEqual([c.name, c.variable, c.dropped, c.placeholders], ['putV1Users2', 'host', ['Cookie'], ['Authorization', 'X-Api-Key']]);
  // A JSON body without its Content-Type gets one.
  assert.match(captureBlock({ method: 'POST', url: '/x', body: { a: 1 } }).block, /^POST \/x\nContent-Type: application\/json\n\n\{/m);
});

let cleanup;
let dir;
let server;
const seen = [];
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-capture-'));
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(dir, 'http-client.env.json'), JSON.stringify({ local: { host } }));
  writeFileSync(join(dir, 'api.http'), '### Orders\nGET {{host}}/orders\n');
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

test('a log line with a request in it: saved to the open file or captured.http, named and picked, ready to send', async () => {
  const app = start({ initialFile: join(dir, 'api.http'), cwd: dir });
  const frame = () => app.lastFrame() ?? '';
  const host = `http://127.0.0.1:${server.address().port}`;
  try {
    await until(() => frame().includes('Orders'), 'the requests');
    await run(app, takeLine('logline', { process: 'api', time: '10:42:01', text: `POST ${host}/orders/42/pay 201 {"amount":5}` }));
    await until(() => frame().includes('as a request') && frame().includes('captured.http'), 'where to save it');
    assert.match(frame(), /api\.http +the open file/);
    assert.match(frame(), /captured\.http +a new file/);
    // The open file: through the editor, then picked.
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Saved postOrdersPay'), 'saved');
    const text = readFileSync(join(dir, 'api.http'), 'utf8');
    assert.match(text, /### POST \/orders\/42\/pay\n# from api at 10:42:01, where it answered 201\n# @name postOrdersPay\nPOST \{\{host\}\}\/orders\/42\/pay\nContent-Type: application\/json\n\n\{\n {2}"amount": 5\n\}\n$/);
    assert.match(frame(), /❯ POST +postOrdersPay/);
    app.stdin.write(KEYS.enter);
    await until(() => seen.some((s) => s.method === 'POST' && s.url === '/orders/42/pay'), 'sent');
    // Another to captured.http, made for it and opened.
    await run(app, takeLine('logline', { process: 'api', text: 'DELETE /orders/7 404' }));
    await until(() => frame().includes('Save DELETE /orders/7 (404)'), 'where to save it');
    app.stdin.write(KEYS.down);
    await new Promise((r) => setTimeout(r, 100));
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('to captured.http') && frame().includes('captured.http'), 'saved and opened');
    assert.ok(existsSync(join(dir, 'captured.http')));
    assert.match(readFileSync(join(dir, 'captured.http'), 'utf8'), /^### DELETE \/orders\/7\n# from api at .+, where it answered 404\n# @name deleteOrders\nDELETE \{\{host\}\}\/orders\/7\n$/);
    assert.match(frame(), /❯ DELETE +deleteOrders/);
  } finally {
    app.unmount();
  }
});

test("a request taken from Sonar can be saved as a named request too, its token left behind", async () => {
  writeFileSync(join(dir, 'other.http'), '### Health\nGET {{host}}/health\n');
  const app = start({ initialFile: join(dir, 'other.http'), cwd: dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Health'), 'the requests');
    await run(app, takeLine('request', { method: 'GET', url: 'https://prod.example.com/orders/42', headers: { Authorization: 'Bearer PROD' }, app: 'shop-api', response: { status: 500 } }));
    await until(() => frame().includes('Save it as a named request'), 'the question');
    for (let i = 0; i < 3; i++) {
      app.stdin.write(KEYS.down);
      await new Promise((r) => setTimeout(r, 60));
    }
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Save GET https://prod.example.com/orders/42 (500) as a request'), 'where to');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Saved getOrders'), 'saved');
    const text = readFileSync(join(dir, 'other.http'), 'utf8');
    assert.match(text, /# from shop-api at .+, where it answered 500\n# @name getOrders\nGET https:\/\/prod\.example\.com\/orders\/42\nAuthorization: Bearer \{\{token\}\}\n$/);
    assert.ok(!text.includes('PROD'));
  } finally {
    app.unmount();
  }
});
