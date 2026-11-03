// bilge-ignore-file: the tests send made-up credentials on purpose.
// The proxy in-process on an ephemeral port, between real clients and local origin servers: plain
// HTTP, a CONNECT tunnel, HTTPS intercepted with a client trusting the generated CA, refused
// handshakes (an untrusting client, an HTTP/2-only one), the pass-through list, pausing, failures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProxy, headerObject, matchesHost, splitHostPort, urlOf } from '../src/proxy.js';
import { makeCA } from '../src/certs.js';
import { certCache } from '../src/store.js';
import { bodyText, decoded, header } from '../src/exchange.js';
import { eventually, handshake, origins, tunnelAgent, viaProxy, viaTunnel } from './helpers.js';

let origin;
let lookoutCa;
before(async () => {
  origin = await origins();
  lookoutCa = makeCA();
});
after(() => origin.close());

/** A proxy on a free port, its records in `seen` (each exchange once, as it stands now). */
async function proxy(opts = {}) {
  const seen = [];
  const p = createProxy({ certs: certCache(lookoutCa), upstreamCa: origin.ca.cert, onExchange: (ex) => !seen.includes(ex) && seen.push(ex), ...opts });
  const { port } = await p.listen(0);
  return { p, port, seen, done: () => seen.filter((ex) => ex.state !== 'open') };
}

test('the helpers: host patterns, CONNECT targets, header objects and URLs', () => {
  assert.ok(matchesHost(['*.bank.test'], 'pinned.bank.test'));
  assert.ok(matchesHost(['*.bank.test'], 'bank.test'));
  assert.ok(!matchesHost(['*.bank.test'], 'notbank.test'));
  assert.ok(matchesHost(['API.test'], 'api.test.'));
  assert.deepEqual(splitHostPort('example.com:8443', 443), { host: 'example.com', port: 8443 });
  assert.deepEqual(splitHostPort('[::1]:443', 443), { host: '::1', port: 443 });
  assert.deepEqual(
    headerObject([
      ['Host', 'a'],
      ['Proxy-Connection', 'keep-alive'],
      ['Cookie', 'a=1'],
      ['cookie', 'b=2'],
      ['Accept', 'x'],
      ['accept', 'y'],
    ]),
    { Host: 'a', Cookie: 'a=1; b=2', Accept: ['x', 'y'] },
  );
  assert.equal(urlOf({ scheme: 'https', host: '::1', port: 443, path: '/x' }), 'https://[::1]/x');
  assert.equal(urlOf({ scheme: 'http', host: 'a.test', port: 8080, path: '/' }), 'http://a.test:8080/');
});

test('plain HTTP is forwarded and recorded: method, URL, headers, both bodies, status, timings', async () => {
  const { p, port, done } = await proxy();
  try {
    const url = `http://127.0.0.1:${origin.http}/orders?page=2`;
    const r = await viaProxy(port, url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer abc.def.ghi', 'proxy-connection': 'keep-alive' }, body: '{"qty":2}' });
    assert.equal(r.status, 200);
    const echoed = JSON.parse(r.body);
    assert.equal(echoed.body, '{"qty":2}');
    assert.equal(echoed.headers.authorization, 'Bearer abc.def.ghi', 'the request goes on as it was');
    assert.equal(echoed.headers['proxy-connection'], undefined, "the proxy's own headers don't");
    await eventually(() => done().length === 1, 'the record');
    const [ex] = done();
    assert.equal(ex.kind, 'http');
    assert.equal(ex.method, 'POST');
    assert.equal(ex.url, url);
    assert.equal(ex.intercepted, false);
    assert.equal(ex.response.status, 200);
    assert.equal(header(ex.request.headers, 'Authorization'), 'Bearer abc.def.ghi');
    assert.equal(ex.request.body.toString(), '{"qty":2}');
    assert.equal(JSON.parse(bodyText(ex.response)).url, '/orders?page=2');
    assert.ok(ex.timings.end >= ex.timings.ttfb && ex.timings.ttfb >= ex.timings.start);
  } finally {
    await p.close();
  }
});

test('bodies are streamed whole but kept only up to maxBody; gzip is undone for showing', async () => {
  const { p, port, done } = await proxy({ maxBody: 1000 });
  try {
    const big = await viaProxy(port, `http://127.0.0.1:${origin.http}/big`);
    assert.equal(big.body.length, 1024 * 1024, 'the client gets all of it');
    await viaProxy(port, `http://127.0.0.1:${origin.http}/gzip`);
    await eventually(() => done().length === 2, 'the records');
    const [b, z] = done();
    assert.equal(b.response.size, 1024 * 1024);
    assert.equal(b.response.body.length, 1000);
    assert.equal(b.response.truncated, true);
    assert.deepEqual(JSON.parse(decoded(z.response).toString()), { zipped: true });
  } finally {
    await p.close();
  }
});

test('with interception off, HTTPS is a tunnel: the origin\'s own certificate, recorded by host and size', async () => {
  const { p, port, done } = await proxy({ intercept: false });
  try {
    const agent = tunnelAgent(port, { ca: origin.ca.cert });
    const r = await viaTunnel(agent, `https://localhost:${origin.https}/secret-path`);
    assert.equal(r.status, 200);
    assert.equal(r.socket.getPeerCertificate().issuer.CN, 'Lookout tests origin CA');
    await eventually(() => done().length === 1, 'the tunnel closing');
    const [ex] = done();
    assert.equal(ex.kind, 'tunnel');
    assert.equal(ex.method, 'CONNECT');
    assert.equal(ex.host, 'localhost');
    assert.equal(ex.port, origin.https);
    assert.ok(ex.request.size > 0 && ex.response.size > 0);
    assert.equal(ex.path, '', 'nothing inside the tunnel is seen');
  } finally {
    await p.close();
  }
});

test('with interception on, a client trusting Lookout\'s CA gets a certificate for the host and every request is recorded', async () => {
  const { p, port, done } = await proxy({ intercept: true });
  try {
    const agent = tunnelAgent(port, { ca: lookoutCa.cert, alpn: ['h2', 'http/1.1'] });
    const r = await viaTunnel(agent, `https://localhost:${origin.https}/api/me?x=1`, { method: 'PUT', headers: { authorization: 'Bearer s3cr3t-token', 'content-type': 'text/plain' }, body: 'hello' });
    assert.equal(r.status, 200);
    const peer = r.socket.getPeerCertificate();
    assert.equal(peer.issuer.CN, 'Lookout local CA');
    assert.equal(peer.subject.CN, 'localhost');
    assert.equal(r.socket.alpnProtocol, 'http/1.1', 'HTTP/1.1 is all it speaks');
    assert.equal(JSON.parse(r.body).body, 'hello', 'the origin got the request, over its own TLS');
    await eventually(() => done().some((ex) => ex.kind === 'http'), 'the record');
    const ex = done().find((x) => x.kind === 'http');
    assert.equal(ex.intercepted, true);
    assert.equal(ex.scheme, 'https');
    assert.equal(ex.url, `https://localhost:${origin.https}/api/me?x=1`);
    assert.equal(ex.method, 'PUT');
    assert.equal(ex.request.body.toString(), 'hello');
    assert.equal(header(ex.request.headers, 'authorization'), 'Bearer s3cr3t-token');
    assert.equal(ex.response.status, 200);
  } finally {
    await p.close();
  }
});

test('a client that refuses the certificate shows as a refused row; one that wants HTTP/2 only is refused in ALPN', async () => {
  const { p, port, done } = await proxy({ intercept: true });
  try {
    // Trusting the origin's CA, not Lookout's: Node's client turns the certificate down after the handshake.
    await assert.rejects(handshake(port, 'localhost', origin.https, { ca: origin.ca.cert }), /verify|self.signed|UNABLE/i);
    await eventually(() => done().some((ex) => ex.kind === 'refused'), 'the refused row');
    const refused = done().find((ex) => ex.kind === 'refused');
    assert.equal(refused.host, 'localhost');
    assert.match(refused.note, /refused Lookout's certificate/);
    await assert.rejects(handshake(port, 'localhost', origin.https, { ca: lookoutCa.cert, alpn: ['h2'] }), /APPLICATION_PROTOCOL|application protocol/i);
    await eventually(() => done().filter((ex) => ex.kind === 'refused').length === 2, 'the HTTP/2 row');
    assert.match(done().filter((ex) => ex.kind === 'refused')[1].note, /HTTP\/2/);
  } finally {
    await p.close();
  }
});

test('a host on the pass-through list is tunnelled untouched while interception is on', async () => {
  const { p, port, done } = await proxy({ intercept: true, passThrough: ['*.other.test'] });
  try {
    p.configure({ passThrough: ['localhost'] });
    const r = await viaTunnel(tunnelAgent(port, { ca: origin.ca.cert }), `https://localhost:${origin.https}/`);
    assert.equal(r.socket.getPeerCertificate().issuer.CN, 'Lookout tests origin CA');
    await eventually(() => done().length === 1, 'the tunnel');
    assert.equal(done()[0].kind, 'tunnel');
    assert.match(done()[0].note, /pass-through/);
  } finally {
    await p.close();
  }
});

test('paused, traffic passes and nothing is recorded; an unreachable server is a 502 and an error', async () => {
  const { p, port, seen, done } = await proxy();
  try {
    p.configure({ paused: true });
    const r = await viaProxy(port, `http://127.0.0.1:${origin.http}/`);
    assert.equal(r.status, 200);
    assert.equal(seen.length, 0);
    p.configure({ paused: false });
    const down = await viaProxy(port, 'http://127.0.0.1:1/');
    assert.equal(down.status, 502);
    assert.match(down.body, /couldn't reach 127\.0\.0\.1:1/);
    await eventually(() => done().length === 1, 'the error');
    assert.equal(done()[0].state, 'error');
    assert.match(done()[0].error, /ECONNREFUSED/);
  } finally {
    await p.close();
  }
});

test('asked for itself, the proxy says what it is and hands out the CA certificate, never the key', async () => {
  const { p, port, seen } = await proxy({ intercept: true });
  try {
    const page = await viaProxy(port, `http://127.0.0.1:${port}/`);
    assert.match(page.body, /This is Lookout/);
    const cert = await viaProxy(port, 'http://lookout/ca.crt');
    assert.equal(cert.body, lookoutCa.cert);
    assert.doesNotMatch(cert.body, /PRIVATE KEY/);
    assert.equal(seen.length, 0, 'not recorded');
  } finally {
    await p.close();
  }
});

test('it listens on 127.0.0.1 only, and says so when the port is taken', async () => {
  const { p, port } = await proxy();
  try {
    assert.equal(p.address.host, '127.0.0.1');
    const other = createProxy();
    await assert.rejects(other.listen(port), /Port \d+ is taken/);
  } finally {
    await p.close();
  }
});
