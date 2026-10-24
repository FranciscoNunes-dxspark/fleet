// Local HTTPS: "https" read from bosun.json, the certificate made once with mkcert (stubbed), the
// proxy in front of a process (requests, a 502 when nothing answers, websockets through the
// upgrade), and a process served with it in the app. The certificate is test/fixtures', valid to 2126.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer as netServer } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { certFiles, ensureCert, httpsPort, httpsProblem, mkcertHint, startHttpsProxy } from '../src/https.js';
import { readSpec } from '../src/crew.js';
import { project, start, tempHome, until } from './helpers.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const key = readFileSync(join(FIXTURES, 'localhost-key.pem'));
const cert = readFileSync(join(FIXTURES, 'localhost.pem'));

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const freePort = () =>
  new Promise((done) => {
    const s = netServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

/** A request through TLS, trusting the fixture's certificate: { status, headers, body }. */
const get = (port, path = '/', { method = 'GET', body } = {}) =>
  new Promise((done, fail) => {
    const req = httpsRequest({ host: '127.0.0.1', servername: 'localhost', port, path, method, ca: cert }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (d) => (text += d));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', fail);
    req.end(body);
  });

test('"https": a port, or true for the one after its own; it needs a port', () => {
  assert.equal(httpsPort({ port: 3000, https: true }), 3001);
  assert.equal(httpsPort({ port: 3000, https: 4443 }), 4443);
  assert.equal(httpsPort({ port: 3000 }), null);
  assert.equal(httpsProblem({ https: 4443 }), '"https" passes on to its port, so it needs "port"');
  assert.equal(httpsProblem({ port: 3000, https: 'yes' }), '"https" is a port to serve it on with TLS, or true for the one after its own');
  assert.equal(httpsProblem({ port: 3000, https: 3000 }), '"https" needs a port of its own, not the one it listens on');
  assert.equal(httpsProblem({ port: 3000, https: true }), null);
  const read = readSpec({ procs: { api: { run: 'x', port: 3000, https: true }, bad: { run: 'y', https: 1 } } });
  assert.equal(read.procs[0].https, true);
  assert.deepEqual(read.problems, ['"bad": "https" passes on to its port, so it needs "port"']);
  assert.match(mkcertHint('win32'), /winget install FiloSottile.mkcert/);
  assert.match(mkcertHint('darwin'), /brew install mkcert/);
  assert.match(mkcertHint('linux'), /apt install mkcert/);
});

test('the certificate: made once with mkcert, asking before it installs its authority; read after; none without mkcert', async () => {
  const files = certFiles(join(mkdtempSync(join(tmpdir(), 'bosun-certs-')), 'certs'));
  const runs = [];
  const exec = async (file, args) => {
    runs.push([file, ...args]);
    if (args[0] === '-cert-file') {
      copyFileSync(join(FIXTURES, 'localhost.pem'), args[1]);
      copyFileSync(join(FIXTURES, 'localhost-key.pem'), args[3]);
    }
    return '';
  };
  assert.deepEqual(await ensureCert({ files, find: () => null, exec }), { missing: true });
  let asked = 0;
  const made = await ensureCert({ files, find: () => '/bin/mkcert', exec, ask: async () => (asked++, true) });
  assert.equal(asked, 1);
  assert.deepEqual(runs, [
    ['/bin/mkcert', '-install'],
    ['/bin/mkcert', '-cert-file', files.cert, '-key-file', files.key, 'localhost', '127.0.0.1', '::1'],
  ]);
  assert.ok(made.made && made.installed);
  assert.ok(made.cert.equals(cert));
  const again = await ensureCert({ files, find: () => '/bin/mkcert', exec, ask: async () => (asked++, true) });
  assert.ok(!again.made && again.key.equals(key));
  assert.equal(runs.length, 2, 'not made again');
  assert.equal(asked, 1, 'nor asked');
  // -install failing (no password to give it) still makes the certificate.
  const other = certFiles(join(mkdtempSync(join(tmpdir(), 'bosun-certs-')), 'certs'));
  const failing = await ensureCert({ files: other, find: () => 'mkcert', exec: async (f, args) => (args[0] === '-install' ? Promise.reject(new Error('sudo: a password is required')) : exec(f, args)), ask: async () => true });
  assert.equal(failing.installError, 'sudo: a password is required');
  assert.ok(existsSync(other.cert));
});

test('the proxy passes requests on with TLS ended, says when nothing answers, and carries websockets', async () => {
  const target = await freePort();
  const port = await freePort();
  const app = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('set-cookie', ['a=1', 'b=2']);
      res.end(JSON.stringify({ method: req.method, url: req.url, proto: req.headers['x-forwarded-proto'], host: req.headers['x-forwarded-host'], body }));
    });
  });
  // An upgrade it answers by echoing whatever comes after.
  app.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
    socket.pipe(socket);
  });
  await new Promise((r) => app.listen(target, '127.0.0.1', r));
  const proxy = await startHttpsProxy({ port, target, key, cert, targetHost: '127.0.0.1' });
  try {
    const r = await get(port, '/orders?x=1', { method: 'POST', body: 'hello' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { method: 'POST', url: '/orders?x=1', proto: 'https', host: `127.0.0.1:${port}`, body: 'hello' });
    assert.deepEqual(r.headers['set-cookie'], ['a=1', 'b=2']);

    const echoed = await new Promise((done, fail) => {
      const socket = tlsConnect({ host: '127.0.0.1', port, servername: 'localhost', ca: cert }, () => {
        socket.write(`GET /live HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n`);
      });
      let got = '';
      let sent = false;
      socket.setEncoding('utf8').on('data', (d) => {
        got += d;
        if (!sent && got.includes('\r\n\r\n')) {
          sent = true;
          assert.match(got, /^HTTP\/1.1 101/);
          got = '';
          socket.write('ping over tls');
        } else if (sent && got === 'ping over tls') {
          socket.end();
          done(got);
        }
      });
      socket.on('error', fail);
    });
    assert.equal(echoed, 'ping over tls');

    await new Promise((r) => app.close(r));
    app.closeAllConnections?.();
    const down = await get(port);
    assert.equal(down.status, 502);
    assert.match(down.body, new RegExp(`nothing answered on port ${target}`));
    await assert.rejects(startHttpsProxy({ port, target, key, cert }), /EADDRINUSE/);
  } finally {
    proxy.stop();
    app.close();
  }
});

const SERVER = `require('http').createServer((q, s) => s.end('hi from ' + q.headers['x-forwarded-proto'])).listen(+process.env.PORT, () => console.log('listening'));`;

test('a process with "https" is served with TLS while it runs; without mkcert, how to install it is said', async () => {
  const port = await freePort();
  const tls = await freePort();
  const dir = project({ procs: { api: { run: 'node server.js', port, https: tls, env: { PORT: String(port) } } } }, { 'server.js': SERVER });
  let made = 0;
  const app = start({ dir, ensureCert: async () => (made++, { key, cert, made: true }) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes(`https://localhost:${tls} passes on to :${port}`), 'served with TLS');
    assert.ok(frame().includes('Made a certificate for localhost'));
    await until(() => frame().includes(`:${port} ✓`), 'its own port answering, as before');
    let r;
    for (let i = 0; i < 50 && !r; i++) r = await get(tls).catch(() => new Promise((ok) => setTimeout(() => ok(null), 100)));
    assert.equal(r.body, 'hi from https');
    app.stdin.write('s');
    await until(() => /api\s+stopped/.test(frame()), 'stopped');
    await assert.rejects(get(tls), /ECONNREFUSED|ECONNRESET/);
    app.stdin.write('s');
    await until(() => frame().split(`https://localhost:${tls} passes on`).length === 3, 'served again');
    assert.equal(made, 1, 'the certificate made once');
  } finally {
    app.stdin.write('q');
    app.unmount();
  }
  const dir2 = project({ procs: { api: { run: 'node -e "setInterval(() => {}, 1000)"', port: await freePort(), https: true } } });
  const app2 = start({ dir: dir2, findTool: () => null });
  try {
    await until(() => (app2.lastFrame() ?? '').includes('Serving https needs mkcert on the PATH'), 'how to install mkcert');
  } finally {
    app2.stdin.write('q');
    app2.unmount();
  }
});
