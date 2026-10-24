// Local HTTPS: a process with "https" in bosun.json is served at https://localhost:<that port> too,
// Bosun ending TLS there and passing everything on to the process's own port (websockets included,
// through the upgrade). The certificate is mkcert's, made once into ~/.bosun/certs; Node can't make
// one by itself, so without mkcert Bosun says how to install it. `httpsPort` and the install hint are
// pure; `ensureCert` takes the program finder, runner and question; `startHttpsProxy` is the server.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import { join } from 'node:path';
import { configDir } from './config.js';
import { findOnPath } from './which.js';

/** The port a process is served on with TLS: "https": 4443, or true for the one after its port; null without. */
export function httpsPort(spec) {
  if (spec?.https === true) return spec.port ? spec.port + 1 : null;
  return Number.isInteger(spec?.https) ? spec.https : null;
}

/** What's wrong with a process's "https", or null: a port (1 to 65535, not its own) or true, and it needs "port". */
export function httpsProblem(proc) {
  const v = proc?.https;
  if (v == null || v === false) return null;
  if (v !== true && !(Number.isInteger(v) && v > 0 && v < 65536)) return '"https" is a port to serve it on with TLS, or true for the one after its own';
  if (proc.port == null) return '"https" passes on to its port, so it needs "port"';
  if (httpsPort(proc) === proc.port) return '"https" needs a port of its own, not the one it listens on';
  return null;
}

/** Where the certificate for localhost is kept. */
export const certFiles = (dir = join(configDir(), 'certs')) => ({ dir, cert: join(dir, 'localhost.pem'), key: join(dir, 'localhost-key.pem') });

/** How to install mkcert, for this platform. */
export function mkcertHint(platform = process.platform) {
  const how = { win32: 'winget install FiloSottile.mkcert (or choco install mkcert)', darwin: 'brew install mkcert' }[platform] ?? 'your package manager (apt install mkcert, dnf install mkcert…) or https://github.com/FiloSottile/mkcert#installation';
  return `Serving https needs mkcert on the PATH, to make a certificate for localhost: ${how}. Then /reload, or restart the process.`;
}

const runFile = (file, args) => new Promise((done, fail) => execFile(file, args, { windowsHide: true, timeout: 60_000 }, (e, stdout, stderr) => (e ? fail(new Error(String(stderr || e.message).trim())) : done(stdout))));

/**
 * The certificate for localhost: read from `files` when it's there, else made with mkcert, after
 * `ask()` says whether to run `mkcert -install` first (its authority in this machine's trust stores,
 * so browsers trust it). Resolves { key, cert, made, installed }, or { missing: true } without
 * mkcert; `installError` when -install failed (the certificate is made all the same).
 */
export async function ensureCert({ files = certFiles(), find = findOnPath, exec = runFile, ask = async () => false } = {}) {
  const read = () => ({ key: readFileSync(files.key), cert: readFileSync(files.cert) });
  if (existsSync(files.key) && existsSync(files.cert)) return read();
  const mkcert = find('mkcert');
  if (!mkcert) return { missing: true };
  let installed = false;
  let installError = null;
  if (await ask()) {
    try {
      await exec(mkcert, ['-install']);
      installed = true;
    } catch (e) {
      installError = e.message;
    }
  }
  mkdirSync(files.dir, { recursive: true });
  await exec(mkcert, ['-cert-file', files.cert, '-key-file', files.key, 'localhost', '127.0.0.1', '::1']);
  return { ...read(), made: true, installed, installError };
}

const hopByHop = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);

/**
 * Serves TLS on `port` (on 127.0.0.1) with `key` and `cert`, passing each request on to `target` on
 * localhost (X-Forwarded-Proto https, X-Forwarded-Host and -For set) and websockets through the
 * upgrade. Resolves the server once it listens (rejects when it can't: the port taken); its
 * `stop()` closes it and every connection through it.
 */
export function startHttpsProxy({ port, target, key, cert, host = '127.0.0.1', targetHost = 'localhost' }) {
  const sockets = new Set();
  const server = createServer({ key, cert }, (req, res) => {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!hopByHop.has(k)) headers[k] = v;
    Object.assign(headers, { 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host ?? `localhost:${port}`, 'x-forwarded-for': req.socket.remoteAddress ?? '' });
    const up = request({ host: targetHost, port: target, method: req.method, path: req.url, headers }, (back) => {
      const raw = [];
      for (let i = 0; i < back.rawHeaders.length; i += 2) if (!hopByHop.has(back.rawHeaders[i].toLowerCase())) raw.push(back.rawHeaders[i], back.rawHeaders[i + 1]);
      res.writeHead(back.statusCode, back.statusMessage, raw);
      back.pipe(res);
    });
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Bosun: nothing answered on port ${target} (${e.code ?? e.message}).\n`);
    });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    const up = connect({ host: targetHost, port: target }, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      lines.push('X-Forwarded-Proto: https');
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    sockets.add(socket);
    sockets.add(up);
    const done = () => {
      sockets.delete(socket);
      sockets.delete(up);
      socket.destroy();
      up.destroy();
    };
    up.on('error', done);
    socket.on('error', done);
    up.on('close', done);
    socket.on('close', done);
  });
  server.on('tlsClientError', () => {});
  server.stop = () => {
    server.close();
    server.closeAllConnections?.();
    for (const s of sockets) s.destroy();
  };
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      server.on('error', () => {});
      done(server);
    });
  });
}
