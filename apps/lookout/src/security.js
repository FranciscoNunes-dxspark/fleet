// What captured traffic says about the security of the apps that sent it, as the kit's findings.js
// findings: credentials sent over plain HTTP, cookies set without Secure (or a session's without
// HttpOnly), credentials in a URL's query. Each finding says where (scheme, host and path, never the
// query, which may hold the very secret) and which header, cookie or parameter, never its value.
// For the Security view, `lookout security` and Fleet's overview. Pure.
import { toSarif } from '@fleet/kit/findings.js';
import { bodyText, header, headerAll, mediaType } from './exchange.js';
import { decodeURIComponentSafe, isSecretHeader, isSecretParam, secretsIn } from './redact.js';

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|::1|\[::1\])$|\.localhost$/i;
/** Plain HTTP to this machine never crosses a network: what's found there is a step milder. */
const milder = (severity, host) => (LOOPBACK.test(host) ? { critical: 'high', high: 'medium', medium: 'low' }[severity] ?? severity : severity);

/** Where a finding is: the request's scheme, host and path, without its query. */
const whereOf = (ex) => `${ex.scheme}://${ex.host}${ex.port && ex.port !== (ex.scheme === 'https' ? 443 : 80) ? `:${ex.port}` : ''}${String(ex.path || '/').replace(/[?#].*$/, '')}`;

const SESSIONISH = /sess|sid|auth|token|login|jwt|remember/i;

/** One exchange's findings. */
function findingsOf(ex) {
  if (ex.kind !== 'http') return [];
  const out = [];
  const where = whereOf(ex);
  const add = ({ plain: overHttp, ...f }) => out.push({ where, kind: 'traffic', host: ex.host, ...f, severity: overHttp ? milder(f.severity, ex.host) : f.severity });
  const plain = ex.scheme === 'http';
  const headers = ex.request.headers ?? [];

  if (plain) {
    for (const [name] of headers) {
      const n = name.toLowerCase();
      if (n === 'cookie' || n === 'proxy-authorization') continue;
      if (n === 'authorization' || isSecretHeader(name)) {
        add({ rule: 'token-over-http', severity: 'high', plain, title: `${name} sent over plain HTTP`, excerpt: `${name}: (hidden)`, why: 'Anyone on the network between the client and the server reads the credential and can use it.', fix: 'Send it over HTTPS only; make the server redirect HTTP to HTTPS and set Strict-Transport-Security.' });
      }
    }
    if (header(headers, 'cookie')) {
      const names = String(header(headers, 'cookie')).split(/;\s*/).map((c) => c.split('=')[0]).filter(Boolean);
      add({ rule: 'cookie-over-http', severity: names.some((c) => SESSIONISH.test(c)) ? 'high' : 'medium', plain, title: `Cookies sent over plain HTTP (${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''})`, excerpt: `Cookie: ${names.join(', ')}`, why: 'A cookie sent in the clear can be read on the way and replayed: a session cookie is the session.', fix: 'Serve the site over HTTPS only and mark the cookies Secure, so the browser never sends them over HTTP.' });
    }
    const text = ex.request.size ? bodyText(ex.request) : null;
    if (text) {
      const type = mediaType(ex.request);
      const fields = new Set();
      if (/json/.test(type) || /^\s*[[{]/.test(text)) {
        try {
          const walk = (v) => {
            if (Array.isArray(v)) return v.forEach(walk);
            if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (isSecretParam(k) && x !== '' && x != null ? fields.add(k) : walk(x));
          };
          walk(JSON.parse(text));
        } catch {}
      } else if (/x-www-form-urlencoded/.test(type)) {
        for (const part of text.split('&')) {
          const [k, v] = part.split('=');
          if (v && isSecretParam(decodeURIComponentSafe(k))) fields.add(decodeURIComponentSafe(k));
        }
      }
      if (fields.size || secretsIn(text).length) {
        add({ rule: 'secret-in-body-over-http', severity: 'high', plain, title: `Credentials in a request body over plain HTTP${fields.size ? ` (${[...fields].slice(0, 4).join(', ')})` : ''}`, excerpt: fields.size ? `fields ${[...fields].join(', ')}` : 'a value that looks like a key or token', why: 'A password or token in the body travels in the clear, for anyone on the network to read.', fix: 'Send it over HTTPS only.' });
      }
    }
  }

  // Credentials in the query: they end up in logs, history and Referer headers, even over HTTPS.
  const q = String(ex.path ?? '').indexOf('?');
  if (q >= 0) {
    const names = [];
    for (const part of ex.path.slice(q + 1).split('&')) {
      const at = part.indexOf('=');
      if (at < 0 || !part.slice(at + 1)) continue;
      const name = decodeURIComponentSafe(part.slice(0, at));
      if (isSecretParam(name) || secretsIn(decodeURIComponentSafe(part.slice(at + 1))).length) names.push(name);
    }
    if (names.length) {
      add({ rule: 'credentials-in-query', severity: plain ? 'high' : 'medium', plain, title: `Credentials in the query string (${names.slice(0, 4).join(', ')})`, excerpt: `?${names.map((n) => `${n}=…`).join('&')}`, why: "A URL is written to server and proxy logs, the browser's history and the Referer header sent to other sites: a credential in it leaks there.", fix: 'Send it in a header (Authorization) or the body of a POST instead.' });
    }
  }

  // Cookies the server sets: without Secure the browser sends them over plain HTTP too.
  for (const sc of headerAll(ex.response?.headers, 'set-cookie')) {
    const [first, ...attrs] = String(sc).split(/;\s*/);
    const name = first.split('=')[0];
    const has = (a) => attrs.some((x) => x.toLowerCase().split('=')[0].trim() === a);
    if (!has('secure') && !LOOPBACK.test(ex.host)) {
      add({ rule: 'cookie-not-secure', severity: SESSIONISH.test(name) ? 'medium' : 'low', title: `Cookie ${name} set without Secure`, excerpt: `Set-Cookie: ${name}=…; ${attrs.join('; ')}`.replace(/; $/, ''), why: 'Without Secure, the browser also sends the cookie over plain HTTP, where it can be read on the way.', fix: `Add Secure to ${name} (and serve the site over HTTPS only).` });
    }
    if (SESSIONISH.test(name) && !has('httponly')) {
      add({ rule: 'cookie-not-httponly', severity: 'low', title: `Session cookie ${name} readable by scripts`, excerpt: `Set-Cookie: ${name}=…; ${attrs.join('; ')}`.replace(/; $/, ''), why: 'Without HttpOnly, any script on the page (an injected one too) can read the session cookie and send it away.', fix: `Add HttpOnly to ${name}.` });
    }
  }
  return out;
}

// An exchange's findings, worked out once it's finished: the views ask again as traffic comes in.
const cache = new WeakMap();
function cachedFindingsOf(ex) {
  if (ex.state === 'open') return findingsOf(ex);
  let found = cache.get(ex);
  if (!found) cache.set(ex, (found = findingsOf(ex)));
  return found;
}

/**
 * Every finding in the captured exchanges, one per rule, place and header/cookie/parameter: a token
 * sent a hundred times to the same endpoint is one finding, with `count`.
 */
export function trafficFindings(list) {
  const by = new Map();
  for (const ex of list) {
    for (const f of cachedFindingsOf(ex)) {
      const key = `${f.rule}|${f.where}|${f.title}`;
      const was = by.get(key);
      if (was) was.count++;
      else by.set(key, { ...f, count: 1 });
    }
  }
  return [...by.values()];
}

/** SARIF from the findings, for code scanning (their `where` is a URL, so it points at the repository's root). */
export const sarifOf = (findings, version) => toSarif({ tool: 'Lookout', version, uri: 'https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/lookout', findings });
