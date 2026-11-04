// bilge-ignore-file: the key below is a throwaway, made for these tests' local https server.
// webchecks.js: the judges on what came back, and the fetchers against local HTTP and HTTPS servers on
// 127.0.0.1 and a stand-in resolver; nothing leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {
  bareDomain,
  checkDomain,
  checkSite,
  daysLeft,
  domainLines,
  fetchPage,
  findSourceMaps,
  headerPairs,
  headerValue,
  judgeCertificate,
  judgeCookies,
  judgeDns,
  judgeHeaders,
  judgeMixedContent,
  judgeRedirects,
  judgeServerHeaders,
  judgeSourceMaps,
  lookupDns,
  looksLikeSourceMap,
  mixedContent,
  parseSetCookie,
  probeCertificate,
  redirectChain,
  scriptUrls,
  sourceMapUrl,
  stripComments,
  tagsIn,
} from '../webchecks.js';

const KEY = ['-----BEGIN PRIVATE KEY-----', 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgGQM/e21mklph5ULm', 'eHWTzBXiCz4UdVBUDZZlJqdXEDuhRANCAAQxgxi49hlQP+0iDrP+lpqX3kFMtfM2', 'akU3350uhSTqNR5ahV1QnYc2Fu9mN+jUtSy/1H7lhSpbLpDmBPWo1xQu', '-----END PRIVATE KEY-----'].join('\n');
const CERT = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBmzCCAUGgAwIBAgIURxvlR8LmiOkgzIpcfAYVYg5xd7swCgYIKoZIzj0EAwIw',
  'FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTEwMzIxMjEyOVoYDzIxMjYxMDEw',
  'MjEyMTI5WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO',
  'PQMBBwNCAAQxgxi49hlQP+0iDrP+lpqX3kFMtfM2akU3350uhSTqNR5ahV1QnYc2',
  'Fu9mN+jUtSy/1H7lhSpbLpDmBPWo1xQuo28wbTAdBgNVHQ4EFgQUHPTnmpFgRsOO',
  'sgR4hbzXxK7ipWcwHwYDVR0jBBgwFoAUHPTnmpFgRsOOsgR4hbzXxK7ipWcwDwYD',
  'VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI',
  'zj0EAwIDSAAwRQIhAIR0t8twNXfTdmn1g0g2XMRVB4eZ4jwuTn1Jeo0lXCESAiBb',
  'EZJOZD9BVOoBdwu3uj/a7JDc4wAJ60e2GRDXxqXsWA==',
  '-----END CERTIFICATE-----',
].join('\n');

const rules = (list) => list.map((f) => f.rule).sort();

/** A server on 127.0.0.1 answering from `routes` ({ path: (req, res) => … }); resolves { url, close }. */
async function serve(routes, { secure = false } = {}) {
  const handler = (req, res) => {
    const route = routes[req.url] ?? routes['*'];
    if (!route) {
      res.writeHead(404).end('not here');
      return;
    }
    route(req, res);
  };
  const server = secure ? https.createServer({ key: KEY, cert: CERT }, handler) : http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `${secure ? 'https' : 'http'}://127.0.0.1:${port}`, port, close: () => new Promise((r) => server.close(r)) };
}

test('headers come as pairs, an object or a fetch Headers, each Set-Cookie its own', () => {
  const h = new Headers([['content-type', 'text/html'], ['set-cookie', 'a=1'], ['set-cookie', 'b=2']]);
  assert.deepEqual(headerPairs(h).filter(([k]) => k === 'set-cookie'), [['set-cookie', 'a=1'], ['set-cookie', 'b=2']]);
  assert.equal(headerValue({ Server: 'nginx' }, 'server'), 'nginx');
  assert.equal(headerValue([['X-A', '1']], 'x-a'), '1');
  assert.deepEqual(headerPairs({ 'set-cookie': ['a=1', 'b=2'] }), [['set-cookie', 'a=1'], ['set-cookie', 'b=2']]);
});

test('security headers: what an html page over https misses, and nothing when it has them all', () => {
  const bare = { status: 200, headers: [['content-type', 'text/html']], body: '<html></html>' };
  const found = judgeHeaders(bare, { where: 'https://shop.example/' });
  assert.deepEqual(rules(found), ['csp-missing', 'framing-allowed', 'hsts-missing', 'referrer-policy-missing', 'xcto-missing']);
  assert.equal(found.find((f) => f.rule === 'csp-missing').severity, 'medium');
  // Over http there's no HSTS to ask for.
  assert.ok(!rules(judgeHeaders(bare, { where: 'http://shop.example/' })).includes('hsts-missing'));
  const good = {
    status: 200,
    headers: [
      ['content-type', 'text/html'],
      ['strict-transport-security', 'max-age=31536000'],
      ['content-security-policy', "default-src 'self'; frame-ancestors 'none'"],
      ['x-content-type-options', 'nosniff'],
      ['referrer-policy', 'no-referrer'],
    ],
  };
  assert.deepEqual(judgeHeaders(good, { where: 'https://shop.example/' }), []);
  const short = judgeHeaders({ ...good, headers: good.headers.map(([k, v]) => [k, k === 'strict-transport-security' ? 'max-age=600' : v]) }, { where: 'https://shop.example/' });
  assert.deepEqual(rules(short), ['hsts-short']);
  assert.equal(short[0].excerpt, 'Strict-Transport-Security: max-age=600');
  // An extra field rides on every finding (Hail's request and status, say).
  assert.ok(judgeHeaders(bare, { where: 'x', extra: { status: 200 } }).every((f) => f.status === 200));
});

test('server and framework versions; cookies without their flags, never their value', () => {
  const res = { status: 200, headers: [['Server', 'nginx/1.18.0'], ['X-Powered-By', 'Express'], ['set-cookie', 'sessionid=s3cr3t; Path=/'], ['set-cookie', 'theme=dark; Secure; SameSite=Lax'], ['set-cookie', 'track=1; SameSite=None']] };
  assert.deepEqual(rules(judgeServerHeaders(res, { where: 'u' })), ['powered-by', 'server-version']);
  assert.deepEqual(judgeServerHeaders({ headers: [['Server', 'nginx']] }, { where: 'u' }), []);
  const cookies = judgeCookies(res, { where: 'https://shop.example/' });
  assert.deepEqual(rules(cookies), ['cookie-no-samesite', 'cookie-not-httponly', 'cookie-not-secure', 'cookie-not-secure', 'cookie-samesite-none-insecure']);
  assert.ok(cookies.every((f) => !f.excerpt.includes('s3cr3t')));
  assert.equal(parseSetCookie('a=b; HttpOnly; SameSite=Strict').sameSite, 'Strict');
});

test('the certificate: expired, expiring (high under a week), self-signed, a hostname it doesn\'t name', () => {
  const now = new Date('2026-11-03T00:00:00Z');
  assert.equal(daysLeft('2026-11-13T00:00:00Z', now), 10);
  assert.equal(daysLeft(null), null);
  const at = (d) => judgeCertificate({ validTo: d }, { where: 'shop.example', now });
  assert.deepEqual(at('2026-11-13T00:00:00Z').map((f) => [f.rule, f.severity, f.days]), [['cert-expiring', 'medium', 10]]);
  assert.deepEqual(at('2026-11-05T00:00:00Z').map((f) => [f.rule, f.severity]), [['cert-expiring', 'high']]);
  assert.deepEqual(at('2026-10-01T00:00:00Z').map((f) => f.rule), ['cert-expired']);
  assert.deepEqual(at('2027-06-01T00:00:00Z'), []);
  assert.deepEqual(rules(judgeCertificate({ validTo: '2027-06-01T00:00:00Z', selfSigned: true, hostnameError: "Host: x. is not in the cert's altnames" }, { where: 'x', now })), ['cert-hostname-mismatch', 'cert-self-signed']);
  assert.deepEqual(rules(judgeCertificate({ validTo: '2027-06-01T00:00:00Z', authorizationError: 'UNABLE_TO_GET_ISSUER_CERT' }, { where: 'x', now })), ['cert-untrusted']);
  assert.deepEqual(rules(judgeCertificate({ error: 'ECONNREFUSED' }, { where: 'x' })), ['tls-unchecked']);
});

test('probeCertificate reads a local https server\'s certificate: self-signed, its names and end', async () => {
  const s = await serve({ '*': (req, res) => res.end('ok') }, { secure: true });
  try {
    const info = await probeCertificate(s.url);
    assert.equal(info.selfSigned, true);
    assert.equal(info.subject, 'localhost');
    assert.deepEqual(info.names, ['localhost']);
    assert.equal(info.validTo.slice(0, 4), '2126');
    assert.equal(info.hostnameError, null);
    const refused = await probeCertificate('https://127.0.0.1:1', { timeout: 2000 });
    assert.ok(refused.error);
  } finally {
    await s.close();
  }
});

test('mixed content on an https page: scripts and styles medium, images low; nothing on an http page', () => {
  const html = `<html><head><link rel="stylesheet" href="http://cdn.example/a.css"><script src="http://cdn.example/a.js"></script><script src="/ok.js"></script>
    <!-- <img src="http://commented.example/x.png"> --></head><body><img src='http://img.example/x.png'><a href="http://fine.example/">a link is fine</a></body></html>`;
  const list = mixedContent(html, 'https://shop.example/');
  assert.deepEqual(list.map((m) => [m.tag, m.active]), [['script', true], ['link', true], ['img', false]]);
  assert.deepEqual(mixedContent(html, 'http://shop.example/'), []);
  const found = judgeMixedContent(list, { where: 'https://shop.example/' });
  assert.deepEqual(found.map((f) => f.severity), ['medium', 'medium', 'low']);
  assert.match(found[0].fix, /https:\/\/cdn\.example\/a\.js/);
});

test('source maps: the comment, inline ones, what a map looks like, the page\'s same-origin scripts', () => {
  assert.equal(sourceMapUrl('x();\n//# sourceMappingURL=app.js.map', 'https://s.example/js/app.js'), 'https://s.example/js/app.js.map');
  assert.equal(sourceMapUrl('x();\n/*# sourceMappingURL=data:application/json;base64,e30= */', 'https://s.example/a.js'), 'inline');
  assert.equal(sourceMapUrl('x();', 'https://s.example/a.js'), null);
  assert.equal(looksLikeSourceMap('{"version":3,"sources":["a.ts"],"mappings":"AAAA"}'), true);
  assert.equal(looksLikeSourceMap('<html>'), false);
  assert.deepEqual(scriptUrls('<script src="/a.js"></script><script src="https://cdn.other/b.js"></script><script>inline()</script>', 'https://s.example/p'), ['https://s.example/a.js']);
  assert.deepEqual(judgeSourceMaps([{ script: 'https://s.example/a.js', map: 'https://s.example/a.js.map', sources: 3 }], { where: 'w' }).map((f) => [f.rule, f.severity]), [['source-map-served', 'medium']]);
});

test('findSourceMaps and checkSite against a local server: the headers, cookies, maps and the http redirect', async () => {
  const page = '<!doctype html><html><head><script src="/app.js"></script><script src="/vendor.js"></script></head><body><img src="http://img.example/x.png"></body></html>';
  const s = await serve({
    '/': (req, res) => res.writeHead(200, { 'content-type': 'text/html', server: 'Kestrel/8.0', 'set-cookie': 'sid=abc; Path=/' }).end(page),
    '/app.js': (req, res) => res.writeHead(200, { 'content-type': 'text/javascript' }).end('run();\n//# sourceMappingURL=app.js.map'),
    '/app.js.map': (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"version":3,"sources":["src/a.ts","src/b.ts"],"mappings":"AAAA"}'),
    // No comment, but the .map answers all the same.
    '/vendor.js': (req, res) => res.writeHead(200).end('lib();'),
    '/vendor.js.map': (req, res) => res.writeHead(200).end('{"version":3,"sources":["v.ts"],"mappings":""}'),
    '/old': (req, res) => res.writeHead(301, { location: '/' }).end(),
  });
  try {
    const maps = await findSourceMaps(page, `${s.url}/`);
    assert.deepEqual(maps.map((m) => [m.map.replace(s.url, ''), m.sources]), [['/app.js.map', 2], ['/vendor.js.map', 1]]);
    const chain = await redirectChain(`${s.url}/old`);
    assert.deepEqual(chain.map((c) => c.status), [301, 200]);
    const r = await checkSite(`${s.url}/old`);
    assert.equal(r.status, 200);
    assert.equal(r.final, `${s.url}/`);
    const got = rules(r.findings);
    for (const rule of ['csp-missing', 'server-version', 'cookie-not-httponly', 'cookie-no-samesite', 'source-map-served', 'no-https-redirect']) assert.ok(got.includes(rule), rule);
    // An http page: no HSTS asked for and no mixed content, as nothing is mixed.
    assert.ok(!got.includes('hsts-missing') && !got.includes('mixed-content'));
    const down = await fetchPage('http://127.0.0.1:1/', { timeout: 2000 });
    assert.ok(down.error);
  } finally {
    await s.close();
  }
});

test('redirects: no https redirect, a downgrade, a long chain, https and the bare domain not answering', () => {
  const http = [{ url: 'http://shop.example/', status: 200 }];
  assert.deepEqual(rules(judgeRedirects({ http }, { where: 'shop.example' })), ['no-https-redirect']);
  const good = [{ url: 'http://shop.example/', status: 301 }, { url: 'https://shop.example/', status: 200 }];
  assert.deepEqual(judgeRedirects({ http: good }, { where: 'shop.example' }), []);
  const down = [{ url: 'https://a.example/', status: 302 }, { url: 'http://b.example/', status: 301 }, { url: 'https://b.example/', status: 200 }];
  assert.deepEqual(rules(judgeRedirects({ https: down }, { where: 'a' })), ['redirect-downgrade']);
  const long = ['http://a/', 'https://a/', 'https://www.a/', 'https://www.a/en', 'https://www.a/en/'].map((url, i) => ({ url, status: i < 4 ? 301 : 200 }));
  assert.deepEqual(rules(judgeRedirects({ http: long }, { where: 'a' })), ['redirect-chain-long']);
  assert.deepEqual(rules(judgeRedirects({ https: [{ url: 'https://a/', error: 'ECONNREFUSED' }], bare: [{ url: 'https://a/', error: 'ENOTFOUND' }] }, { where: 'a' })), ['bare-domain-unreachable', 'https-unreachable']);
  assert.equal(bareDomain('www.shop.example'), 'shop.example');
  assert.equal(bareDomain('shop.example'), null);
  assert.equal(bareDomain('www.example'), null);
});

/** A resolver answering from `zone` ({ 'A shop.example': [...] }); anything else is ENODATA. */
function fakeResolver(zone) {
  const ask = (type) => async (name) => {
    const v = zone[`${type} ${name}`];
    if (v instanceof Error) throw v;
    if (v) return v;
    throw Object.assign(new Error(`query${type} ENODATA ${name}`), { code: 'ENODATA' });
  };
  return { resolve4: ask('A'), resolve6: ask('AAAA'), resolveCname: ask('CNAME'), resolveCaa: ask('CAA'), resolveMx: ask('MX') };
}

test('DNS through a stand-in resolver: CAA climbs to the parent, a dangling CNAME, no records at all', async () => {
  const resolver = fakeResolver({
    'A www.shop.example': ['20.1.2.3'],
    'CAA shop.example': [{ critical: 0, issue: 'letsencrypt.org' }],
    'MX shop.example': [{ exchange: 'mx2.example', priority: 20 }, { exchange: 'mx1.example', priority: 10 }],
    'CNAME old.shop.example': ['shop-old.azurewebsites.net'],
    'A nothing.example': Object.assign(new Error('queryA ENOTFOUND nothing.example'), { code: 'ENOTFOUND' }),
  });
  const www = await lookupDns('www.shop.example', { resolver });
  assert.deepEqual(www.a, ['20.1.2.3']);
  assert.equal(www.caaAt, 'shop.example');
  assert.deepEqual(judgeDns(www), []);
  const apex = await lookupDns('shop.example', { resolver });
  assert.deepEqual(apex.mx.map((m) => m.exchange), ['mx1.example', 'mx2.example']);
  assert.deepEqual(rules(judgeDns(apex)), ['dns-no-address']);
  const old = await lookupDns('old.shop.example', { resolver });
  assert.equal(old.cnameResolves, false);
  assert.deepEqual(rules(judgeDns(old)), ['dangling-cname']);
  const none = await lookupDns('nothing.example', { resolver });
  assert.deepEqual(rules(judgeDns(none)), ['dns-no-address', 'missing-caa']);
  assert.match(judgeDns(none).find((f) => f.rule === 'missing-caa').fix, /nothing\.example\. CAA 0 issue/);
});

test('checkDomain puts the records, the redirects and the certificate together', async () => {
  const resolver = fakeResolver({ 'A shop.example': ['127.0.0.1'] });
  // fetch stands in for the network: http answers itself, https sends to a page, and the certificate runs out in 12 days.
  const fetchImpl = async (url) => {
    const answers = {
      'http://shop.example/': [200, {}],
      'https://shop.example/': [200, { 'content-type': 'text/html' }],
    };
    const a = answers[url];
    if (!a) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    return new Response('<html></html>', { status: a[0], headers: a[1] });
  };
  const now = new Date('2026-11-03T00:00:00Z');
  const probe = async () => ({ validTo: '2026-11-15T00:00:00Z', issuer: 'R11' });
  const d = await checkDomain('https://shop.example/path', { resolver, fetchImpl, probe, now });
  assert.equal(d.host, 'shop.example');
  assert.equal(d.enforced, false);
  assert.equal(d.days, 12);
  assert.deepEqual(rules(d.findings), ['cert-expiring', 'missing-caa', 'no-https-redirect']);
  const text = domainLines(d).join('\n');
  assert.match(text, /A +127\.0\.0\.1/);
  assert.match(text, /HTTPS +not enforced/);
  assert.match(text, /R11, until 2026-11-15 \(12 days\)/);
  const www = await checkDomain('www.shop.example', { resolver, fetchImpl, probe, now });
  assert.ok(rules(www.findings).includes('https-unreachable'));
  assert.equal(www.bare, 'shop.example');
});

test('stripComments and tagsIn read as the regexes did, and stay linear on comments and tags left open', () => {
  const oldStrip = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
  const oldTags = (s, names) => [...s.matchAll(new RegExp(`<(${names})\\b[^>]*>`, 'gi'))].map((m) => ({ name: m[1].toLowerCase(), tag: m[0] }));
  const samples = [
    '',
    '<p>no comments</p>',
    'a<!-- one -->b<!---->c<!-->d-->e',
    'a<!-- open <script src="x.js">',
    '<!-- a --><!-- b <!-- c --> d -->',
    '<SCRIPT src=a.js><script\nsrc="b.js" defer><scripts><script',
    '<iframe src=a><frame src=b><img src=c><img',
    '<script src="a>b.js"><img alt="x" src=y>',
  ];
  for (const s of samples) {
    assert.equal(stripComments(s), oldStrip(s), s);
    for (const names of ['script', 'iframe|frame', 'img|audio|video|source|track']) assert.deepEqual(tagsIn(oldStrip(s), names), oldTags(oldStrip(s), names), `${names} in ${s}`);
  }
  // Each of these took seconds with the regexes: every <!-- or <script left open was searched to the end.
  const started = performance.now();
  assert.deepEqual(mixedContent('<!--'.repeat(20_000) + 'x'.repeat(100_000), 'https://s.example/'), []);
  assert.deepEqual(scriptUrls('<script'.repeat(30_000), 'https://s.example/'), []);
  assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
});

test('findSourceMaps asks for a few scripts at once and keeps the page\'s order', async () => {
  let open = 0;
  let most = 0;
  const fetchImpl = async (url) => {
    open++;
    most = Math.max(most, open);
    // The first scripts answer last, so the order can't come from who finished first.
    const n = Number(/s(\d+)\.js/.exec(url)?.[1] ?? 0);
    await new Promise((r) => setTimeout(r, 40 - n * 4));
    open--;
    return url.endsWith('.map') ? new Response(`{"version":3,"sources":[${'"a",'.repeat(n)}"z"],"mappings":""}`) : new Response('x();');
  };
  const page = Array.from({ length: 8 }, (_, i) => `<script src="/s${i}.js"></script>`).join('');
  const maps = await findSourceMaps(page, 'https://s.example/', { fetchImpl });
  assert.deepEqual(maps.map((m) => [m.script.replace('https://s.example', ''), m.sources]), Array.from({ length: 8 }, (_, i) => [`/s${i}.js`, i + 1]));
  assert.ok(most > 1 && most <= 4, `${most} at once`);
});
