// /scan and `hail security`: the judges on their own, then scans of servers on this machine: one that
// gets everything wrong, a SPA that answers every path with its index page (no false positives), and
// an https one with a self-signed certificate; then the headless JSON and SARIF, and the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPOSED, authCandidates, excerpt, judgeCookies, judgeCors, judgeExposed, judgeHeaders, judgeHttpsRedirect, judgeMethods, judgeMissingAuth, judgeTls, judgeVerboseError, likeBaseline, probeTls, parseSetCookie, runScan, scanEstimate, scanMarkdown, scanUrl, similarBody, withoutCredentials } from '../src/scan.js';
import { runSecurity, securityArgs } from '../src/headless.js';
import { KEYS, start, tempHome, until } from './helpers.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const res = (status, headers = [], body = '') => ({ status, headers, body, raw: Buffer.from(body), url: 'http://x/' });
const rules = (list) => list.map((f) => f.rule).sort();

// ---------------------------------------------------------------------------------------------------
// The judges.

test('TLS: expiry by days left, the name, self-signed, untrusted, old protocols', () => {
  const now = new Date('2026-11-03T00:00:00Z');
  const at = (days) => new Date(now.getTime() + days * 86_400_000).toISOString();
  const tls = (extra) => judgeTls({ protocol: 'TLSv1.3', validTo: at(400), legacy: { TLSv1: false, 'TLSv1.1': false }, ...extra }, { where: 'h', now });
  assert.deepEqual(tls({}), []);
  assert.deepEqual(tls({ validTo: at(-1) }).map((f) => [f.rule, f.severity]), [['cert-expired', 'critical']]);
  assert.deepEqual(tls({ validTo: at(5) }).map((f) => [f.rule, f.severity]), [['cert-expiring', 'high']]);
  assert.deepEqual(tls({ validTo: at(20) }).map((f) => [f.rule, f.severity]), [['cert-expiring', 'medium']]);
  assert.deepEqual(rules(tls({ hostnameError: "Host: a. is not in the cert's altnames", authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID' })), ['cert-hostname-mismatch']);
  assert.deepEqual(rules(tls({ selfSigned: true, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT' })), ['cert-self-signed']);
  assert.deepEqual(rules(tls({ authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })), ['cert-untrusted']);
  assert.deepEqual(rules(tls({ protocol: 'TLSv1', legacy: { TLSv1: true, 'TLSv1.1': true } })), ['tls-1.0-accepted', 'tls-1.1-accepted', 'tls-old-negotiated']);
  assert.deepEqual(rules(tls({ legacy: { TLSv1: null, 'TLSv1.1': null } })), [], "a runtime that can't offer them says nothing");
  assert.deepEqual(judgeTls({ error: 'refused' }, { where: 'h' }).map((f) => f.severity), ['unknown']);
});

test('headers: what is missing, HSTS only over https, versions given away; an html page weighs more', () => {
  const bare = judgeHeaders(res(200, [['Content-Type', 'text/html'], ['Server', 'nginx/1.18.0'], ['X-Powered-By', 'PHP/8.1']]), { where: 'https://a/', https: true });
  assert.deepEqual(rules(bare), ['csp-missing', 'framing-allowed', 'hsts-missing', 'powered-by', 'referrer-policy-missing', 'server-version', 'xcto-missing']);
  assert.equal(bare.find((f) => f.rule === 'csp-missing').severity, 'medium');
  assert.equal(bare.find((f) => f.rule === 'server-version').header, 'Server: nginx/1.18.0');
  assert.ok(!rules(judgeHeaders(res(200, []), { where: 'http://a/', https: false })).includes('hsts-missing'));
  assert.equal(judgeHeaders(res(200, [['Content-Type', 'application/json']]), { where: 'http://a/', https: false }).find((f) => f.rule === 'csp-missing').severity, 'low');
  const good = [['Strict-Transport-Security', 'max-age=31536000'], ['Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'"], ['X-Content-Type-Options', 'nosniff'], ['Referrer-Policy', 'no-referrer'], ['Server', 'nginx']];
  assert.deepEqual(judgeHeaders(res(200, good), { where: 'https://a/', https: true }), []);
  assert.deepEqual(rules(judgeHeaders(res(200, [...good.slice(1), ['Strict-Transport-Security', 'max-age=300']]), { where: 'https://a/', https: true })), ['hsts-short']);
});

test("cookies: Secure over https, HttpOnly for a session's, SameSite; the value never in the evidence", () => {
  assert.deepEqual(parseSetCookie('a=1; Path=/; HttpOnly; SameSite=Lax').sameSite, 'Lax');
  const found = judgeCookies(res(200, [['set-cookie', 'sessionid=s3cr3tvalue; Path=/'], ['set-cookie', 'theme=dark; Secure; SameSite=Lax'], ['set-cookie', 'auth=x; Secure; HttpOnly; SameSite=None']]), { where: 'https://a/', https: true });
  assert.deepEqual(found.map((f) => `${f.rule}:${f.cookie}`).sort(), ['cookie-no-samesite:sessionid', 'cookie-not-httponly:sessionid', 'cookie-not-secure:sessionid']);
  assert.ok(found.every((f) => !f.header.includes('s3cr3tvalue')));
  assert.ok(!rules(judgeCookies(res(200, [['set-cookie', 'sessionid=1; HttpOnly; SameSite=Lax']]), { where: 'http://a/', https: false })).includes('cookie-not-secure'));
});

test('CORS: an echoed Origin, worse with credentials; * with credentials; a fixed origin is fine', () => {
  const cors = (h) => judgeCors(res(200, h), { where: 'https://a/' }).map((f) => [f.rule, f.severity]);
  assert.deepEqual(cors([['Access-Control-Allow-Origin', 'https://evil.example'], ['Access-Control-Allow-Credentials', 'true']]), [['cors-reflected-credentials', 'high']]);
  assert.deepEqual(cors([['Access-Control-Allow-Origin', 'https://evil.example']]), [['cors-reflected', 'medium']]);
  assert.deepEqual(cors([['Access-Control-Allow-Origin', '*'], ['Access-Control-Allow-Credentials', 'true']]), [['cors-wildcard-credentials', 'medium']]);
  assert.deepEqual(cors([['Access-Control-Allow-Origin', '*']]), []);
  assert.deepEqual(cors([['Access-Control-Allow-Origin', 'https://app.example']]), []);
});

test("exposed paths: judged by content, and a catch-all answer like the baseline's is no finding", () => {
  const probe = (path) => EXPOSED.find((p) => p.path === path);
  const index = '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>';
  const baseline = res(200, [['Content-Type', 'text/html']], index);
  assert.ok(likeBaseline(res(200, [['Content-Type', 'text/html']], index), baseline));
  assert.equal(judgeExposed(probe('/.git/HEAD'), res(200, [], 'ref: refs/heads/main\n'), { url: 'http://a/.git/HEAD', baseline }).length, 1);
  assert.equal(judgeExposed(probe('/.git/HEAD'), res(200, [['Content-Type', 'text/html']], index), { url: 'http://a/.git/HEAD', baseline }).length, 0);
  assert.equal(judgeExposed(probe('/.git/HEAD'), res(404, [], 'ref: x'), { url: 'u', baseline }).length, 0);
  const env = judgeExposed(probe('/.env'), res(200, [], 'DB_PASSWORD=hunter2\nAPI_KEY=abc123\n'), { url: 'http://a/.env', baseline: null });
  assert.equal(env[0].severity, 'critical');
  assert.equal(env[0].excerpt, 'DB_PASSWORD=•••••• API_KEY=••••••', 'only the names');
  assert.equal(judgeExposed(probe('/.env'), res(200, [], index), { url: 'u', baseline: null }).length, 0, 'an html page is no .env');
  assert.equal(judgeExposed(probe('/.DS_Store'), { ...res(200), raw: Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31, 9]) }, { url: 'u', baseline }).length, 1);
  assert.equal(judgeExposed(probe('/backup.zip'), { ...res(200), raw: Buffer.from('PK\x03\x04rest') }, { url: 'u', baseline }).length, 1);
  assert.equal(judgeExposed(probe('/openapi.json'), res(200, [], '{"openapi":"3.0.0","paths":{}}'), { url: 'u', baseline }).length, 1);
  assert.equal(judgeExposed(probe('/actuator/env'), res(200, [], '{"activeProfiles":[],"propertySources":[]}'), { url: 'u', baseline }).length, 1);
  // security.txt: its absence is the finding, a catch-all page counts as absent.
  const sec = probe('/.well-known/security.txt');
  assert.deepEqual(judgeExposed(sec, res(404), { url: 'u', baseline }).map((f) => [f.rule, f.severity]), [['no-security-txt', 'low']]);
  assert.equal(judgeExposed(sec, res(200, [['Content-Type', 'text/html']], index), { url: 'u', baseline }).length, 1);
  assert.equal(judgeExposed(sec, res(200, [], 'Contact: mailto:security@a.example\nExpires: 2027-01-01T00:00:00Z\n'), { url: 'u', baseline }).length, 0);
});

test('methods, verbose errors and https redirects', () => {
  assert.deepEqual(rules(judgeMethods(res(200, [['Allow', 'GET, HEAD, PUT, DELETE, TRACE']]), res(200, [['Content-Type', 'message/http']], 'TRACE / HTTP/1.1\r\nHost: a'), { where: 'http://a/' })), ['methods-allowed', 'trace-enabled']);
  assert.deepEqual(judgeMethods(res(200, [['Allow', 'GET, HEAD, OPTIONS']]), res(405), { where: 'http://a/' }), []);
  assert.deepEqual(judgeMethods(null, res(200, [['Content-Type', 'text/html']], '<html>app</html>'), { where: 'http://a/' }), [], "a catch-all 200 isn't TRACE echoing");
  const node = 'Error: boom\n    at handler (/srv/app/server.js:10:5)\n    at Layer.handle (/srv/node_modules/express/lib/router/layer.js:95:5)';
  for (const body of [node, 'Traceback (most recent call last):\n  File "app.py"', "<h2> <i>Server Error in '/' Application.</i> </h2>", 'java.lang.NullPointerException: x\n\tat com.a.B.c(B.java:10)', 'Fatal error: Uncaught Error in /var/www/index.php on line 3']) {
    assert.equal(judgeVerboseError(res(500, [], body), { where: 'u', request: 'GET /x' })[0]?.rule, 'verbose-error', body);
  }
  assert.deepEqual(judgeVerboseError(res(404, [], 'Not found. An Exception is when something goes wrong.'), { where: 'u', request: 'GET /x' }), []);
  assert.deepEqual(judgeHttpsRedirect(res(301, [['Location', 'https://a/']]), { where: 'http://a/' }), []);
  assert.equal(judgeHttpsRedirect(res(200), { where: 'http://a/' })[0].severity, 'high');
  assert.equal(judgeHttpsRedirect(res(302, [['Location', '/login']]), { where: 'http://a/' })[0].rule, 'http-no-https-redirect');
});

test('missing auth: the credential headers dropped, a 2xx with a body like the real one flagged, secrets blanked', () => {
  const requests = [
    { method: 'GET', label: 'Me', headers: [['Authorization', 'Bearer {{token}}'], ['Accept', 'application/json']] },
    { method: 'POST', label: 'Pay', headers: [['X-Api-Key', '{{key}}']] },
    { method: 'GET', label: 'Open', headers: [['Accept', '*/*']] },
  ];
  assert.deepEqual(authCandidates(requests).map((c) => [c.request.label, c.safe]), [['Me', true], ['Pay', false]]);
  assert.deepEqual(withoutCredentials([['Authorization', 'Bearer x'], ['Cookie', 'a=1'], ['Accept', 'a']]), { headers: [['Accept', 'a']], dropped: ['Authorization', 'Cookie'] });
  assert.ok(similarBody('{"id":1,"name":"ana"}', '{"id":2,"name":"bo"}'));
  assert.ok(!similarBody('{"id":1,"name":"ana"}', '{"error":"unauthorised"}'));
  assert.ok(similarBody('[1,2]', '[3]'));
  const withAuth = res(200, [], '{"id":1,"email":"ana@a.example","note":""}');
  const f = judgeMissingAuth({ label: 'Me', method: 'GET', url: 'http://a/me?key=tok-123456', dropped: ['Authorization'], withAuth, without: res(200, [], '{"id":1,"email":"ana@a.example","note":"tok-123456"}'), secrets: ['tok-123456'] });
  assert.equal(f[0].severity, 'high');
  assert.ok(!JSON.stringify(f).includes('tok-123456'));
  assert.deepEqual(judgeMissingAuth({ label: 'Me', method: 'GET', url: 'http://a/me', dropped: ['Authorization'], withAuth, without: res(401, [], '{"error":"x"}') }), []);
  assert.equal(excerpt('password=hunter2 "apiKey": "abc123"'), 'password=•••••• "apiKey": "••••••"');
});

test('the arguments of hail security, and URLs typed for /scan', () => {
  assert.deepEqual(securityArgs(['https://a', '--json', '--fail-on', 'medium']), { target: 'https://a', env: null, json: true, sarif: false, sarifFile: null, failOn: 'medium', production: false, help: false });
  assert.equal(securityArgs(['x', '--sarif', 'out.sarif']).sarifFile, 'out.sarif');
  assert.equal(securityArgs(['--sarif', 'x']).target, 'x');
  assert.match(securityArgs(['x', '--fail-on', 'bad']).problem, /--fail-on/);
  assert.match(securityArgs(['x', '--json', '--sarif']).problem, /stdout/);
  assert.equal(scanUrl('app.example/path'), 'https://app.example/path');
  assert.equal(scanUrl('http://user:pw@a.example:8080/x#y'), 'http://a.example:8080/x');
  assert.equal(scanUrl('ftp://a'), null);
  assert.ok(scanEstimate() >= 20 && scanEstimate({ auth: 100 }) <= 80);
});

// ---------------------------------------------------------------------------------------------------
// Servers on this machine.

let cleanup;
let dir;
let bad;
let spa;
let secure;
let badUrl;
const seen = [];

const INDEX = '<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/static/app.js"></script></body></html>';

before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-scan-'));
  // Everything wrong: no headers, versions, a cookie without flags, CORS echoed with credentials,
  // .git and .env served, TRACE echoed, stack traces, and a route that answers anyone.
  bad = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
    res.setHeader('Server', 'Apache/2.4.1 (Unix)');
    res.setHeader('X-Powered-By', 'Express');
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    const path = req.url.split('?')[0];
    if (req.method === 'TRACE') {
      res.setHeader('Content-Type', 'message/http');
      return res.end(`TRACE ${req.url} HTTP/1.1\r\nHost: ${req.headers.host}\r\n`);
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', 'GET, HEAD, POST, PUT, DELETE, TRACE');
      return res.end();
    }
    if (path === '/') {
      res.setHeader('Set-Cookie', ['sessionid=abc123def; Path=/']);
      res.setHeader('Content-Type', 'text/html');
      return res.end(INDEX);
    }
    if (path === '/.git/HEAD') return res.end('ref: refs/heads/main\n');
    if (path === '/.env') return res.end('DB_PASSWORD=hunter2\nAPI_KEY=k-998877\n');
    if (path === '/api/me') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ id: 1, name: 'ana' }));
    }
    if (path === '/api/admin') {
      res.setHeader('Content-Type', 'application/json');
      if (!req.headers.authorization) {
        res.statusCode = 401;
        return res.end('{"error":"sign in"}');
      }
      return res.end(JSON.stringify({ users: 3, plan: 'gold' }));
    }
    res.statusCode = 404;
    res.end(`Error: Not found ${path}\n    at notFound (/srv/app/server.js:42:11)\n    at Layer.handle (/srv/app/node_modules/express/lib/router/layer.js:95:5)`);
  });
  // A SPA done right: every path is its index page, with every header.
  spa = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Server', 'nginx');
    if (req.method === 'TRACE') res.statusCode = 405;
    res.end(INDEX);
  });
  secure = createHttpsServer({ key: fixture('localhost.key'), cert: fixture('localhost.crt') }, (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Set-Cookie', 'sid=1; HttpOnly; SameSite=Lax');
    res.statusCode = req.url === '/' ? 200 : 404;
    res.end(req.url === '/' ? 'hello' : 'nothing here');
  });
  await Promise.all([bad, spa, secure].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  badUrl = `http://127.0.0.1:${bad.address().port}`;
  writeFileSync(join(dir, 'http-client.env.json'), JSON.stringify({ local: { host: badUrl, token: 'tok-5551234' } }));
  writeFileSync(join(dir, 'api.http'), '### Home\nGET {{host}}/\n\n### Me\nGET {{host}}/api/me\nAuthorization: Bearer {{token}}\n\n### Admin\nGET {{host}}/api/admin\nAuthorization: Bearer {{token}}\n\n### Pay\nPOST {{host}}/api/pay\nAuthorization: Bearer {{token}}\n');
});

after(() => {
  for (const s of [bad, spa, secure]) s.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

const authOf = (label, path) => ({ label, req: { method: 'GET', url: `${badUrl}${path}`, headers: [['Authorization', 'Bearer tok-5551234']], body: '', secrets: ['tok-5551234'] } });

test('a server that gets everything wrong: each problem found once, nothing secret in what is kept', async () => {
  const result = await runScan({ target: `${badUrl}/`, auth: [authOf('Me', '/api/me'), authOf('Admin', '/api/admin')] });
  const found = new Set(result.findings.map((f) => f.rule));
  for (const rule of ['http-no-https-redirect', 'csp-missing', 'xcto-missing', 'framing-allowed', 'referrer-policy-missing', 'server-version', 'powered-by', 'cookie-not-httponly', 'cookie-no-samesite', 'cors-reflected-credentials', 'exposed-git', 'exposed-env', 'no-security-txt', 'methods-allowed', 'trace-enabled', 'verbose-error', 'auth-not-required']) {
    assert.ok(found.has(rule), `${rule} in ${[...found].join(', ')}`);
  }
  assert.ok(!found.has('hsts-missing') && !found.has('cookie-not-secure'), 'nothing https-only over http');
  const missing = result.findings.filter((f) => f.rule === 'auth-not-required');
  assert.deepEqual(missing.map((f) => f.title), ['Me answers without its credentials'], 'Admin needs its credentials');
  assert.equal(result.findings[0].severity, 'critical', 'worst first');
  const kept = JSON.stringify(result);
  for (const secret of ['tok-5551234', 'hunter2', 'k-998877', 'abc123def']) assert.ok(!kept.includes(secret), `${secret} kept`);
  assert.ok(result.sent <= scanEstimate({ auth: 2 }) && result.sent >= 20, `${result.sent} sent`);
  const methods = new Set(seen.map((s) => s.method));
  assert.deepEqual([...methods].sort(), ['GET', 'OPTIONS', 'TRACE']);
  const md = scanMarkdown(result, { at: new Date(0) });
  assert.match(md, /^# Security scan of http:\/\/127\.0\.0\.1:\d+\/$/m);
  assert.match(md, /\| critical \| A \.env file is served \(`exposed-env`\) \|/);
});

test('a SPA answering every path with its page: no exposed files, no TRACE, no stack traces', async () => {
  const result = await runScan({ target: `http://127.0.0.1:${spa.address().port}/` });
  const found = result.findings.map((f) => f.rule);
  assert.deepEqual(found.filter((r) => r.startsWith('exposed-') || r === 'trace-enabled' || r === 'verbose-error'), []);
  assert.deepEqual(found.filter((r) => r !== 'http-no-https-redirect').sort(), ['no-security-txt']);
});

test('https with a self-signed certificate: its TLS read, the certificate flagged, HSTS missing', async () => {
  const result = await runScan({ target: `https://127.0.0.1:${secure.address().port}/` });
  const found = rules(result.findings);
  assert.ok(found.includes('cert-self-signed'), found.join(', '));
  assert.ok(found.includes('hsts-missing'));
  assert.ok(!found.includes('cert-hostname-mismatch'), 'its names include 127.0.0.1');
  assert.ok(!found.some((r) => r.startsWith('cert-expir')));
  assert.ok(!found.includes('tls-1.0-accepted'), "Node's server refuses TLS 1.0");
  assert.match(result.tls.protocol, /^TLSv1\.[23]$/);
});

test('a server that still takes TLS 1.0 is caught (where this OpenSSL can still offer it)', async () => {
  const old = createHttpsServer({ key: fixture('localhost.key'), cert: fixture('localhost.crt'), minVersion: 'TLSv1', ciphers: 'DEFAULT:@SECLEVEL=0' }, (req, res) => res.end('old'));
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  try {
    const info = await probeTls(`https://127.0.0.1:${old.address().port}/`);
    assert.notEqual(info.legacy.TLSv1, false, 'accepted, or unknown when this runtime cannot offer it');
    if (info.legacy.TLSv1) assert.ok(rules(judgeTls(info, { where: 'h' })).includes('tls-1.0-accepted'));
  } finally {
    old.close();
  }
});

test('the cap stops it, and so does cancelling, keeping what was found', async () => {
  const capped = await runScan({ target: `${badUrl}/`, cap: 4 });
  assert.equal(capped.sent, 4);
  assert.ok(capped.capped && capped.notes.some((n) => /cap of 4/.test(n)));
  const stop = new AbortController();
  const cancelled = await runScan({ target: `${badUrl}/`, signal: stop.signal, onProgress: (n) => n === 3 && stop.abort() });
  assert.ok(cancelled.cancelled);
  assert.ok(cancelled.sent < 10);
  const nowhere = await runScan({ target: 'http://127.0.0.1:1/' });
  assert.match(nowhere.error, /No answer/);
});

test('hail security: the JSON, SARIF to a file, the exit code, and a .http file as the target', async () => {
  const out = [];
  const err = [];
  const code = await runSecurity([`${badUrl}/`, '--json'], { print: (l) => out.push(l), printError: (l) => err.push(l), now: new Date(0) });
  assert.equal(code, 1, 'high findings fail by default');
  const j = JSON.parse(out.join('\n'));
  assert.equal(j.app, 'hail');
  assert.equal(j.check, 'web');
  assert.equal(j.target, `${badUrl}/`);
  assert.equal(j.at, '1970-01-01T00:00:00.000Z');
  assert.ok(j.counts.critical >= 1 && j.counts.high >= 1);
  assert.ok(j.sent > 0 && Array.isArray(j.notes));
  assert.ok(j.findings.every((f) => f.rule && f.severity && f.title && f.where && !('excerpt' in f)));
  assert.match(err.join('\n'), /Only for an app you own/);

  const files = {};
  const text = [];
  const code2 = await runSecurity([`http://127.0.0.1:${spa.address().port}/`, '--sarif', 'out.sarif', '--fail-on', 'none'], { print: (l) => text.push(l), printError: () => {}, cwd: dir, write: (p, t) => (files[p] = t) });
  assert.equal(code2, 0);
  const sarif = JSON.parse(files[join(dir, 'out.sarif')]);
  assert.equal(sarif.version, '2.1.0');
  assert.ok(sarif.runs[0].results.some((r) => r.ruleId === 'no-security-txt'));
  assert.match(text.join('\n'), /LOW {2}No security\.txt/);

  // The file's first request's origin, and its GET with credentials sent again without them.
  seen.length = 0;
  const out3 = [];
  const code3 = await runSecurity(['api.http', '--env', 'local', '--json'], { print: (l) => out3.push(l), printError: () => {}, cwd: dir, config: {} });
  assert.equal(code3, 1);
  const j3 = JSON.parse(out3.join('\n'));
  assert.equal(j3.environment, 'local');
  assert.ok(j3.findings.some((f) => f.rule === 'auth-not-required' && f.title === 'Me answers without its credentials'));
  assert.ok(!seen.some((s) => s.method === 'POST'), 'the POST is left alone');
  assert.ok(!out3.join('\n').includes('tok-5551234'));
  assert.equal(await runSecurity(['ftp://x'], { print: () => {}, printError: () => {} }), 2);
});

test('/scan in the app: asks with the target named, lists the findings worst first, ↵ the evidence, y copies', async () => {
  const copied = [];
  const app = start({ initialFile: join(dir, 'api.http'), cwd: dir, copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Home') && /env local/.test(frame()), 'the file');
    app.stdin.write('/');
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write('scan');
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes(`Scan ${badUrl}/? It sends about`), 'the question');
    app.stdin.write('1');
    // One POST with credentials: asked about separately, and No leaves it.
    await until(() => frame().includes('Also send 1 POST request without credentials?'), 'the question about the POST');
    app.stdin.write('1');
    await until(() => frame().includes(`Scan of ${badUrl.slice(7)}:`), 'the findings', 20000);
    assert.match(frame(), /CRIT A \.env file is served/);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Fix: Keep .env out'), 'the evidence');
    assert.match(frame(), /Request {2}GET \/\.env → 200/);
    assert.ok(!frame().includes('hunter2'));
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes(`Scan of ${badUrl.slice(7)}:`), 'back to the list');
    app.stdin.write('y');
    await until(() => copied.length === 1, 'copied');
    assert.match(copied[0], /^\[critical\] A \.env file is served \(exposed-env\)/);
    app.stdin.write('m');
    await until(() => copied.length === 2, 'the report copied');
    assert.match(copied[1], /^# Security scan of /);
    assert.ok(!copied.join('\n').includes('tok-5551234'));
  } finally {
    app.unmount();
  }
});

test('/scan asks again in production, and no sends nothing', async () => {
  const prodDir = mkdtempSync(join(tmpdir(), 'hail-scan-prod-'));
  mkdirSync(join(prodDir, '.fleet'));
  writeFileSync(join(prodDir, '.fleet', 'project.json'), JSON.stringify({ default: 'live', environments: { live: { prod: true, hail: { env: 'production' } } } }));
  writeFileSync(join(prodDir, 'http-client.env.json'), JSON.stringify({ production: { host: badUrl } }));
  writeFileSync(join(prodDir, 'api.http'), '### Home\nGET {{host}}/\n');
  const app = start({ initialFile: join(prodDir, 'api.http'), cwd: prodDir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Home') && /env production/.test(frame()), 'the file, in production');
    seen.length = 0;
    app.stdin.write('/');
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write('scan');
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('It sends about'), 'the question');
    app.stdin.write('1');
    await until(() => frame().includes(`live is production. Scan ${badUrl}/?`), "production's question");
    app.stdin.write('1');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(seen.length, 0, 'nothing sent');
  } finally {
    app.unmount();
    rmSync(prodDir, { recursive: true, force: true });
  }
});
