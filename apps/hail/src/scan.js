// /scan and `hail security`: a look at a web app you own (or may test) from the outside, the way an
// attacker's first pass would, with every answer judged into findings (the kit's findings.js shape):
// TLS and its certificate, the security headers, cookies' flags, CORS, files that shouldn't be served,
// TRACE, verbose errors, and the file's requests that answer without their credentials.
//
// The judges are pure and take what came back; `runScan` sends (send.js's send, a TRACE through
// node:http, a TLS handshake through node:tls) and hands each answer to them. It only sends GET, HEAD,
// OPTIONS and one TRACE, a fixed number of them under a cap, a few at a time, and stops when its
// signal does. What it keeps as evidence never holds a credential: headers that carry one are
// history.js's, hidden; the secrets a request filled in are blanked; secret-looking values are masked.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { countFindings, findingsLine, sortFindings } from '@fleet/kit/findings.js';
import { blank, isCredentialHeader } from './history.js';
import { send as sendRequest } from './send.js';
import { proxyFor, tunnel } from './transport.js';

// At most this many HTTP requests in one scan (the TLS handshakes aren't counted).
export const SCAN_CAP = 80;
// How many at a time, and how long each may take.
export const SCAN_CONCURRENCY = 3;
export const SCAN_TIMEOUT = 8000;
// The file's requests resent without their credentials, at most (each costs two requests).
export const AUTH_MAX = 15;
// The Origin the CORS check sends: a site that is nobody's.
export const EVIL_ORIGIN = 'https://evil.example';
const AGENT = 'Hail security scan';
const HIDDEN = '••••••';

// ---------------------------------------------------------------------------------------------------
// Small things the judges share.

/** The first value of header `name` in [[name, value]], or undefined. */
export const headerValue = (headers, name) => (headers ?? []).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
/** Every value of header `name`. */
const headerValues = (headers, name) => (headers ?? []).filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v);

const SECRETISH = /((?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|connection[_-]?string|credential|auth(?:orization)?)[\w.-]*["']?\s*[:=]\s*["']?)([^\s"',;&<]{3,})/gi;

/**
 * Text as evidence: `secrets` blanked, values after secret-looking names masked, whitespace run
 * together, at most `max` characters.
 */
export function excerpt(text, { secrets = [], max = 200 } = {}) {
  const t = blank(String(text ?? ''), secrets).replace(SECRETISH, `$1${HIDDEN}`).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A dotenv file as evidence: its names only, each value masked. */
const envExcerpt = (text) =>
  excerpt(
    String(text ?? '')
      .split(/\r?\n/)
      .filter((l) => /^\s*(export\s+)?[A-Za-z_][\w.]*\s*=/.test(l))
      .slice(0, 6)
      .map((l) => `${l.split('=')[0].trim()}=${HIDDEN}`)
      .join(' '),
  );

/** "Name: value" as evidence, the value hidden when the header carries a credential. */
const headerLine = (name, value) => `${name}: ${isCredentialHeader(name) && !/^set-cookie$/i.test(name) ? HIDDEN : value}`;

const isHtml = (res) => /html/i.test(headerValue(res?.headers, 'content-type') ?? '') || /^\s*<(!doctype|html)/i.test(res?.body ?? '');
const ok2xx = (res) => res && res.status >= 200 && res.status < 300;
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const pathOf = (url) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

/** A finding with the evidence /scan shows on ↵: the request, its status, the header seen. */
const finding = (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== ''));

// ---------------------------------------------------------------------------------------------------
// TLS.

/**
 * What a TLS probe found (`probeTls`'s { protocol, validTo, selfSigned, authorizationError,
 * hostnameError, legacy: { TLSv1, 'TLSv1.1' }, error }) as findings, for `where` (the host).
 */
export function judgeTls(info, { where, now = new Date() } = {}) {
  if (!info) return [];
  if (info.error) return [finding({ rule: 'tls-unchecked', severity: 'unknown', title: "Couldn't check TLS", where, why: info.error })];
  const out = [];
  if (info.protocol && /^TLSv1(\.1)?$/.test(info.protocol)) {
    out.push(finding({ rule: 'tls-old-negotiated', severity: 'high', title: `Negotiates ${tlsName(info.protocol)}`, where, header: `Negotiated: ${tlsName(info.protocol)}`, why: 'TLS 1.0 and 1.1 have known weaknesses and every browser has dropped them.', fix: 'Accept TLS 1.2 and 1.3 only.' }));
  }
  for (const [v, rule] of [['TLSv1', 'tls-1.0-accepted'], ['TLSv1.1', 'tls-1.1-accepted']]) {
    if (info.legacy?.[v] === true) out.push(finding({ rule, severity: 'medium', title: `Accepts ${tlsName(v)}`, where, header: `A ${tlsName(v)}-only handshake succeeded`, why: `${tlsName(v)} is deprecated (RFC 8996) and weaker than 1.2.`, fix: 'Set the minimum TLS version to 1.2 on the server or load balancer.' }));
  }
  if (info.validTo) {
    const days = Math.floor((new Date(info.validTo) - now) / 86_400_000);
    const at = new Date(info.validTo).toISOString().slice(0, 10);
    if (days < 0) out.push(finding({ rule: 'cert-expired', severity: 'critical', title: 'The certificate has expired', where, header: `Not after: ${at}`, why: 'Browsers refuse the site, and clients that skip the check are open to interception.', fix: 'Renew the certificate (and automate it).' }));
    else if (days < 30) out.push(finding({ rule: 'cert-expiring', severity: days < 7 ? 'high' : 'medium', title: `The certificate expires in ${days} day${days === 1 ? '' : 's'}`, where, header: `Not after: ${at}`, why: 'Once it expires, browsers refuse the site.', fix: 'Renew the certificate (and automate it).' }));
  }
  if (info.hostnameError) out.push(finding({ rule: 'cert-hostname-mismatch', severity: 'high', title: "The certificate doesn't name this host", where, header: info.hostnameError, why: 'Browsers refuse it; clients told to ignore it are open to interception.', fix: 'Serve a certificate whose names include this host.' }));
  if (info.selfSigned) out.push(finding({ rule: 'cert-self-signed', severity: 'high', title: 'The certificate is self-signed', where, header: info.authorizationError ?? 'Issuer is the subject', why: 'Nothing vouches for it, so browsers refuse it and a man in the middle can present their own.', fix: "Use a certificate from a trusted CA (Let's Encrypt, your cloud's)." }));
  else if (info.authorizationError && !info.hostnameError && !/EXPIRED/.test(info.authorizationError)) {
    out.push(finding({ rule: 'cert-untrusted', severity: 'high', title: "The certificate isn't trusted", where, header: info.authorizationError, why: "Its chain doesn't lead to a trusted CA (an intermediate missing, or a private CA).", fix: 'Serve the full chain from a trusted CA.' }));
  }
  return out;
}

const tlsName = (v) => ({ TLSv1: 'TLS 1.0', 'TLSv1.1': 'TLS 1.1', 'TLSv1.2': 'TLS 1.2', 'TLSv1.3': 'TLS 1.3' })[v] ?? v;

/** A plain socket to `host:port`, through the proxy when `env` names one for `url` (a CONNECT tunnel). */
function rawSocket(url, { env, timeout }) {
  const u = new URL(url);
  const port = Number(u.port) || 443;
  const proxy = proxyFor(url, env);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${u.host} didn't answer within ${timeout / 1000} s`)), timeout);
    const done = (e, s) => {
      clearTimeout(timer);
      if (e) reject(e);
      else resolve(s);
    };
    if (proxy) return tunnel(proxy)({ hostname: u.hostname.replace(/^\[|\]$/g, ''), port, protocol: 'http:' }, done);
    const s = net.connect({ host: u.hostname.replace(/^\[|\]$/g, ''), port });
    s.once('connect', () => done(null, s));
    s.once('error', (e) => done(e));
  });
}

/** One TLS handshake with `opts` over a fresh socket: the TLS socket once it's up (the caller ends it). */
async function handshake(url, opts, { env, timeout }) {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const socket = await rawSocket(url, { env, timeout });
  return new Promise((resolve, reject) => {
    let s;
    const timer = setTimeout(() => {
      s?.destroy();
      socket.destroy();
      reject(new Error(`${u.host} didn't finish the TLS handshake within ${timeout / 1000} s`));
    }, timeout);
    try {
      s = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'], ...opts });
    } catch (e) {
      clearTimeout(timer);
      socket.destroy();
      return reject(e);
    }
    s.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once('error', (e) => {
      clearTimeout(timer);
      socket.destroy();
      reject(e);
    });
  });
}

/**
 * The TLS side of an https `url`: the protocol negotiated, the certificate's end, whether it's
 * self-signed, trusted and names the host, and whether TLS 1.0 and 1.1 alone are accepted (null when
 * this runtime can't offer them). { error } when no handshake works at all.
 */
export async function probeTls(url, { env = process.env, timeout = SCAN_TIMEOUT } = {}) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  let info;
  try {
    const s = await handshake(url, {}, { env, timeout });
    const cert = s.getPeerCertificate(true);
    const identity = cert && Object.keys(cert).length ? tls.checkServerIdentity(host, cert) : null;
    info = {
      protocol: s.getProtocol(),
      authorized: s.authorized,
      authorizationError: s.authorizationError ? String(s.authorizationError.code ?? s.authorizationError) : null,
      validTo: cert?.valid_to ? new Date(cert.valid_to).toISOString() : null,
      subject: cert?.subject?.CN ?? null,
      issuer: cert?.issuer?.CN ?? null,
      selfSigned: Boolean(cert?.fingerprint256 && cert.issuerCertificate?.fingerprint256 === cert.fingerprint256) || /SELF_SIGNED/.test(String(s.authorizationError ?? '')),
      hostnameError: identity ? identity.reason ?? identity.message : null,
      legacy: {},
    };
    s.end();
    s.destroy();
  } catch (e) {
    return { error: e.message };
  }
  for (const v of ['TLSv1', 'TLSv1.1']) {
    try {
      // OpenSSL 3 won't offer 1.0 or 1.1 at its default security level; level 0 lets it ask.
      const s = await handshake(url, { minVersion: v, maxVersion: v, ciphers: 'DEFAULT:@SECLEVEL=0' }, { env, timeout });
      info.legacy[v] = s.getProtocol() === v;
      s.destroy();
    } catch (e) {
      // This runtime can't offer it at all (rather than the server refusing it): unknown.
      info.legacy[v] = /ERR_TLS_INVALID_PROTOCOL|no protocols available|unsupported protocol/i.test(`${e.code} ${e.message}`) && !/alert/i.test(e.message) ? null : false;
    }
  }
  return info;
}

// ---------------------------------------------------------------------------------------------------
// The main response: redirects to https, security headers, what the server says it is, cookies.

/** An http:// target that answers without sending you to https. */
export function judgeHttpsRedirect(res, { where }) {
  if (!res) return [];
  const location = headerValue(res.headers, 'location') ?? '';
  if (res.status >= 300 && res.status < 400 && /^https:\/\//i.test(new URL(location, where).href)) return [];
  return [finding({ rule: 'http-no-https-redirect', severity: 'high', title: "Plain http isn't sent to https", where, request: `GET ${pathOf(where)}`, status: res.status, header: location ? headerLine('Location', location) : undefined, why: 'Anything sent over http, cookies and credentials included, can be read and changed on the way.', fix: 'Answer every http request with a 301 to the same URL over https (and send HSTS there).' })];
}

/** The security headers a page (or an API's response) should carry, and what the server gives away. */
export function judgeHeaders(res, { where, https: secure }) {
  if (!res) return [];
  const h = (n) => headerValue(res.headers, n);
  const html = isHtml(res);
  const base = { where, request: `GET ${pathOf(where)}`, status: res.status };
  const out = [];
  const hsts = h('strict-transport-security');
  if (secure && !hsts) out.push(finding({ ...base, rule: 'hsts-missing', severity: 'medium', title: 'No Strict-Transport-Security', why: 'A first visit over http, or a downgrade on the way, can be intercepted before the browser reaches https.', fix: 'Strict-Transport-Security: max-age=31536000; includeSubDomains' }));
  else if (secure) {
    const age = Number(/max-age\s*=\s*"?(\d+)/i.exec(hsts)?.[1] ?? 0);
    if (age < 15_552_000) out.push(finding({ ...base, rule: 'hsts-short', severity: 'low', title: 'Strict-Transport-Security lasts under 180 days', header: headerLine('Strict-Transport-Security', hsts), why: 'A short max-age leaves returning visitors open to a downgrade sooner.', fix: 'max-age=31536000 (a year) or more.' }));
  }
  const csp = h('content-security-policy');
  if (!csp) out.push(finding({ ...base, rule: 'csp-missing', severity: html ? 'medium' : 'low', title: 'No Content-Security-Policy', why: html ? "Without one, an injected script runs with the page's full rights." : 'A JSON response rendered as a page (an error, an old browser) has no limits on what runs.', fix: html ? "Start from Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; object-src 'none'" : "Content-Security-Policy: default-src 'none'; frame-ancestors 'none' on API responses." }));
  if (!/nosniff/i.test(h('x-content-type-options') ?? '')) out.push(finding({ ...base, rule: 'xcto-missing', severity: 'low', title: 'No X-Content-Type-Options: nosniff', why: 'Browsers may guess a response is a script or a page from its content.', fix: 'X-Content-Type-Options: nosniff' }));
  if (!h('x-frame-options') && !/frame-ancestors/i.test(csp ?? '')) out.push(finding({ ...base, rule: 'framing-allowed', severity: html ? 'medium' : 'low', title: 'Any site can frame it', why: 'Neither X-Frame-Options nor CSP frame-ancestors is set, so it can be framed for clickjacking.', fix: "Content-Security-Policy: frame-ancestors 'none' (or X-Frame-Options: DENY)." }));
  if (!h('referrer-policy')) out.push(finding({ ...base, rule: 'referrer-policy-missing', severity: 'low', title: 'No Referrer-Policy', why: 'Links to other sites may carry full URLs, query strings included.', fix: 'Referrer-Policy: strict-origin-when-cross-origin (or no-referrer).' }));
  const server = h('server');
  if (server && /\d/.test(server)) out.push(finding({ ...base, rule: 'server-version', severity: 'low', title: 'Server says its version', header: headerLine('Server', server), why: 'A version tells an attacker which known vulnerabilities to try.', fix: 'Send Server without a version, or not at all.' }));
  for (const name of ['X-Powered-By', 'X-AspNet-Version', 'X-AspNetMvc-Version']) {
    const v = h(name);
    if (v) out.push(finding({ ...base, rule: 'powered-by', severity: 'low', title: `${name} says what it runs on`, header: headerLine(name, v), why: 'The framework (and its version) tells an attacker what to try.', fix: `Stop sending ${name} (app.disable('x-powered-by'), removing it in web.config and the like).` }));
  }
  return out;
}

/** A Set-Cookie value as { name, attrs: Set of lower-case attribute names, sameSite }. */
export function parseSetCookie(value) {
  const [pair, ...rest] = String(value).split(';');
  const attrs = new Map(rest.map((a) => a.trim()).filter(Boolean).map((a) => {
    const i = a.indexOf('=');
    return i < 0 ? [a.toLowerCase(), ''] : [a.slice(0, i).trim().toLowerCase(), a.slice(i + 1).trim()];
  }));
  return { name: pair.split('=')[0].trim(), attrs, sameSite: attrs.get('samesite') ?? null };
}

// Names that look like a session or a sign-in: the cookies that must be HttpOnly.
const SESSIONISH = /sess|sid$|^sid|auth|token|jwt|login|remember|identity|^connect\.sid$|^phpsessid$|^jsessionid$|^asp\.net_sessionid$|^\.aspnetcore\.|^__host-|^__secure-/i;

/** Each cookie set without Secure (over https), HttpOnly (a session's) or SameSite. */
export function judgeCookies(res, { where, https: secure }) {
  const out = [];
  for (const raw of headerValues(res?.headers, 'set-cookie')) {
    const c = parseSetCookie(raw);
    if (!c.name) continue;
    // The cookie's name and its flags, never its value.
    const header = `Set-Cookie: ${c.name}=${HIDDEN}${[...c.attrs].map(([k, v]) => `; ${k}${v ? `=${v}` : ''}`).join('')}`;
    const base = { where, request: `GET ${pathOf(where)}`, status: res.status, header, cookie: c.name };
    if (secure && !c.attrs.has('secure')) out.push(finding({ ...base, rule: 'cookie-not-secure', severity: 'medium', title: `Cookie ${c.name} isn't Secure`, why: 'Without Secure, the browser also sends it over plain http, where it can be read.', fix: `Set-Cookie: ${c.name}=…; Secure` }));
    if (SESSIONISH.test(c.name) && !c.attrs.has('httponly')) out.push(finding({ ...base, rule: 'cookie-not-httponly', severity: 'medium', title: `Session cookie ${c.name} isn't HttpOnly`, why: 'Any script on the page (an injected one too) can read it and take the session.', fix: `Set-Cookie: ${c.name}=…; HttpOnly` }));
    if (!c.sameSite) out.push(finding({ ...base, rule: 'cookie-no-samesite', severity: 'low', title: `Cookie ${c.name} has no SameSite`, why: "Browsers' default (Lax) varies; saying it makes cross-site requests' behaviour certain.", fix: `Set-Cookie: ${c.name}=…; SameSite=Lax (or Strict)` }));
    else if (/^none$/i.test(c.sameSite) && !c.attrs.has('secure')) out.push(finding({ ...base, rule: 'cookie-samesite-none-insecure', severity: 'medium', title: `Cookie ${c.name} is SameSite=None without Secure`, why: 'Browsers reject SameSite=None without Secure, and it goes on every cross-site request.', fix: `Set-Cookie: ${c.name}=…; SameSite=None; Secure, or SameSite=Lax` }));
  }
  return out;
}

/** The answer to a request sent with Origin: EVIL_ORIGIN: an origin let in that shouldn't be. */
export function judgeCors(res, { where, origin = EVIL_ORIGIN }) {
  if (!res) return [];
  const allow = headerValue(res.headers, 'access-control-allow-origin');
  if (!allow) return [];
  const creds = /^true$/i.test(headerValue(res.headers, 'access-control-allow-credentials') ?? '');
  const header = [headerLine('Access-Control-Allow-Origin', allow), creds ? 'Access-Control-Allow-Credentials: true' : ''].filter(Boolean).join(' · ');
  const base = { where, request: `GET ${pathOf(where)} with Origin: ${origin}`, status: res.status, header };
  if (allow.trim() === origin) {
    return [creds
      ? finding({ ...base, rule: 'cors-reflected-credentials', severity: 'high', title: 'CORS lets any site read it, signed in', why: 'The Origin sent is echoed back with credentials allowed: any site a signed-in user visits can read these responses as them.', fix: 'Allow a fixed list of origins, and credentials only for those.' })
      : finding({ ...base, rule: 'cors-reflected', severity: 'medium', title: 'CORS echoes any Origin', why: "Any site can read these responses from a visitor's browser (without their cookies).", fix: 'Allow a fixed list of origins rather than echoing the one asked.' })];
  }
  if (allow.trim() === 'null' && creds) return [finding({ ...base, rule: 'cors-null-credentials', severity: 'high', title: 'CORS lets the null origin in, signed in', why: 'Sandboxed frames and local files have the null origin, which any site can use.', fix: 'Never allow the null origin.' })];
  if (allow.trim() === '*' && creds) return [finding({ ...base, rule: 'cors-wildcard-credentials', severity: 'medium', title: 'CORS allows * with credentials', why: 'Browsers refuse the pair, so it is a mistake in the CORS set-up that a change could make dangerous.', fix: 'Name the origins allowed, or drop Allow-Credentials.' })];
  return [];
}

// ---------------------------------------------------------------------------------------------------
// Files and endpoints that shouldn't be served.

const startsWithBytes = (res, bytes) => Boolean(res?.raw && Buffer.from(res.raw).subarray(0, bytes.length).equals(Buffer.from(bytes)));
const bodyHas = (re) => (res) => re.test(res.body ?? '');
const jsonWith = (keys) => (res) => {
  try {
    const j = JSON.parse(res.body);
    return Boolean(j) && typeof j === 'object' && keys.some((k) => k in j);
  } catch {
    return false;
  }
};

/**
 * The paths asked for, each with how its content is recognised (`looks`), so a site that answers
 * everything with 200 and its index page (a SPA) isn't taken for one serving them. `absent` turns it
 * around: the finding is that it's missing.
 */
export const EXPOSED = [
  { path: '/.git/HEAD', rule: 'exposed-git', severity: 'high', title: 'The .git folder is served', looks: (r) => /^(ref: refs\/|[0-9a-f]{40}\s*$)/.test(r.body ?? ''), why: 'The whole repository (code, history, secrets ever committed) can be downloaded.', fix: 'Deploy without .git, or deny every path under /.git.' },
  { path: '/.env', rule: 'exposed-env', severity: 'critical', title: 'A .env file is served', looks: (r) => !/^\s*</.test(r.body ?? '') && /^\s*(export\s+)?[A-Za-z_][\w.]*\s*=/m.test(r.body ?? ''), excerpt: (r) => envExcerpt(r.body), why: 'Its settings, connection strings and keys among them, are readable by anyone.', fix: 'Keep .env out of what is served (and rotate what was in it).' },
  { path: '/.DS_Store', rule: 'exposed-ds-store', severity: 'low', title: 'A .DS_Store file is served', looks: (r) => startsWithBytes(r, [0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31]), why: "It lists the folder's files, hidden ones too.", fix: 'Deploy without .DS_Store files, or deny them.' },
  { path: '/server-status', rule: 'exposed-server-status', severity: 'medium', title: "Apache's server-status is public", looks: bodyHas(/Apache Server Status|Server uptime|Total accesses/i), why: 'It shows the requests being served, client addresses and URLs included.', fix: 'Allow /server-status from localhost only.' },
  { path: '/actuator/env', rule: 'exposed-actuator', severity: 'high', title: "Spring Boot's /actuator/env is public", looks: jsonWith(['propertySources', 'activeProfiles']), why: "The application's configuration, sometimes with credentials, is readable.", fix: 'Expose actuator endpoints only on a management port, behind authentication.' },
  { path: '/swagger', rule: 'exposed-api-docs', severity: 'low', title: 'The API description is public (Swagger UI)', looks: bodyHas(/swagger-ui|Swagger UI/i), why: 'Every endpoint and its parameters is listed for anyone; fine for a public API, not for an internal one.', fix: 'Serve the docs only where they are meant to be read (or behind sign-in).' },
  { path: '/swagger/index.html', rule: 'exposed-api-docs', severity: 'low', title: 'The API description is public (Swagger UI)', looks: bodyHas(/swagger-ui|Swagger UI/i), why: 'Every endpoint and its parameters is listed for anyone; fine for a public API, not for an internal one.', fix: 'Serve the docs only where they are meant to be read (or behind sign-in).' },
  { path: '/openapi.json', rule: 'exposed-api-docs', severity: 'low', title: 'The API description is public (OpenAPI)', looks: jsonWith(['openapi', 'swagger']), why: 'Every endpoint and its parameters is listed for anyone; fine for a public API, not for an internal one.', fix: 'Serve the docs only where they are meant to be read (or behind sign-in).' },
  { path: '/v2/api-docs', rule: 'exposed-api-docs', severity: 'low', title: 'The API description is public (Swagger 2)', looks: jsonWith(['swagger', 'openapi', 'paths']), why: 'Every endpoint and its parameters is listed for anyone; fine for a public API, not for an internal one.', fix: 'Serve the docs only where they are meant to be read (or behind sign-in).' },
  { path: '/phpinfo.php', rule: 'exposed-phpinfo', severity: 'medium', title: 'phpinfo() is public', looks: bodyHas(/phpinfo\(\)|PHP Version \d/i), why: "PHP's configuration, paths and environment variables are readable.", fix: 'Delete phpinfo.php.' },
  { path: '/backup.zip', rule: 'exposed-backup', severity: 'high', title: 'A backup archive is served', looks: (r) => startsWithBytes(r, [0x50, 0x4b, 0x03, 0x04]), excerpt: () => 'A zip archive (PK…)', why: 'Archives left in the web root usually hold the code, configuration or data.', fix: 'Remove backups from what is served.' },
  { path: '/web.config', rule: 'exposed-web-config', severity: 'high', title: 'web.config is served', looks: bodyHas(/<configuration[\s>]/i), why: "IIS's configuration, connection strings and machine keys sometimes in it, is readable.", fix: 'Never serve web.config (IIS refuses it by default: check what serves this).' },
  { path: '/elmah.axd', rule: 'exposed-elmah', severity: 'high', title: 'ELMAH error log is public', looks: bodyHas(/Error Log for|ELMAH/i), why: 'Errors with their requests, cookies and session ids included, are readable by anyone.', fix: 'allowRemoteAccess="false" in ELMAH, or require sign-in for elmah.axd.' },
  { path: '/debug', rule: 'exposed-debug', severity: 'high', title: 'A debug endpoint is public', looks: bodyHas(/debug(ger)?\b.*(console|toolbar|pprof|vars|routes)|pprof|Werkzeug|Django Debug|DEBUG = True|expvar|"memstats"/is), why: 'Debug endpoints show internals and sometimes run code.', fix: 'Turn debug endpoints off in production.' },
  { path: '/console', rule: 'exposed-console', severity: 'high', title: 'A console is public', looks: bodyHas(/Interactive Console|Werkzeug|H2 Console|rails console|web-console|groovy|jolokia/i), why: 'A web console runs code on the server.', fix: 'Turn the console off in production.' },
  { path: '/.well-known/security.txt', rule: 'no-security-txt', severity: 'low', absent: true, title: 'No security.txt', looks: bodyHas(/^\s*Contact:/im), why: 'Whoever finds a vulnerability has nowhere stated to report it (RFC 9116).', fix: 'Serve /.well-known/security.txt with a Contact: and an Expires: line.' },
];

/**
 * Whether `res` is the site's answer to anything (`baseline`, its answer to a random path): a SPA's
 * index page, a catch-all 200. The same status and the same body, or nearly (a path echoed in it).
 */
export function likeBaseline(res, baseline) {
  if (!res || !baseline || res.status !== baseline.status) return false;
  const a = norm(res.body);
  const b = norm(baseline.body);
  if (a === b) return true;
  const type = (r) => (headerValue(r.headers, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
  return type(res) === type(baseline) && Math.abs(a.length - b.length) <= Math.max(64, b.length * 0.05) && similarText(a, b) >= 0.9;
}

/** Of the words in either, the share both have (Jaccard): 1 the same, 0 nothing in common. */
export function similarText(a, b) {
  const words = (s) => new Set(String(s).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean));
  const x = words(a);
  const y = words(b);
  if (!x.size && !y.size) return 1;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** One of EXPOSED (`probe`) asked for at `url`: a finding when it's there (or, for an `absent` one, isn't). */
export function judgeExposed(probe, res, { url, baseline }) {
  const there = Boolean(res && res.status === 200 && !likeBaseline(res, baseline) && probe.looks(res));
  const base = { rule: probe.rule, severity: probe.severity, title: probe.title, where: url, request: `GET ${probe.path}`, status: res?.status, why: probe.why, fix: probe.fix };
  if (probe.absent) return there || !res ? [] : [finding(base)];
  if (!there) return [];
  return [finding({ ...base, excerpt: probe.excerpt ? probe.excerpt(res) : excerpt(res.body, { max: 160 }) })];
}

// ---------------------------------------------------------------------------------------------------
// Methods and errors.

/** OPTIONS's Allow and a TRACE that echoes the request back. */
export function judgeMethods(options, trace, { where }) {
  const out = [];
  const allow = headerValue(options?.headers, 'allow');
  const risky = (allow ?? '').split(/\s*,\s*/).map((m) => m.toUpperCase()).filter((m) => ['TRACE', 'TRACK', 'CONNECT', 'PUT', 'DELETE'].includes(m));
  if (risky.length) out.push(finding({ rule: 'methods-allowed', severity: 'low', title: `OPTIONS lists ${risky.join(', ')}`, where, request: `OPTIONS ${pathOf(where)}`, status: options.status, header: headerLine('Allow', allow), why: 'Methods that change or echo things are on offer at this path; check each needs authentication.', fix: 'Allow only the methods the path serves.' }));
  if (trace && trace.status === 200 && (/message\/http/i.test(headerValue(trace.headers, 'content-type') ?? '') || /^TRACE \//m.test(trace.body ?? ''))) {
    out.push(finding({ rule: 'trace-enabled', severity: 'medium', title: 'TRACE is answered', where, request: `TRACE ${pathOf(where)}`, status: trace.status, excerpt: excerpt(trace.body, { max: 120 }), why: 'TRACE echoes the request, headers included, which with a script injection exposes HttpOnly cookies (cross-site tracing).', fix: 'Turn TRACE off (TraceEnable Off in Apache, a 405 elsewhere).' }));
  }
  return out;
}

// What a stack trace or a framework's debug page looks like.
const STACK = [
  /^\s*at [\w.$<>[\]]+ \(.*:\d+:\d+\)/m, // Node
  /^\s*at [\w$.]+\([\w$]+\.(java|kt|scala):\d+\)/m, // the JVM
  /Traceback \(most recent call last\)/, // Python
  /\b[\w.]+Exception: .*\n\s+at /, // .NET, Java
  /\[\w+Exception: |Exception Details:|Stack Trace:|Server Error in '\/' Application/, // ASP.NET's yellow page
  /Exception in thread "/, // Java
  /Werkzeug Debugger|You're seeing this error because you have <code>DEBUG = True|Django Version:/, // Flask, Django
  /Whoops, looks like something went wrong|Illuminate\\|Symfony\\Component\\/, // Laravel, Symfony
  /(Fatal error|Parse error|Warning): .+ in \/.+ on line \d+/, // PHP
  /ActionController::RoutingError|Rails\.root: /, // Rails
  /goroutine \d+ \[running\]:/, // Go's panic
];

/** A stack trace or a debug page in an error, for `request` ("GET /x"). */
export function judgeVerboseError(res, { where, request, secrets = [] }) {
  if (!res) return [];
  const body = res.body ?? '';
  const re = STACK.find((r) => r.test(body));
  if (!re) return [];
  const at = body.search(re);
  return [finding({ rule: 'verbose-error', severity: 'medium', title: 'Errors show a stack trace', where, request, status: res.status, excerpt: excerpt(body.slice(Math.max(0, at - 40), at + 200), { secrets, max: 200 }), why: 'Stack traces and debug pages give away code paths, versions and sometimes configuration.', fix: 'Show a plain error page in production and log the details instead.' })];
}

// ---------------------------------------------------------------------------------------------------
// Missing authentication: a request of the file that carries a credential, sent again without.

/** The requests of a file that carry a credential header: { request, method, safe }. */
export const authCandidates = (requests = []) =>
  requests
    .filter((r) => !['WEBSOCKET', 'GRPC'].includes(String(r.method).toUpperCase()))
    .filter((r) => (r.headers ?? []).some(([k]) => isCredentialHeader(k)))
    .map((r) => ({ request: r, method: String(r.method ?? 'GET').toUpperCase(), safe: ['GET', 'HEAD', 'OPTIONS'].includes(String(r.method ?? 'GET').toUpperCase()) }));

/** `req`'s headers without the ones carrying credentials, and those names. */
export function withoutCredentials(headers = []) {
  const dropped = [];
  const kept = [];
  for (const [k, v] of headers) {
    if (isCredentialHeader(k)) dropped.push(k);
    else kept.push([k, v]);
  }
  return { headers: kept, dropped };
}

/** Whether two bodies are the same answer: the same text, JSON of the same shape, or nearly the same words. */
export function similarBody(a, b) {
  if (norm(a) === norm(b)) return true;
  let x;
  let y;
  try {
    x = JSON.parse(a);
    y = JSON.parse(b);
  } catch {
    return Math.min(norm(a).length, norm(b).length) / Math.max(1, norm(a).length, norm(b).length) >= 0.8 && similarText(a, b) >= 0.8;
  }
  if (Array.isArray(x) || Array.isArray(y)) return Array.isArray(x) && Array.isArray(y) && (x.length === y.length || (x.length > 0 && y.length > 0));
  if (!x || !y || typeof x !== 'object' || typeof y !== 'object') return x === y;
  const kx = Object.keys(x);
  const ky = new Set(Object.keys(y));
  const both = kx.filter((k) => ky.has(k)).length;
  return both / (kx.length + ky.size - both || 1) >= 0.8;
}

/** A request answered as well without its credentials as with them (`withAuth`, `without`). */
export function judgeMissingAuth({ label, method, url, dropped, withAuth, without, secrets = [] }) {
  if (!ok2xx(withAuth) || !ok2xx(without) || !similarBody(withAuth.body, without.body)) return [];
  return [finding({ rule: 'auth-not-required', severity: 'high', title: `${label} answers without its credentials`, where: blank(url, secrets), request: `${method} ${blank(pathOf(url), secrets)} without ${dropped.join(', ')}`, status: without.status, excerpt: excerpt(without.body, { secrets, max: 160 }), why: `Sent without ${dropped.join(', ')}, it answered ${without.status} with the same kind of body as with ${dropped.length === 1 ? 'it' : 'them'}.`, fix: 'Require authentication on this route (and check the others like it).' })];
}

// ---------------------------------------------------------------------------------------------------
// Sending.

/** "https://host:port/path" from what was typed, or null: a bare host is taken as https; no user or password. */
export function scanUrl(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z][\w+.-]*:\/\//i.test(t) ? t : `https://${t}`);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname) return null;
    u.username = '';
    u.password = '';
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** Whether two URLs reach the same host and port: the file's requests a scan of `b` may resend. */
export const sameHost = (a, b) => {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
};

/** About how many requests a scan of an http(s) target sends, with `auth` of the file's requests checked. */
export const scanEstimate = ({ auth = 0 } = {}) => Math.min(SCAN_CAP, 6 + EXPOSED.length + 2 * Math.min(auth, AUTH_MAX));

/**
 * TRACE through node:http(s): fetch refuses the method. { status, headers, body }, or null when a proxy
 * stands in the way (it isn't sent through one).
 */
export function traceRequest(url, { signal, timeout = SCAN_TIMEOUT, insecure = true, env = process.env } = {}) {
  if (proxyFor(url, env)) return Promise.resolve(null);
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method: 'TRACE', headers: { 'User-Agent': AGENT }, timeout, signal, rejectUnauthorized: !insecure, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size <= 64 * 1024) chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]), body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`${u.host} didn't answer within ${timeout / 1000} s`)));
    req.on('error', reject);
    req.end();
  });
}

/** `n` jobs, `concurrency` at a time, in order of starting; each job's error becomes its result. */
async function pool(jobs, concurrency) {
  const out = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      try {
        out[i] = await jobs[i]();
      } catch (e) {
        out[i] = { error: e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return out;
}

class Stop extends Error {}

/**
 * Scans `target` (an http(s) URL; its origin and path). `auth` are the file's requests to resend
 * without credentials: [{ label, req }] with `req` prepared (send.js), already of the target's host.
 * `send`, `trace` and `probe` are the network (tests run servers rather than stub them). Resolves
 * with { target, findings (worst first), sent, capped, cancelled, notes, tls }; a cancelled or capped
 * scan keeps what it found. Only GET, HEAD, OPTIONS and one TRACE go, besides `auth`'s own methods.
 */
export async function runScan({ target, auth = [], signal, cap = SCAN_CAP, send = sendRequest, trace = traceRequest, probe = probeTls, env = process.env, insecure = false, timeout = SCAN_TIMEOUT, concurrency = SCAN_CONCURRENCY, onProgress, now = new Date(), random = () => randomBytes(6).toString('hex') } = {}) {
  const url = new URL(target);
  url.username = '';
  url.password = '';
  url.hash = '';
  const start = url.href;
  const secure = url.protocol === 'https:';
  const findings = [];
  const notes = [];
  let sent = 0;
  let capped = false;
  const stopped = () => signal?.aborted || capped;
  const add = (list) => findings.push(...list);

  // One request: counted against the cap, never through the cookie jar, a timeout of its own.
  const go = async (method, at, { headers = [], follow = false, req = null, tls: checkCerts = false } = {}) => {
    if (signal?.aborted) throw new Stop('cancelled');
    if (sent >= cap) {
      capped = true;
      throw new Stop('capped');
    }
    sent++;
    onProgress?.(sent);
    const r = req ?? { method, url: at, headers: [['User-Agent', AGENT], ...headers], body: '' };
    try {
      return await send(r, { signal, jar: null, follow, timeout, insecure: checkCerts ? insecure : true, env });
    } catch (e) {
      if (signal?.aborted) throw new Stop('cancelled');
      return { error: e.message.split('\n')[0] };
    }
  };
  const answered = (r) => (r && !r.error ? r : null);

  let tlsInfo = null;
  try {
    // The TLS side alongside the first request.
    const [main, info] = await Promise.all([go('GET', start), secure ? probe(start, { env, timeout }) : null]);
    tlsInfo = info;
    if (info) add(judgeTls(info, { where: url.host, now }));
    if (!answered(main)) throw Object.assign(new Error(`No answer from ${start}: ${main.error}`), { unreachable: true });
    if (!secure) add(judgeHttpsRedirect(main, { where: start }));
    // The headers of where it ends up, when that's still this host (an http one sent to https, a /
    // sent to /login), else of the redirect itself.
    let page = main;
    if (main.status >= 300 && main.status < 400 && headerValue(main.headers, 'location')) {
      const followed = answered(await go('GET', start, { follow: true }));
      if (followed && new URL(followed.url).hostname === url.hostname) page = followed;
    }
    const pageUrl = page.url ?? start;
    const pageSecure = new URL(pageUrl).protocol === 'https:';
    add(judgeHeaders(page, { where: pageUrl, https: pageSecure }));
    add(judgeCookies(main, { where: start, https: secure }));
    if (page !== main) add(judgeCookies(page, { where: pageUrl, https: pageSecure }));
    const origin = new URL(pageUrl).origin;

    add(judgeCors(answered(await go('GET', pageUrl, { headers: [['Origin', EVIL_ORIGIN]] })), { where: pageUrl }));

    // The site's answer to a path that can't exist: what a catch-all looks like, and its error page.
    const nowhere = `${origin}/hail-scan-${random()}`;
    const baseline = answered(await go('GET', nowhere));
    add(judgeVerboseError(baseline, { where: nowhere, request: `GET ${pathOf(nowhere)}` }));
    const odd = new URL(pageUrl);
    odd.search = "?id[]=1'%22&q=%E0%A4%A&page=-1";
    add(judgeVerboseError(answered(await go('GET', odd.href)), { where: odd.href, request: `GET ${pathOf(odd.href)}` }));

    const exposed = await pool(EXPOSED.map((p) => async () => [p, await go('GET', `${origin}${p.path}`)]), concurrency);
    // What came back is judged even when the scan was stopped part way.
    for (const r of exposed) {
      if (r.error) continue;
      const [p, res] = r;
      add(judgeExposed(p, answered(res), { url: `${origin}${p.path}`, baseline }));
    }
    const failed = exposed.find((r) => r.error);
    if (failed) throw failed.error;

    const options = answered(await go('OPTIONS', pageUrl));
    let traced = null;
    if (sent < cap && !signal?.aborted) {
      sent++;
      onProgress?.(sent);
      traced = await trace(pageUrl, { signal, timeout, env }).catch((e) => {
        if (signal?.aborted) throw new Stop('cancelled');
        return null;
      });
      if (traced === null) notes.push('TRACE was not checked (a proxy is in the way, or it got no answer).');
    }
    add(judgeMethods(options, traced, { where: pageUrl }));

    // The file's requests, with their credentials and then without.
    for (const { label, req } of auth.slice(0, AUTH_MAX)) {
      const { headers, dropped } = withoutCredentials(req.headers);
      const withAuth = answered(await go(req.method, req.url, { req, tls: true }));
      if (!ok2xx(withAuth)) {
        notes.push(`${label}: not checked for missing authentication (it answered ${withAuth ? withAuth.status : 'nothing'} with its credentials).`);
        continue;
      }
      const without = answered(await go(req.method, req.url, { req: { ...req, headers }, tls: true }));
      add(judgeMissingAuth({ label, method: req.method, url: req.url, dropped, withAuth, without, secrets: req.secrets ?? [] }));
    }
    if (auth.length > AUTH_MAX) notes.push(`Only the first ${AUTH_MAX} of the file's ${auth.length} requests with credentials were checked.`);
  } catch (e) {
    if (!(e instanceof Stop)) {
      if (e.unreachable) return { target: start, findings: sortFindings(findings), sent, capped, cancelled: false, notes, tls: tlsInfo, error: e.message };
      throw e;
    }
  }
  if (capped) notes.push(`Stopped at the cap of ${cap} requests.`);
  return { target: start, findings: sortFindings(findings), sent, capped, cancelled: Boolean(signal?.aborted), notes, tls: tlsInfo };
}

// ---------------------------------------------------------------------------------------------------
// Showing it.

export const SEVERITY_LABEL = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW', unknown: '?' };

/** A scan's one-line summary: "2 high · 3 medium · 40 requests". */
export const scanSummary = (result) => `${findingsLine(countFindings(result.findings)) || 'Nothing found'} · ${result.sent} request${result.sent === 1 ? '' : 's'}${result.cancelled ? ' · stopped' : result.capped ? ' · capped' : ''}`;

/** One finding as plain text, for y: what, where, the evidence, why and the fix. */
export function findingText(f) {
  return [
    `[${f.severity}] ${f.title} (${f.rule})`,
    `Where: ${f.where}`,
    f.request ? `Request: ${f.request}` : null,
    f.status != null ? `Status: ${f.status}` : null,
    f.header ? `Seen: ${f.header}` : null,
    f.excerpt ? `Excerpt: ${f.excerpt}` : null,
    f.why ? `Why: ${f.why}` : null,
    f.fix ? `Fix: ${f.fix}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

const mdCell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The scan as a Markdown report: the target, the counts, a table, then each finding's evidence. */
export function scanMarkdown(result, { at = new Date(), environment = null } = {}) {
  const lines = [`# Security scan of ${result.target}`, '', `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC${environment ? ` · environment ${environment}` : ''} · ${scanSummary(result)}`, ''];
  if (!result.findings.length) lines.push('Nothing found.', '');
  else {
    lines.push('| Severity | Finding | Where |', '| --- | --- | --- |');
    for (const f of result.findings) lines.push(`| ${f.severity} | ${mdCell(f.title)} (\`${f.rule}\`) | ${mdCell(f.where)} |`);
    lines.push('');
    for (const f of result.findings) {
      lines.push(`## ${mdCell(f.title)}`, '', `**${f.severity}** · \`${f.rule}\` · ${f.where}`, '');
      if (f.request) lines.push(`- Request: \`${f.request}\`${f.status != null ? ` → ${f.status}` : ''}`);
      if (f.header) lines.push(`- Seen: \`${f.header}\``);
      if (f.excerpt) lines.push(`- Excerpt: \`${f.excerpt.replace(/`/g, "'")}\``);
      if (f.why) lines.push(`- Why: ${f.why}`);
      if (f.fix) lines.push(`- Fix: ${f.fix}`);
      lines.push('');
    }
  }
  if (result.notes?.length) lines.push(...result.notes.map((n) => `> ${n}`), '');
  return lines.join('\n');
}
