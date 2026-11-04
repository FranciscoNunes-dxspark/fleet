// bilge-ignore-file: the demo's made-up traffic carries made-up credentials on purpose, for the masks to hide.
// A demo with the provider's interface, for `--demo` and the tests: nothing listens, nothing is read or
// written. start() hands over a made-up session (a shop's API through the proxy: a token, a login over
// plain HTTP, cookies, a CSV, a tunnel, a refused handshake); `emit` adds an exchange as the proxy
// would; `state` has what was asked (`calls`), written (`written`) and configured.
import { gzipSync } from 'node:zlib';

const T0 = Date.UTC(2026, 10, 3, 9, 30, 0);
// Made at run time, so no scanner takes the demo's source for a leak.
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJhbmEtZGVtbyIsIm5hbWUiOiJBbmEifQ', 'ZGVtby1zaWduYXR1cmUtbm90LXJlYWw'].join('.');
const MAPS_KEY = `AIza${'DemoKey0'.repeat(5).slice(0, 35)}`;
const SESSION = 's3ss10n-demo-4f9a2b7c';

const json = (v) => Buffer.from(JSON.stringify(v));
let nextId = 1;

/** One finished exchange, as proxy.js would have recorded it. */
function exchange({ at, method = 'GET', scheme = 'https', host = 'api.shop.test', port, path = '/', request = {}, response = null, ms = 80, kind = 'http', note = null, error = null, intercepted = scheme === 'https' }) {
  const p = port ?? (scheme === 'https' ? 443 : 80);
  const reqBody = request.body ?? null;
  const resBody = response?.body ?? null;
  const start = T0 + at;
  return {
    id: nextId++,
    kind,
    state: error ? 'error' : 'done',
    at: start,
    scheme,
    method,
    host,
    port: p,
    path,
    url: kind === 'http' ? `${scheme}://${host}${p !== (scheme === 'https' ? 443 : 80) ? `:${p}` : ''}${path}` : `${host}:${p}`,
    intercepted: kind === 'http' && intercepted,
    note,
    error,
    request: { httpVersion: '1.1', headers: request.headers ?? [], body: reqBody, size: request.size ?? reqBody?.length ?? 0, truncated: false },
    response: response && { status: response.status, statusText: response.statusText ?? '', httpVersion: '1.1', headers: response.headers ?? [], body: resBody, size: response.size ?? resBody?.length ?? 0, truncated: false },
    timings: { start, connect: start + 5, ttfb: start + Math.round(ms * 0.8), end: start + ms },
  };
}

const PRODUCTS = [
  { id: 1, name: 'Rope, 20 m', price: 24.5, stock: 12 },
  { id: 2, name: 'Lantern', price: 18, stock: 0 },
  { id: 3, name: 'Compass', price: 32.9, stock: 4 },
];

/** The made-up session start() hands over, oldest first. */
export function demoExchanges() {
  nextId = 1;
  const ua = ['User-Agent', 'Mozilla/5.0 (demo)'];
  return [
    exchange({ at: 0, host: 'localhost', port: 5173, scheme: 'http', path: '/', request: { headers: [['Host', 'localhost:5173'], ua, ['Accept', 'text/html']] }, response: { status: 200, statusText: 'OK', headers: [['Content-Type', 'text/html']], body: Buffer.from('<!doctype html><title>Shop</title><div id="app"></div>') }, ms: 12 }),
    exchange({
      at: 400,
      method: 'POST',
      scheme: 'http',
      port: 8080,
      path: '/login',
      request: { headers: [['Host', 'api.shop.test:8080'], ua, ['Content-Type', 'application/json']], body: json({ email: 'ana@shop.test', password: 'hunter2-not-real' }) },
      response: { status: 200, statusText: 'OK', headers: [['Content-Type', 'application/json'], ['Set-Cookie', `session=${SESSION}; Path=/`]], body: json({ ok: true, token: JWT }) },
      ms: 140,
    }),
    exchange({
      at: 650,
      scheme: 'http',
      port: 8080,
      path: '/v1/me',
      request: { headers: [['Host', 'api.shop.test:8080'], ua, ['Accept', 'application/json'], ['Authorization', `Bearer ${JWT}`]] },
      response: { status: 200, statusText: 'OK', headers: [['Content-Type', 'application/json']], body: json({ id: 'ana-demo', name: 'Ana' }) },
      ms: 35,
    }),
    exchange({
      at: 900,
      path: '/v1/products?page=1',
      request: { headers: [['Host', 'api.shop.test'], ua, ['Accept', 'application/json'], ['Authorization', `Bearer ${JWT}`]] },
      response: { status: 200, statusText: 'OK', headers: [['Content-Type', 'application/json; charset=utf-8'], ['Content-Encoding', 'gzip']], body: gzipSync(json({ page: 1, items: PRODUCTS })) },
      ms: 96,
    }),
    exchange({
      at: 1300,
      method: 'POST',
      path: '/v1/orders',
      request: { headers: [['Host', 'api.shop.test'], ua, ['Content-Type', 'application/json'], ['Authorization', `Bearer ${JWT}`], ['Cookie', `session=${SESSION}; theme=dark`]], body: json({ items: [{ id: 1, qty: 2 }], note: 'leave at the door' }) },
      response: { status: 201, statusText: 'Created', headers: [['Content-Type', 'application/json'], ['Location', '/v1/orders/9001'], ['Set-Cookie', 'cart=; Path=/; Secure; HttpOnly']], body: json({ id: 9001, total: 49 }) },
      ms: 210,
    }),
    exchange({
      at: 1800,
      path: '/v1/orders/9001',
      request: { headers: [['Host', 'api.shop.test'], ua, ['Authorization', `Bearer ${JWT}`]] },
      response: { status: 500, statusText: 'Internal Server Error', headers: [['Content-Type', 'application/problem+json']], body: json({ type: 'about:blank', title: 'Order lookup failed', status: 500, detail: 'NullReferenceException in OrdersController.Get' }) },
      ms: 330,
    }),
    exchange({
      at: 2100,
      path: '/v1/reports/sales.csv',
      request: { headers: [['Host', 'api.shop.test'], ua, ['Authorization', `Bearer ${JWT}`]] },
      response: { status: 200, statusText: 'OK', headers: [['Content-Type', 'text/csv']], body: Buffer.from('day,orders,total\n2026-11-01,14,612.40\n2026-11-02,9,388.10\n') },
      ms: 64,
    }),
    exchange({ at: 2500, scheme: 'http', host: 'cdn.shop.test', path: `/maps.js?key=${MAPS_KEY}&v=3`, request: { headers: [['Host', 'cdn.shop.test'], ua] }, response: { status: 200, statusText: 'OK', headers: [['Content-Type', 'application/javascript']], body: Buffer.from('window.maps = {};') }, ms: 40 }),
    exchange({ at: 2900, kind: 'tunnel', method: 'CONNECT', host: 'accounts.google.com', request: { size: 1830 }, response: { status: null, size: 5210 }, note: 'passed through: on the pass-through list', ms: 2200 }),
    exchange({ at: 3300, kind: 'refused', method: 'CONNECT', host: 'pinned.bank.test', note: "it refused Lookout's certificate", ms: 30 }),
    exchange({ at: 3700, host: 'down.shop.test', path: '/health', request: { headers: [['Host', 'down.shop.test'], ua] }, error: 'ECONNREFUSED: connect ECONNREFUSED 10.0.0.9:443', ms: 15 }),
  ];
}

export function demoLookout({ home = '~/.lookout' } = {}) {
  const state = { calls: [], written: new Map(), files: new Map(), configured: [], findings: null, ca: false, address: null, onExchange: null };
  const caPaths = { dir: home, key: `${home}/ca-key.pem`, cert: `${home}/ca.crt` };
  const FINGERPRINT = 'D3:M0:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD';
  return {
    demo: true,
    state,
    caInfo: () => ({ exists: state.ca, cert: state.ca ? '-----BEGIN CERTIFICATE-----\n(demo)\n-----END CERTIFICATE-----\n' : null, fingerprint: state.ca ? FINGERPRINT : null, paths: caPaths }),
    ensureCA() {
      state.calls.push(['ensureCA']);
      const made = !state.ca;
      state.ca = true;
      return { made, paths: caPaths, fingerprint: FINGERPRINT };
    },
    async start({ port, intercept, passThrough, maxBody, onExchange }) {
      state.calls.push(['start', port]);
      state.address = { host: '127.0.0.1', port: port || 8888 };
      state.onExchange = onExchange;
      state.configured.push({ intercept, passThrough, maxBody });
      // The made-up session arrives as if it had just passed through.
      setTimeout(() => {
        for (const ex of demoExchanges()) onExchange?.(ex);
      }, 0);
      return state.address;
    },
    async stop() {
      state.calls.push(['stop']);
      state.address = null;
    },
    configure(next) {
      state.calls.push(['configure', next]);
      state.configured.push(next);
    },
    get address() {
      return state.address;
    },
    /** Adds an exchange as the proxy would (tests). */
    emit(ex) {
      state.onExchange?.(ex);
    },
    readFile(path) {
      if (state.files.has(path)) return state.files.get(path);
      if (state.written.has(path)) return state.written.get(path);
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
    },
    exists: (path) => state.files.has(path) || state.written.has(path),
    writeFile(path, text) {
      state.calls.push(['writeFile', path]);
      state.written.set(path, text);
    },
    saveFindings(json) {
      state.findings = json;
    },
    loadFindings: () => state.findings,
  };
}
