// A captured request as Hail reads it: a block of a .http file (h writes it and opens it in Hail), and
// the `request` context (t, Hail's /take). Credentials never go in: an Authorization's token, a cookie,
// an API key, a secret in the query or the body each become a variable ({{token}}, {{cookie}},
// {{apiKey}}, {{password}}) for the person to fill in, in Hail's environment. Pure.
import { bodyText, mediaType } from './exchange.js';
import { decodeURIComponentSafe, isSecretHeader, isSecretParam, replaceInForm, replaceInJson, secretsIn } from './redact.js';

// Headers that are the connection's, not the request's, and that Hail sets itself.
const CONNECTION = /^(host|content-length|connection|proxy-connection|keep-alive|transfer-encoding|te|trailer|upgrade|expect|accept-encoding|proxy-authorization)$/i;

/** A variable's name from a header's or field's: x-api-key is apiKey, access_token stays. */
export function variableName(name) {
  const s = String(name).replace(/^x-/i, '');
  if (/[-\s]/.test(s)) return s.toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/[^A-Za-z0-9_]/g, '') || 'secret';
  return s.replace(/[^A-Za-z0-9_]/g, '_') || 'secret';
}

/** The variables a block uses, each value once under one name ({{token}}, {{token2}} for another). */
function variables() {
  const byValue = new Map();
  const names = new Set();
  return {
    put(name, value) {
      const key = `${name}\n${value}`;
      if (byValue.has(key)) return `{{${byValue.get(key)}}}`;
      let n = name;
      for (let i = 2; names.has(n); i++) n = `${name}${i}`;
      names.add(n);
      byValue.set(key, n);
      return `{{${n}}}`;
    },
    get list() {
      return [...names];
    },
  };
}

/** Text with each secret codescan's rules find in it replaced by a variable. */
function replaceSecrets(text, vars, name = 'secret') {
  let s = String(text);
  for (const secret of secretsIn(s)) s = s.split(secret).join(vars.put(name, secret));
  return s;
}

/** The URL with its query's secrets, and a password in it, as variables. */
function urlWith(url, vars) {
  const s = String(url);
  const q = s.indexOf('?');
  const head = s.slice(0, q < 0 ? s.length : q).replace(/^([a-z][a-z0-9+.-]*:\/\/[^/@\s:]*:)([^@/\s]*)@/i, (m, pre, pass) => `${pre}${vars.put('password', pass)}@`);
  if (q < 0) return replaceSecrets(head, vars);
  const query = s
    .slice(q + 1)
    .split('&')
    .map((part) => {
      const at = part.indexOf('=');
      if (at < 0) return part;
      const name = decodeURIComponentSafe(part.slice(0, at));
      return isSecretParam(name) && part.slice(at + 1) ? `${part.slice(0, at)}=${vars.put(variableName(name), part.slice(at + 1))}` : part;
    })
    .join('&');
  return replaceSecrets(`${head}?${query}`, vars);
}

/** A header's value with its credential as a variable: Authorization keeps its scheme (Bearer {{token}}). */
function headerWith(name, value, vars) {
  const n = name.toLowerCase();
  const v = String(value);
  if (n === 'authorization') {
    const m = /^([A-Za-z][\w-]*)\s+(\S[\s\S]*)$/.exec(v);
    return m ? `${m[1]} ${vars.put('token', m[2])}` : vars.put('token', v);
  }
  if (n === 'cookie') return vars.put('cookie', v);
  if (isSecretHeader(name)) return vars.put(variableName(name), v);
  return replaceSecrets(v, vars);
}

/** The request's headers and body with variables in place of secrets: { url, headers: [[n, v]], body, note, variables }. */
export function requestWithVariables(ex) {
  const vars = variables();
  const url = urlWith(ex.url, vars);
  const headers = ex.request.headers.filter(([n]) => !CONNECTION.test(n)).map(([n, v]) => [n, headerWith(n, v, vars)]);
  let body = null;
  let note = null;
  if (ex.request.size) {
    const text = bodyText(ex.request);
    const type = mediaType(ex.request);
    if (text == null) note = `a ${type || 'binary'} body of ${ex.request.size} bytes, left out`;
    else {
      const put = (name, v) => vars.put(variableName(name), String(v));
      let done = false;
      if (/json/.test(type) || /^\s*[[{]/.test(text)) {
        try {
          body = JSON.stringify(replaceInJson(JSON.parse(text), put), null, 2);
          done = true;
        } catch {}
      }
      if (!done) body = /x-www-form-urlencoded/.test(type) ? replaceInForm(text, put) : replaceSecrets(text, vars);
      body = replaceSecrets(body, vars);
      if (ex.request.truncated) note = `the body was cut at ${ex.request.body.length} of ${ex.request.size} bytes (the most Lookout keeps of one)`;
    }
  }
  return { url, headers, body, note, variables: vars.list };
}

/** The `# @name` for a request: its method and the last word of its path, unique among `taken`. */
export function requestName(ex, taken = []) {
  const last = String(ex.path ?? '').replace(/[?#].*$/, '').split('/').filter(Boolean).at(-1) ?? 'root';
  const base = `${String(ex.method).toLowerCase()}-${last.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'root'}`;
  const used = new Set(taken);
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
  return name;
}

/** The names a .http file's text already uses (# @name, // @name). */
export const namesIn = (text) => [...String(text ?? '').matchAll(/^\s*(?:#|\/\/)\s*@name\s+(\S+)/gm)].map((m) => m[1]);

/**
 * The request as a block of a .http file, for Hail: { block, name, variables }. A comment says where
 * it came from, when, what it answered and which variables to fill in.
 */
export function httpBlock(ex, { taken = [], now = Date.now() } = {}) {
  const r = requestWithVariables(ex);
  const name = requestName(ex, taken);
  const when = new Date(ex.at ?? now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const lines = [
    `### ${ex.method} ${String(ex.path || '/').replace(/\?.*$/, '')}`,
    `# from Lookout at ${when}${ex.response?.status ? `, where it answered ${ex.response.status}` : ''}`,
    ...(r.variables.length ? [`# fill in ${r.variables.map((v) => `{{${v}}}`).join(', ')} (Hail's environment, http-client.private.env.json): Lookout never writes a credential down`] : []),
    ...(r.note ? [`# ${r.note}`] : []),
    `# @name ${name}`,
    `${ex.method} ${r.url}`,
    ...r.headers.map(([n, v]) => `${n}: ${v}`),
  ];
  if (r.body != null && r.body !== '') {
    if (!r.headers.some(([n]) => /^content-type$/i.test(n)) && /^\s*[[{]/.test(r.body)) lines.push('Content-Type: application/json');
    lines.push('', ...r.body.split(/\r?\n/).map((l) => (/^###/.test(l) ? ` ${l}` : l)));
  }
  return { block: `${lines.join('\n')}\n`, name, variables: r.variables };
}

/** `block` added to the end of a .http file's text, a blank line between. */
export const appendBlock = (text, block) => `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text.trim() ? '\n' : ''}${block}`;

/**
 * The request as the family's `request` context, for Hail's /take: no credential in it, the same
 * variables in their place. { method, url, headers, body, app, response: { status, ms, at } }.
 */
export function requestContext(ex) {
  const r = requestWithVariables(ex);
  const headers = {};
  for (const [n, v] of r.headers) headers[n] = n in headers ? `${headers[n]}, ${v}` : v;
  return {
    method: ex.method,
    url: r.url,
    headers,
    ...(r.body ? { body: r.body } : {}),
    name: requestName(ex),
    app: 'lookout',
    ...(ex.response?.status ? { response: { status: ex.response.status, ...(ex.timings?.end ? { ms: ex.timings.end - ex.timings.start } : {}), at: new Date(ex.at).toISOString() } } : {}),
  };
}

