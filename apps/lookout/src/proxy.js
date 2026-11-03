// The proxy itself: an HTTP/1.1 proxy on 127.0.0.1 that forwards what it's sent with node:http and
// node:https and records each exchange as it goes (exchange.js has their shape). Plain HTTP is
// recorded as it passes. A CONNECT (HTTPS) is a tunnel recorded by its host alone, unless interception
// is on: then the client's TLS is answered with a certificate for the host signed by Lookout's CA
// (store.js's certCache), HTTP/1.1 only (ALPN; a client that wants nothing but HTTP/2 is refused),
// and each request inside is forwarded and recorded like a plain one. A host in the pass-through list
// is always tunnelled untouched, for clients that pin their certificates. Bodies are streamed; at most
// `maxBody` bytes of each are kept.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { certHost } from './certs.js';

export const DEFAULT_PORT = 8888;
export const LISTEN_HOST = '127.0.0.1';
export const DEFAULT_MAX_BODY = 1024 * 1024;

// Headers about one hop, not the request: never passed on (RFC 9110 7.6.1), and the proxy's own.
const HOP = new Set(['connection', 'proxy-connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
// A client that closes an intercepted connection this soon after it opened, without a request, has
// most likely turned the certificate down (Node's clients do it after the handshake, without an alert).
const REFUSED_WITHIN = 1500;

/** Whether `host` is in `patterns` (exact names, or *.example.com for it and every name under it). */
export function matchesHost(patterns = [], host = '') {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return patterns.some((p) => {
    const q = String(p).toLowerCase().trim();
    if (q.startsWith('*.')) return h === q.slice(2) || h.endsWith(q.slice(1));
    return h === q;
  });
}

/** "host:port" (or "[::1]:443") as { host, port }, the port `fallback` when it isn't given. */
export function splitHostPort(text, fallback) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(text) ?? /^([^:]+)(?::(\d+))?$/.exec(text);
  if (!m) return { host: null, port: fallback };
  return { host: m[1].toLowerCase(), port: m[2] ? Number(m[2]) : fallback };
}

/** Raw headers ([name, value, name, value…]) as pairs. */
export const pairsOf = (raw) => {
  const out = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i], raw[i + 1]]);
  return out;
};

/** Pairs as the object node:http sends, without the hop-by-hop ones; repeated names as lists, Cookie joined. */
export function headerObject(pairs, { drop = HOP } = {}) {
  const out = {};
  const named = new Map();
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (drop.has(lower)) continue;
    const key = named.get(lower) ?? name;
    named.set(lower, key);
    if (!(key in out)) out[key] = value;
    else if (lower === 'cookie') out[key] = `${out[key]}; ${value}`;
    else out[key] = [].concat(out[key], value);
  }
  return out;
}

const defaultPort = (scheme) => (scheme === 'https' ? 443 : 80);
const hostPart = (host) => (host.includes(':') ? `[${host}]` : host);
/** The URL of a request, the port left out when it's the scheme's own. */
export const urlOf = ({ scheme, host, port, path }) => `${scheme}://${hostPart(host)}${port && port !== defaultPort(scheme) ? `:${port}` : ''}${path ?? ''}`;

/**
 * `socket` as a stream of its own that starts with what was read from it and put back (unshift): a
 * TLS socket wrapping a plain one reads it below the stream in some runtimes, missing those bytes.
 */
function replayed(socket) {
  const held = [];
  for (let c = socket.read(); c; c = socket.read()) held.push(c);
  const d = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, encoding, done) {
      socket.write(chunk, done);
    },
    final(done) {
      socket.end();
      done();
    },
    destroy(error, done) {
      socket.destroy();
      done(error);
    },
  });
  for (const c of held) d.push(c);
  socket.on('data', (c) => {
    if (!d.push(c)) socket.pause();
  });
  socket.on('end', () => d.push(null));
  socket.on('error', (e) => d.destroy(e));
  socket.on('close', () => d.destroy());
  return d;
}

/** Why a TLS error ended an intercepted connection, in words. */
function refusalReason(error) {
  const code = String(error?.code ?? error?.message ?? '');
  if (/NO_APPLICATION_PROTOCOL/i.test(code)) return 'it asked for HTTP/2 only, which Lookout doesn\'t speak';
  if (/UNKNOWN_CA|BAD_CERTIFICATE|CERTIFICATE_UNKNOWN|UNSUPPORTED_CERTIFICATE|ACCESS_DENIED|DECRYPT_ERROR/i.test(code)) return 'it refused Lookout\'s certificate';
  if (/WRONG_VERSION|HTTP_REQUEST|UNKNOWN_PROTOCOL|VERSION_TOO_LOW|NO_SHARED_CIPHER|NO_PROTOCOLS/i.test(code)) return `the handshake failed (${code})`;
  return null;
}

/**
 * A proxy, not yet listening. `certs` (store.js's certCache) is needed for interception; `upstreamCa`
 * adds a CA the forwarded HTTPS requests trust beside the usual ones (the tests' origin). Every change
 * to an exchange is handed to `onExchange(exchange)`, the same object each time.
 */
export function createProxy({ certs = null, intercept = false, passThrough = [], maxBody = DEFAULT_MAX_BODY, upstreamCa = null, onExchange = () => {}, now = Date.now } = {}) {
  const opts = { intercept, passThrough, maxBody, paused: false, certs };
  let nextId = 1;
  const sockets = new Set();
  // What each intercepted TLS socket is a tunnel to: { host, port, requests }.
  const targets = new WeakMap();
  const ca = upstreamCa ? [...tls.rootCertificates, ...[].concat(upstreamCa)] : undefined;
  const agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true, ...(ca ? { ca } : {}) }) };
  let address = null;

  const emit = (ex) => {
    if (ex.recorded) onExchange(ex);
  };

  /** A new exchange (recorded unless capture is paused). */
  function begin({ kind = 'http', scheme, method, host, port, path = '', intercepted = false, headers = [], httpVersion = '1.1', note = null }) {
    const at = now();
    const ex = {
      id: nextId++,
      kind,
      state: 'open',
      at,
      scheme,
      method,
      host,
      port,
      path,
      url: kind === 'http' ? urlOf({ scheme, host, port, path }) : `${hostPart(host)}:${port}`,
      intercepted,
      request: { httpVersion, headers, body: null, size: 0, truncated: false },
      response: null,
      timings: { start: at, connect: null, ttfb: null, end: null },
      error: null,
      note,
      recorded: !opts.paused,
    };
    emit(ex);
    return ex;
  }

  const finish = (ex, error) => {
    if (ex.state !== 'open') return;
    ex.state = error ? 'error' : 'done';
    if (error) ex.error = error.code ? `${error.code}: ${error.message}`.replace(/^(\w+): \1\b:?\s*/, '$1: ') : String(error.message ?? error);
    ex.timings.end = now();
    emit(ex);
  };

  /** Keeps up to maxBody bytes of what `stream` carries in `part`, counting all of it; `done` at its end. */
  function tap(stream, part, done) {
    const max = opts.maxBody;
    const chunks = [];
    let kept = 0;
    stream.on('data', (c) => {
      part.size += c.length;
      if (kept < max) {
        const piece = c.length > max - kept ? c.subarray(0, max - kept) : c;
        chunks.push(piece);
        kept += piece.length;
      }
      if (part.size > max) part.truncated = true;
    });
    stream.on('end', () => {
      part.body = Buffer.concat(chunks);
      done?.();
    });
  }

  /** A request forwarded to `target` ({ scheme, host, port, path, intercepted }) and its response passed back. */
  function forward(req, res, target) {
    const { scheme, host, port, path } = target;
    const pairs = pairsOf(req.rawHeaders);
    const ex = begin({ ...target, method: req.method, headers: pairs, httpVersion: req.httpVersion });
    const headers = headerObject(pairs);
    if (!pairs.some(([n]) => n.toLowerCase() === 'host')) headers.Host = `${hostPart(host)}${port !== defaultPort(scheme) ? `:${port}` : ''}`;
    const lib = scheme === 'https' ? https : http;
    let up;
    try {
      up = lib.request({ host, port, method: req.method, path, headers, agent: agents[scheme], ...(scheme === 'https' && !net.isIP(host) ? { servername: host } : {}) });
    } catch (e) {
      finish(ex, e);
      res.writeHead(400, { 'content-type': 'text/plain' }).end(`Lookout couldn't send that: ${e.message}\n`);
      return;
    }
    up.on('socket', (s) => {
      if (s.connecting) s.once(scheme === 'https' ? 'secureConnect' : 'connect', () => (ex.timings.connect = now()));
      else ex.timings.connect = ex.timings.start;
    });
    tap(req, ex.request, () => emit(ex));
    req.pipe(up);
    up.on('response', (ur) => {
      ex.timings.ttfb = now();
      const resPairs = pairsOf(ur.rawHeaders);
      ex.response = { status: ur.statusCode, statusText: ur.statusMessage ?? '', httpVersion: ur.httpVersion, headers: resPairs, body: null, size: 0, truncated: false };
      emit(ex);
      try {
        res.writeHead(ur.statusCode, ur.statusMessage, headerObject(resPairs));
      } catch (e) {
        res.destroy();
        return finish(ex, e);
      }
      tap(ur, ex.response, () => finish(ex));
      ur.pipe(res);
      ur.on('error', (e) => finish(ex, e));
    });
    up.on('error', (e) => {
      finish(ex, e);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain', connection: 'close' }).end(`Lookout couldn't reach ${hostPart(host)}:${port}: ${e.code ?? e.message}\n`);
      else res.destroy();
    });
    res.on('close', () => {
      if (!res.writableFinished) {
        up.destroy();
        finish(ex, new Error('The client went away before the response ended.'));
      }
    });
  }

  /** What the proxy answers for itself: a request that wasn't for another server (or was for http://lookout/). */
  function serveSelf(req, res) {
    if (/^\/ca\.(crt|pem)$/.test(new URL(req.url, 'http://lookout').pathname) && opts.certs) {
      return res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="lookout-ca.crt"' }).end(opts.certs.ca.cert);
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(`This is Lookout, a proxy that records what passes through it.\nSet HTTP_PROXY and HTTPS_PROXY to http://${LISTEN_HOST}:${address?.port ?? DEFAULT_PORT}.${opts.certs ? '\nIts certificate authority: http://lookout/ca.crt' : ''}\n`);
  }

  const isSelf = (host, port) => host === 'lookout' || ((host === LISTEN_HOST || host === 'localhost') && port === address?.port);

  /** A plain proxy request (absolute URL), or one for the proxy itself. */
  function onRequest(req, res) {
    let u;
    try {
      u = new URL(req.url);
    } catch {
      return serveSelf(req, res);
    }
    const scheme = u.protocol === 'https:' ? 'https' : u.protocol === 'http:' ? 'http' : null;
    if (!scheme) return res.writeHead(400, { 'content-type': 'text/plain' }).end('Lookout forwards http:// and https:// only.\n');
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = Number(u.port) || defaultPort(scheme);
    if (isSelf(host, port)) return serveSelf(req, res);
    forward(req, res, { scheme, host, port, path: `${u.pathname}${u.search}`, intercepted: false });
  }

  /** A WebSocket (or any Upgrade) handed through as bytes once its request is recorded: frames aren't. */
  function onUpgrade(req, socket, head, target) {
    const pairs = pairsOf(req.rawHeaders);
    const ex = begin({ ...target, method: req.method, headers: pairs, httpVersion: req.httpVersion, note: 'upgraded: what passes after the handshake isn\'t recorded' });
    socket.on('error', () => {});
    const up = target.scheme === 'https' ? tls.connect({ host: target.host, port: target.port, servername: net.isIP(target.host) ? undefined : target.host, ...(ca ? { ca } : {}), ALPNProtocols: ['http/1.1'] }) : net.connect(target.port, target.host);
    up.once(target.scheme === 'https' ? 'secureConnect' : 'connect', () => {
      ex.timings.connect = now();
      const lines = [`${req.method} ${target.path} HTTP/1.1`, ...pairs.filter(([n]) => !/^(proxy-connection|proxy-authorization)$/i.test(n)).map(([n, v]) => `${n}: ${v}`), '', ''];
      up.write(lines.join('\r\n'));
      if (head?.length) up.write(head);
      up.once('data', (c) => {
        ex.timings.ttfb = now();
        const status = /^HTTP\/1\.[01] (\d{3})\s*([^\r\n]*)/.exec(c.toString('latin1'));
        if (status) ex.response = { status: Number(status[1]), statusText: status[2], httpVersion: '1.1', headers: [], body: null, size: c.length, truncated: false };
        emit(ex);
      });
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', (e) => {
      finish(ex, e);
      socket.destroy();
    });
    socket.on('close', () => {
      up.destroy();
      finish(ex);
    });
  }

  /** A CONNECT passed through untouched: only its host, its bytes each way and how long it lasted. */
  function tunnel(client, host, port, note) {
    const ex = begin({ kind: 'tunnel', scheme: 'https', method: 'CONNECT', host, port, note });
    ex.response = { status: null, statusText: '', httpVersion: '1.1', headers: [], body: null, size: 0, truncated: false };
    const up = net.connect(port, host);
    up.on('connect', () => {
      ex.timings.connect = now();
      emit(ex);
      client.pipe(up);
      up.pipe(client);
      client.resume();
    });
    client.on('data', (c) => (ex.request.size += c.length));
    up.on('data', (c) => (ex.response.size += c.length));
    up.on('error', (e) => {
      finish(ex, e);
      client.destroy();
    });
    client.on('error', () => up.destroy());
    client.on('close', () => {
      up.destroy();
      finish(ex);
    });
    up.on('close', () => client.destroy());
  }

  /**
   * A CONNECT answered with Lookout's certificate for `host`: the requests inside go to the inner
   * server, which forwards them. A client that turns the certificate down (pinning, or the CA not
   * trusted) shows as a row of its own, to pass the host through.
   */
  function interceptTls(client, host, port) {
    let context;
    try {
      context = opts.certs.contextFor(host);
    } catch {
      return tunnel(client, host, port, 'passed through: no certificate can name this host');
    }
    const started = now();
    const ts = new tls.TLSSocket(replayed(client), { isServer: true, secureContext: context, ALPNProtocols: ['http/1.1'] });
    const target = { host, port, requests: 0 };
    targets.set(ts, target);
    sockets.add(ts);
    let failure = null;
    ts.on('error', (e) => {
      failure ??= e;
      ts.destroy();
    });
    ts.on('close', () => {
      sockets.delete(ts);
      client.destroy();
      if (target.requests) return;
      const reason = refusalReason(failure) ?? (now() - started < REFUSED_WITHIN ? 'it closed the connection right after the handshake: most likely it refused Lookout\'s certificate (a pinned certificate, or the CA isn\'t trusted)' : null);
      if (!reason) return;
      const ex = begin({ kind: 'refused', scheme: 'https', method: 'CONNECT', host, port, note: reason, intercepted: true });
      finish(ex, null);
    });
    inner.emit('connection', ts);
  }

  const inner = http.createServer();
  inner.on('request', (req, res) => {
    const target = targets.get(req.socket);
    if (!target) return res.writeHead(500).end();
    target.requests++;
    forward(req, res, { scheme: 'https', host: target.host, port: target.port, path: req.url, intercepted: true });
  });
  inner.on('upgrade', (req, socket, head) => {
    const target = targets.get(socket);
    if (!target) return socket.destroy();
    target.requests++;
    onUpgrade(req, socket, head, { scheme: 'https', host: target.host, port: target.port, path: req.url, intercepted: true });
  });
  inner.on('clientError', (e, socket) => socket.destroy());

  const server = http.createServer(onRequest);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('clientError', (e, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  server.on('upgrade', (req, socket, head) => {
    let u;
    try {
      u = new URL(req.url);
    } catch {
      return socket.destroy();
    }
    const scheme = u.protocol === 'https:' || u.protocol === 'wss:' ? 'https' : 'http';
    onUpgrade(req, socket, head, { scheme, host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || defaultPort(scheme), path: `${u.pathname}${u.search}`, intercepted: false });
  });
  server.on('connect', (req, client, head) => {
    const { host, port } = splitHostPort(req.url, 443);
    client.on('error', () => {});
    if (!host) return client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: Lookout\r\n\r\n');
    // The client's first bytes say what the tunnel carries: 0x16 starts a TLS handshake.
    const decide = (first) => {
      client.pause();
      client.unshift(first);
      const hello = first[0] === 0x16;
      if (!hello) return tunnel(client, host, port, 'passed through: not TLS');
      if (matchesHost(opts.passThrough, host)) return tunnel(client, host, port, 'passed through: on the pass-through list');
      if (!opts.intercept || !opts.certs) return tunnel(client, host, port, null);
      if (!certHost(host)) return tunnel(client, host, port, 'passed through: no certificate can name this host');
      interceptTls(client, host, port);
    };
    if (head?.length) decide(head);
    else client.once('data', decide);
  });

  return {
    /** Starts listening on 127.0.0.1 (`port` 0 for any free one); resolves { host, port }. */
    listen(port = DEFAULT_PORT) {
      return new Promise((done, fail) => {
        const onError = (e) => {
          server.off('listening', onListening);
          fail(e.code === 'EADDRINUSE' ? Object.assign(new Error(`Port ${port} is taken: /start <port> listens on another.`), { code: e.code }) : e);
        };
        const onListening = () => {
          server.off('error', onError);
          address = { host: LISTEN_HOST, port: server.address().port };
          done(address);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, LISTEN_HOST);
      });
    },
    /** Stops listening and closes every connection. */
    close() {
      return new Promise((done) => {
        for (const s of sockets) s.destroy();
        agents.http.destroy();
        agents.https.destroy();
        if (!server.listening) return done();
        server.close(() => done());
        address = null;
      });
    },
    /** Changes what it does from the next request: { intercept, passThrough, maxBody, paused, certs }. */
    configure(next) {
      Object.assign(opts, Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)));
    },
    get address() {
      return address;
    },
    get options() {
      return { ...opts };
    },
  };
}
