// bilge-ignore-file: the tests carry made-up credentials on purpose, to see them hidden.
// Redaction everywhere: on screen (detail, rows, search), in the .http files and the request context
// handed to Hail, in HAR exports; the HAR round trip; the filter; and what the traffic says (security.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeContext, contextIn, takeLine } from '@fleet/kit/family.js';
import { maskBody, maskHeader, maskText, maskUrl, secretsIn } from '../src/redact.js';
import { appendBlock, httpBlock, namesIn, requestContext } from '../src/httpfile.js';
import { fromHar, toHar } from '../src/har.js';
import { capturedLine, filtered, hosts, parseFilter } from '../src/exchange.js';
import { detailText, hiddenCount } from '../src/detail.js';
import { trafficFindings } from '../src/security.js';
import { demoExchanges } from '../src/demo.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2lnbmF0dXJlLW9mLXRoZS10ZXN0';
const GH = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

/** An exchange as the proxy records one. */
function ex({ method = 'GET', url = 'https://api.test/v1/items', reqHeaders = [], reqBody = null, status = 200, resHeaders = [], resBody = null, intercepted = true } = {}) {
  const u = new URL(url);
  const req = reqBody == null ? null : Buffer.from(reqBody);
  const res = resBody == null ? null : Buffer.from(resBody);
  return {
    id: 1,
    kind: 'http',
    state: 'done',
    at: Date.UTC(2026, 10, 3, 10, 0, 0),
    scheme: u.protocol.slice(0, -1),
    method,
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    path: `${u.pathname}${u.search}`,
    url,
    intercepted: intercepted && u.protocol === 'https:',
    request: { httpVersion: '1.1', headers: reqHeaders, body: req, size: req?.length ?? 0, truncated: false },
    response: { status, statusText: 'OK', httpVersion: '1.1', headers: resHeaders, body: res, size: res?.length ?? 0, truncated: false },
    timings: { start: Date.UTC(2026, 10, 3, 10, 0, 0), connect: null, ttfb: Date.UTC(2026, 10, 3, 10, 0, 0) + 40, end: Date.UTC(2026, 10, 3, 10, 0, 0) + 50 },
  };
}

const login = () =>
  ex({
    method: 'POST',
    url: `https://api.test/login?access_token=${JWT}&page=2`,
    reqHeaders: [
      ['Host', 'api.test'],
      ['Authorization', `Bearer ${JWT}`],
      ['Cookie', 'session=abc123def; theme=dark'],
      ['X-Api-Key', 'k-123456789'],
      ['Accept', 'application/json'],
      ['Content-Type', 'application/json'],
    ],
    reqBody: JSON.stringify({ user: 'ana', password: 'hunter2hunter2', nested: { client_secret: 'cs-998877' }, note: `my token is ${GH}` }),
    resHeaders: [['Set-Cookie', 'session=zzz999; Path=/; HttpOnly'], ['Content-Type', 'application/json']],
    resBody: JSON.stringify({ ok: true, token: JWT }),
  });

const SECRETS = [JWT, 'abc123def', 'k-123456789', 'hunter2hunter2', 'cs-998877', GH, 'zzz999'];
const leaks = (text) => SECRETS.filter((s) => String(text).includes(s));

test('the masks: credential headers, cookies by name, secret query parameters and fields, and what codescan takes for a secret', () => {
  assert.equal(maskHeader('Authorization', `Bearer ${JWT}`), 'Bearer ••••');
  assert.equal(maskHeader('Authorization', 'opaque'), '••••');
  assert.equal(maskHeader('Cookie', 'session=abc; theme=dark'), 'session=••••; theme=••••');
  assert.equal(maskHeader('Set-Cookie', 'sid=1; Path=/; Secure'), 'sid=••••; Path=/; Secure');
  assert.equal(maskHeader('X-Api-Key', 'k-1'), '••••');
  assert.equal(maskHeader('X-Session-Token', 'abc'), '••••');
  assert.equal(maskHeader('Accept', 'application/json'), 'application/json');
  assert.equal(maskUrl(`https://a.test/x?access_token=${JWT}&page=2`), 'https://a.test/x?access_token=••••&page=2');
  assert.equal(maskUrl('https://user:pw@a.test/'), 'https://user:••••@a.test/');
  assert.deepEqual(secretsIn(`token ${GH} and ${JWT}`).sort(), [GH, JWT].sort());
  assert.equal(leaks(maskText(`see ${GH}`)).length, 0);
  const body = maskBody(JSON.stringify({ password: 'hunter2hunter2', user: 'ana', list: [{ api_key: 'k-123456789' }] }), 'application/json');
  assert.deepEqual(JSON.parse(body), { password: '••••', user: 'ana', list: [{ api_key: '••••' }] });
  assert.equal(maskBody('user=ana&password=hunter2hunter2', 'application/x-www-form-urlencoded'), 'user=ana&password=••••');
});

test('the detail view hides every credential until s, and says how many', () => {
  const e = login();
  const hidden = detailText(e);
  assert.deepEqual(leaks(hidden.text), []);
  assert.match(hidden.text, /Authorization: Bearer •••• {3}\(hidden\)/);
  assert.match(hidden.text, /Cookie: session=••••; theme=••••/);
  assert.ok(hiddenCount(e) >= 6);
  const shown = detailText(e, { secrets: true });
  assert.ok(shown.text.includes(`Bearer ${JWT}`));
  assert.ok(shown.text.includes('hunter2hunter2'));
});

test('a .http block has variables in place of every credential, and Hail\'s shape', () => {
  const { block, name, variables } = httpBlock(login(), { taken: ['post-login'] });
  assert.deepEqual(leaks(block), []);
  assert.equal(name, 'post-login-2');
  assert.match(block, /^### POST \/login\n# from Lookout at 2026-11-03T10:00:00Z, where it answered 200\n/);
  assert.match(block, /\n# @name post-login-2\nPOST https:\/\/api\.test\/login\?access_token=\{\{access_token\}\}&page=2\n/);
  assert.match(block, /\nAuthorization: Bearer \{\{token\}\}\n/);
  assert.match(block, /\nCookie: \{\{cookie\}\}\n/);
  assert.match(block, /\nX-Api-Key: \{\{apiKey\}\}\n/);
  assert.match(block, /"password": "\{\{password\}\}"/);
  assert.match(block, /"client_secret": "\{\{client_secret\}\}"/);
  assert.match(block, /"note": "\{\{note\}\}"|my token is \{\{secret\}\}/);
  assert.doesNotMatch(block, /^Host:/m);
  assert.ok(variables.includes('token') && variables.includes('cookie') && variables.includes('password'));
  assert.match(block, /# fill in .*\{\{token\}\}/);
  // The same token in the URL and the header is two variables only when the names differ.
  assert.equal(variables.filter((v) => v === 'token').length, 1);
  const file = appendBlock('### GET /a\nGET https://a.test/\n# @name get-a', block);
  assert.deepEqual(namesIn(file), ['get-a', 'post-login-2']);
  assert.match(file, /# @name get-a\n\n### POST/);
});

test("the request context for Hail's /take carries no credential either", () => {
  const data = requestContext(login());
  const line = takeLine('request', data);
  const back = contextIn(line);
  assert.equal(back.kind, 'request');
  assert.deepEqual(leaks(JSON.stringify(back.data)), []);
  assert.equal(back.data.method, 'POST');
  assert.equal(back.data.app, 'lookout');
  assert.equal(back.data.headers.Authorization, 'Bearer {{token}}');
  assert.equal(back.data.response.status, 200);
  assert.ok(decodeContext(line.replace(/^\/take /, '')));
});

test('a HAR export masks credentials unless asked, and reads back the same requests', () => {
  const list = [login(), ex({ url: 'http://plain.test/a.csv', resHeaders: [['Content-Type', 'text/csv']], resBody: 'a,b\n1,2\n' }), { ...ex(), kind: 'tunnel' }];
  const masked = JSON.stringify(toHar(list, { version: '1.0.0' }));
  assert.deepEqual(leaks(masked), []);
  const har = toHar(list, { version: '1.0.0', secrets: true });
  assert.equal(har.log.creator.name, 'Lookout');
  assert.equal(har.log.entries.length, 2, 'the tunnel has no request to write');
  const back = fromHar(JSON.stringify(har));
  assert.equal(back.length, 2);
  const [a, b] = back;
  assert.equal(a.method, 'POST');
  assert.equal(a.url, list[0].url);
  assert.equal(a.host, 'api.test');
  assert.deepEqual(a.request.headers, list[0].request.headers);
  assert.equal(a.request.body.toString(), list[0].request.body.toString());
  assert.equal(a.response.status, 200);
  assert.deepEqual(a.response.headers, list[0].response.headers);
  assert.equal(a.response.body.toString(), list[0].response.body.toString());
  assert.equal(a.timings.end - a.timings.start, 50);
  assert.equal(b.response.body.toString(), 'a,b\n1,2\n');
  assert.throws(() => fromHar('{"nope":1}'), /isn't a HAR file/);
  assert.throws(() => fromHar('not json'), /isn't a HAR file/);
});

test('the filter: host:, status:, method: and words, never finding what is hidden', () => {
  const list = demoExchanges();
  assert.deepEqual(parseFilter('host:shop status:5xx login'), { host: ['shop'], status: ['5xx'], method: [], words: ['login'] });
  assert.equal(filtered(list, 'status:5xx').length, 1);
  assert.equal(filtered(list, 'status:refused').length, 1);
  assert.equal(filtered(list, 'status:error').length, 2);
  assert.equal(filtered(list, 'method:post').length, 2);
  assert.ok(filtered(list, 'host:cdn.shop.test').every((e) => e.host === 'cdn.shop.test'));
  assert.equal(filtered(list, 'leave at the door').length, 1, 'bodies are searched');
  assert.equal(filtered(list, 'hunter2').length, 0, 'what is hidden is not searchable');
  assert.equal(filtered(list, '').length, list.length);
  assert.equal(hosts(list)[0].host, 'api.shop.test');
});

test('the activity log hears counts and host names only', () => {
  const line = capturedLine(demoExchanges());
  assert.match(line, /^captured \d+ requests to api\.shop\.test and \d+ to \d+ other hosts$/);
  assert.equal(capturedLine([]), null);
});

test('what the traffic says: tokens and cookies over plain HTTP, cookies without Secure, credentials in the query', () => {
  const plain = ex({ method: 'POST', url: 'http://api.test/login?api_key=k-123456789', reqHeaders: [['Authorization', 'Basic YWxhZGRpbjpvcGVu'], ['Cookie', 'session=abc'], ['Content-Type', 'application/x-www-form-urlencoded']], reqBody: 'user=a&password=hunter2hunter2', resHeaders: [['Set-Cookie', 'session=zzz; Path=/'], ['Set-Cookie', 'pref=1; Secure']] });
  const found = trafficFindings([plain, plain, ex({ url: 'https://api.test/x?token=abc' }), ex({ url: 'http://localhost:3000/me', reqHeaders: [['Authorization', 'Bearer x']] })]);
  const rules = found.map((f) => `${f.rule}:${f.severity}:${f.host}`).sort();
  assert.deepEqual(rules, [
    'cookie-not-httponly:low:api.test',
    'cookie-not-secure:medium:api.test',
    'cookie-over-http:high:api.test',
    'credentials-in-query:high:api.test',
    'credentials-in-query:medium:api.test',
    'secret-in-body-over-http:high:api.test',
    'token-over-http:high:api.test',
    'token-over-http:medium:localhost',
  ]);
  assert.equal(found.find((f) => f.rule === 'token-over-http' && f.host === 'api.test').count, 2, 'one finding, seen twice');
  // Where is the URL without its query; nothing of a credential's value anywhere.
  assert.ok(found.every((f) => !f.where.includes('?')));
  assert.deepEqual(leaks(JSON.stringify(found)), []);
  assert.doesNotMatch(JSON.stringify(found), /YWxhZGRpbjpvcGVu|hunter2/);
});
