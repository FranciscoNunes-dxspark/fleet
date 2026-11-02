// Requests from logs: a log line a sibling copied (Bosun's process logs, Sonar's, Wharf's containers')
// that carries a method and a URL, read into a request, and that request as a named block for a .http
// file: its origin as the environment's {{variable}}, no credentials, and where it came from. Pure.
import { hostVariable } from './takes.js';

const METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';
// A method then a URL or a path, as access logs and most frameworks write them: "POST /orders",
// "GET https://api/x", nginx's "GET /x HTTP/1.1" 200.
const IN_TEXT = new RegExp(`(?:^|[\\s"'\\[(=:])(${METHODS})\\s+((?:https?://|/)[^\\s"'<>]*)(?:\\s+HTTP/[\\d.]+)?["']?(?:\\s+(?:-\\s+|→\\s*|->\\s*|status[=:]?\\s*)?([1-5]\\d\\d)\\b)?`, 'i');
const STATUS_KEY = /\bstatus(?:[_ ]?code)?["']?\s*[=:]\s*["']?([1-5]\d\d)\b/i;

// What JSON logs call each part, at the top or under request/req/http (Serilog, pino, ECS, App Insights).
const KEYS = {
  method: ['method', 'httpMethod', 'http_method', 'verb', 'requestMethod', 'request_method'],
  url: ['url', 'uri', 'requestUrl', 'request_url', 'requestUri', 'originalUrl', 'path', 'requestPath', 'target'],
  status: ['status', 'statusCode', 'status_code', 'responseStatus', 'resultCode'],
  body: ['body', 'requestBody', 'request_body', 'payload'],
  headers: ['headers', 'requestHeaders', 'request_headers'],
};

const pick = (obj, names) => {
  if (!obj || typeof obj !== 'object') return undefined;
  const keys = Object.keys(obj);
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase() === n.toLowerCase());
    if (k !== undefined && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return undefined;
};

/** A JSON object somewhere in the line (a structured log, or a body after the URL), parsed; or null. */
function jsonIn(text, from = 0) {
  const start = text.indexOf('{', from);
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** A structured log line's request: { method, url, status?, body?, headers? } or null. */
function fromJson(obj) {
  for (const o of [obj, obj.request, obj.req, obj.http, obj.httpRequest, obj.http?.request, obj.url && typeof obj.url === 'object' ? { ...obj.url, method: pick(obj, KEYS.method) } : null]) {
    if (!o || typeof o !== 'object') continue;
    const method = pick(o, KEYS.method) ?? pick(obj, KEYS.method);
    let url = pick(o, KEYS.url);
    if (url && typeof url === 'object') url = url.full ?? url.original ?? url.path;
    if (typeof method !== 'string' || !new RegExp(`^(${METHODS})$`, 'i').test(method) || typeof url !== 'string' || !/^(https?:\/\/|\/)/i.test(url)) continue;
    const status = Number(pick(o, KEYS.status) ?? pick(obj.response ?? obj.res ?? obj, KEYS.status));
    const headers = pick(o, KEYS.headers);
    const body = pick(o, KEYS.body);
    return { method: method.toUpperCase(), url, ...(status >= 100 && status < 600 ? { status } : {}), ...(headers && typeof headers === 'object' ? { headers } : {}), ...(body != null ? { body } : {}) };
  }
  return null;
}

/**
 * The request a log line's text carries: { method, url, status?, body?, headers? } (`url` whole or a
 * path), or null when it names no method and URL.
 */
export function requestInLine(text) {
  const s = String(text ?? '');
  const json = jsonIn(s);
  const structured = json ? fromJson(json) : null;
  if (structured) return structured;
  const m = IN_TEXT.exec(s);
  if (!m) return null;
  const url = m[2].replace(/[),.;\]]+$/, '');
  const status = Number(m[3] ?? STATUS_KEY.exec(s.slice(m.index + m[0].length))?.[1]);
  // A JSON body after the URL: what some frameworks log for a POST.
  const body = jsonIn(s, m.index + m[0].length);
  return { method: m[1].toUpperCase(), url, ...(status ? { status } : {}), ...(body ? { body } : {}) };
}

// Headers that belong to the connection, never written; cookies, which the jar keeps; and the ones
// that carry credentials, whose values never go into a file: a {{token}} takes their place.
const CONNECTION = /^(host|content-length|connection|transfer-encoding|keep-alive|upgrade|te|trailer|expect|accept-encoding)$/i;
const COOKIE = /^(cookie|set-cookie)$/i;
const CREDENTIAL = /^(authorization|proxy-authorization|x-api-key|api-key|ocp-apim-subscription-key|x-functions-key)$/i;
const SECRETISH = /token|secret|password|signature|session/i;

/**
 * The URL with its origin as the {{variable}} of `vars` (the environment's) whose value it starts with,
 * the longest such value winning (an API under {{apiBase}} = https://x/api rather than {{host}} = https://x);
 * a path alone goes under the environment's host variable. { url, variable } (`variable` null when none matched).
 */
export function withVariable(url, vars = {}) {
  const u = String(url);
  if (u.startsWith('/')) {
    const host = hostVariable(vars);
    return host ? { url: `{{${host}}}${u}`, variable: host } : { url: u, variable: null };
  }
  let best = null;
  for (const [name, value] of Object.entries(vars ?? {})) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) continue;
    const base = value.trim().replace(/\/+$/, '');
    const fits = u.toLowerCase() === base.toLowerCase() || (u.toLowerCase().startsWith(base.toLowerCase()) && /^[/?#]/.test(u.slice(base.length)));
    if (fits && (!best || base.length > best.base.length)) best = { name, base };
  }
  return best ? { url: `{{${best.name}}}${u.slice(best.base.length)}`, variable: best.name } : { url: u, variable: null };
}

/** A URL's path without its query, for the request's title. */
const pathOf = (url) => String(url).replace(/^\{\{[^}]+\}\}|^[a-z][\w+.-]*:\/\/[^/?#]*/i, '').replace(/[?#].*$/, '') || '/';

/** A name for `# @name`: the method and the path's words, ids left out: POST /api/orders/42/pay is postApiOrdersPay. */
export function requestName(method, url, taken = []) {
  const words = pathOf(url)
    .split('/')
    .filter((w) => w && !/^\d+$/.test(w) && !/^[\da-f]{8,}(-[\da-f]{4,})*$/i.test(w) && !/^\{.*\}$/.test(w))
    .map((w) => w.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')))
    .filter(Boolean);
  const base = [String(method).toLowerCase(), ...words.map((w) => w[0].toUpperCase() + w.slice(1))].join('');
  const used = new Set(taken.map((t) => String(t).toLowerCase()));
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}${n}`;
  return name;
}

/** A body for the file: JSON indented, text as it is, a ### at the start of a line kept from starting a request. */
function bodyText(body) {
  if (body == null || body === '') return '';
  let s = typeof body === 'object' ? JSON.stringify(body, null, 2) : String(body);
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object') s = JSON.stringify(v, null, 2);
  } catch {}
  return s
    .split(/\r?\n/)
    .map((l) => (/^###/.test(l) ? ` ${l}` : l))
    .join('\n');
}

/**
 * A request seen in a log (`seen`: requestInLine's, or a request context) as a block for a .http file:
 * `### <METHOD> <path>`, where it came from and when (`from`, `at`), what it answered, `# @name` (not one
 * of `taken`), the URL under the environment's {{variable}} (`vars`), the headers safe to keep and the
 * body. Returns { block, name, variable, dropped, placeholders }: the headers left out, and those whose
 * value became {{token}}.
 */
export function captureBlock(seen, { vars = {}, taken = [], from = 'a log', at = '' } = {}) {
  const method = String(seen.method ?? 'GET').toUpperCase();
  const { url, variable } = withVariable(seen.url, vars);
  const name = requestName(method, seen.url, taken);
  const dropped = [];
  const placeholders = [];
  const headers = [];
  const entries = Array.isArray(seen.headers) ? seen.headers : Object.entries(seen.headers ?? {});
  for (const [k, raw] of entries) {
    const v = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '');
    if (CONNECTION.test(k)) continue;
    if (COOKIE.test(k)) {
      dropped.push(k);
      continue;
    }
    if (CREDENTIAL.test(k) || SECRETISH.test(k) || /^•+$/.test(v.trim())) {
      // The scheme stays (Bearer, Basic), so only the token itself is to fill in.
      const scheme = /^(authorization|proxy-authorization)$/i.test(k) ? /^([A-Za-z][\w-]*)\s+\S/.exec(v)?.[1] : null;
      headers.push(`${k}: ${scheme ? `${scheme} ` : ''}{{token}}`);
      placeholders.push(k);
      continue;
    }
    headers.push(`${k}: ${v}`);
  }
  const lines = [`### ${method} ${pathOf(seen.url)}`, `# from ${from}${at ? ` at ${at}` : ''}${seen.status ? `, where it answered ${seen.status}` : ''}`, `# @name ${name}`, `${method} ${url}`, ...headers];
  const body = bodyText(seen.body);
  if (body) {
    if (!headers.some((h) => /^content-type\s*:/i.test(h)) && /^\s*[[{]/.test(body)) lines.push('Content-Type: application/json');
    lines.push('', ...body.split('\n'));
  }
  return { block: `${lines.join('\n')}\n`, name, variable, dropped, placeholders };
}

/** When a log line was written, for the comment: its own time when it has one, else now, to the second. */
export const capturedAt = (time, now = Date.now()) => (typeof time === 'string' && time.trim() ? time.trim() : new Date(typeof time === 'number' ? time : now).toISOString().replace(/\.\d{3}Z$/, 'Z'));
