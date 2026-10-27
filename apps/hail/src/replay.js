// /replay: a request that was answered somewhere (production, through Sonar, or a response kept in
// History) sent again to another address, and the two answers compared. Pure: actions.js picks the
// request and the address, sends it, and shows what this works out.
import { changedOnly, lineDiff } from './diff.js';
import { hostVariable } from './takes.js';
import { prettyBody } from './send.js';

// Headers that belong to the connection, not the request: fetch sets its own.
const HOP_BY_HOP = /^(host|connection|keep-alive|proxy-connection|transfer-encoding|te|trailer|upgrade|content-length|expect)$/i;
// Headers that carry credentials. A token from where the request came from (production's, say)
// never travels to another address: the environment picked gives its own instead.
const CREDENTIAL = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|ocp-apim-subscription-key|x-functions-key)$/i;
const SECRETISH = /token|secret|password|signature/i;
// What History hides a credential header's value with.
const HIDDEN = /^•+$/;

/**
 * The environment variables that give each credential header its value, in the order they're tried:
 * { variable, value } where `value` is the header's value with `{{variable}}` in it.
 */
const AUTH_FROM = {
  authorization: [
    ['authorization', '{{v}}'],
    ['Authorization', '{{v}}'],
    ['token', 'Bearer {{v}}'],
    ['accessToken', 'Bearer {{v}}'],
    ['access_token', 'Bearer {{v}}'],
    ['bearerToken', 'Bearer {{v}}'],
    ['bearer', 'Bearer {{v}}'],
    ['jwt', 'Bearer {{v}}'],
  ],
  'x-api-key': [['x-api-key', '{{v}}'], ['apiKey', '{{v}}'], ['api_key', '{{v}}'], ['apikey', '{{v}}']],
  'api-key': [['api-key', '{{v}}'], ['apiKey', '{{v}}'], ['api_key', '{{v}}']],
  'ocp-apim-subscription-key': [['ocp-apim-subscription-key', '{{v}}'], ['subscriptionKey', '{{v}}'], ['apimKey', '{{v}}']],
  'x-functions-key': [['x-functions-key', '{{v}}'], ['functionsKey', '{{v}}'], ['functionKey', '{{v}}']],
};

/** Headers as [[name, value]] from either shape a request carries them in (a context's object, a kept entry's list). */
export const headerList = (headers) => (Array.isArray(headers) ? headers.map(([k, v]) => [k, String(v)]) : Object.entries(headers ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]));

/**
 * The headers to send again: the request's own less the hop-by-hop ones and every credential
 * (`dropped`, by name), then each dropped credential the environment's variables (`vars`) can give,
 * as `{{variable}}` for filling in (`added`). Returns { headers, dropped, added }.
 */
export function replayHeaders(headers, vars = {}) {
  const kept = [];
  const dropped = [];
  for (const [k, v] of headerList(headers)) {
    if (HOP_BY_HOP.test(k)) continue;
    if (CREDENTIAL.test(k) || SECRETISH.test(k) || HIDDEN.test(v)) {
      if (!dropped.some((d) => d.toLowerCase() === k.toLowerCase())) dropped.push(k);
      continue;
    }
    kept.push([k, v]);
  }
  const added = [];
  const names = Object.keys(vars ?? {});
  for (const k of dropped) {
    for (const [want, shape] of AUTH_FROM[k.toLowerCase()] ?? []) {
      // Case matters to the variables, but not to which one is meant.
      const name = names.find((n) => n === want) ?? names.find((n) => n.toLowerCase() === want.toLowerCase());
      if (name && String(vars[name] ?? '').trim()) {
        added.push([k, shape.replace('v', name)]);
        break;
      }
    }
  }
  return { headers: [...kept, ...added], dropped, added: added.map(([k]) => k) };
}

/** An address typed for /replay as a base URL: `:5000` and `localhost:5000` are http://localhost:5000; null when it isn't one. */
export function normaliseBase(text) {
  let s = String(text ?? '').trim();
  if (!s) return null;
  if (/^:\d+$/.test(s)) s = `localhost${s}`;
  if (!/^[a-z][\w+.-]*:\/\//i.test(s)) {
    if (!/^[\w.-]+(:\d+)?(\/.*)?$/.test(s)) return null;
    s = `http://${s}`;
  }
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * `url` (a whole URL, or a path) sent to `base` instead: its path and query kept, under the base's own
 * path when it has one (an API under /api), unless the path already starts with it.
 */
export function rebaseUrl(url, base) {
  const b = String(base).replace(/\/+$/, '');
  let path = pathOf(url);
  if (!path.startsWith('/')) path = `/${path}`;
  let prefix = '';
  try {
    prefix = new URL(b).pathname.replace(/\/+$/, '');
  } catch {}
  if (prefix && (path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`))) return `${b.slice(0, b.length - prefix.length)}${path}`;
  return `${b}${path}`;
}

/** A URL's path and query, which is what makes two requests to different hosts the same request. */
export function pathOf(url) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return String(url ?? '').replace(/^\{\{[^}]+\}\}|^[a-z][\w+.-]*:\/\/[^/?#]*/i, '') || '/';
  }
}

/** The newest kept response (history.js's entries, oldest first) to `method` and the same path and query as `url`, other than `not`; or null. */
export function lastResponseTo(entries, { method = 'GET', url }, { not = null } = {}) {
  const m = String(method).toUpperCase();
  const p = pathOf(url);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e !== not && String(e.request?.method).toUpperCase() === m && pathOf(e.request?.url) === p) return e;
  }
  return null;
}

/**
 * Where /replay can send a request, for its picker: each environment whose variables say where the API
 * is (host, baseUrl), then each of Bosun's processes with a port (bosun.json), as
 * [{ label, base?, env?, hostVar?, source }]. `envs` is environments.js's; `bosun` the parsed bosun.json.
 */
export function replayTargets({ envs = null, bosun = null } = {}) {
  const out = [];
  for (const name of envs?.names ?? []) {
    const vars = envs.vars(name);
    const hostVar = hostVariable(vars);
    if (hostVar) out.push({ label: name, env: name, hostVar, shown: `{{${hostVar}}} = ${vars[hostVar]}`, source: 'environment' });
  }
  for (const [name, p] of Object.entries(bosun?.procs ?? {})) {
    const port = Number(p?.port);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    out.push({ label: `Bosun's ${name}`, base: `http://localhost:${port}`, shown: `http://localhost:${port}`, source: 'bosun' });
    // "https": true serves it on the port after, or on the port it names.
    const https = p.https === true ? port + 1 : Number.isInteger(p.https) ? p.https : null;
    if (https) out.push({ label: `Bosun's ${name} (https)`, base: `https://localhost:${https}`, shown: `https://localhost:${https}`, source: 'bosun' });
  }
  return out;
}

/** The target `arg` names: an environment by name (any case), else an address; null when it's neither. */
export function targetNamed(arg, { envs = null } = {}) {
  const a = String(arg ?? '').trim();
  if (!a) return null;
  const env = (envs?.names ?? []).find((n) => n.toLowerCase() === a.toLowerCase());
  if (env) {
    const hostVar = hostVariable(envs.vars(env));
    return hostVar ? { label: env, env, hostVar } : { error: `${env} has no host, baseUrl or baseURL to send it to.` };
  }
  const base = normaliseBase(a);
  return base ? { label: base, base } : null;
}

// Headers that differ on every response, whatever the server: comparing them says nothing.
const VOLATILE = /^(date|age|expires|last-modified|etag|content-length|transfer-encoding|connection|keep-alive|server-timing|set-cookie|x-request-id|request-id|request-context|traceparent|tracestate|x-correlation-id|x-trace-id|x-amzn-trace-id|x-azure-ref|x-ms-request-id|x-powered-by|server|via|alt-svc|strict-transport-security|report-to|nel)$/i;

/** A response as text to compare: its status, the headers that say something (when `headers`), its body. */
export function comparable(r, { headers = true } = {}) {
  const lines = [`${r.status}${r.statusText ? ` ${r.statusText}` : ''}`];
  if (headers) {
    const kept = headerList(r.headers)
      .filter(([k]) => !VOLATILE.test(k))
      .map(([k, v]) => `${k.toLowerCase()}: ${v}`)
      .sort();
    lines.push(...kept);
  }
  if (r.body != null && r.body !== '') lines.push('', prettyBody({ headers: headerList(r.headers), body: String(r.body) }));
  return lines.join('\n');
}

/**
 * Two responses compared: `before` (what the request answered where it came from: a kept entry's
 * response, or a context's { status, ms, headers?, body? }) and `after` (the replay's). The headers
 * are compared only when both have some, and the bodies only when `before` has one; `bodyFrom`, when
 * given, is a kept response whose body stands in for a `before` that has none (Sonar keeps no bodies).
 * Returns { same, status, diff: [[mark, line]], compared: 'all' | 'status' }.
 */
export function compareResponses(before, after, { bodyFrom = null } = {}) {
  const has = (r) => r?.body != null && r.body !== '';
  const b = !has(before) && has(bodyFrom) ? { ...before, headers: headerList(before.headers).length ? before.headers : bodyFrom.headers, body: bodyFrom.body } : before;
  const withBody = has(b);
  const headers = headerList(b.headers).length > 0 && headerList(after.headers).length > 0;
  // Without a body to compare, the status code alone is: its text differs between servers for no reason.
  const diff = withBody ? changedOnly(lineDiff(comparable({ ...b, statusText: '' }, { headers }), comparable({ ...after, statusText: '' }, { headers }))) : lineDiff(`${before.status}`, `${after.status}`);
  return { same: !diff.some(([m]) => m === '-' || m === '+'), status: before.status === after.status, diff, compared: withBody ? 'all' : 'status' };
}

/** "500 · 4210 ms", or what's known of it. */
export const statusLine = (r) => [r?.status != null ? `${r.status}${r.statusText ? ` ${r.statusText}` : ''}` : null, r?.ms != null ? `${r.ms} ms` : null].filter(Boolean).join(' · ') || 'unknown';
