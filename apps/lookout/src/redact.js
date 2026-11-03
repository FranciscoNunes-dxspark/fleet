// What captured traffic must never show unasked, nor write to a file: credentials. Headers that carry
// them (Authorization, Cookie, Set-Cookie, API keys, and any whose name says secret, token or password),
// query parameters and body fields named so, and anything in a body or URL the kit's codescan.js rules
// take for a secret (a JWT, a GitHub token, an AWS key…), cut down with its `redact`. `mask*` hide
// them on screen; `variables` (httpfile.js) puts {{names}} in their place. Pure.
import { RULES, redact } from '@fleet/kit/codescan.js';
import { MASK, isSecretName, redactSecrets } from '@fleet/kit/family.js';

// Headers that carry credentials whatever their value looks like.
const CREDENTIAL_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-amz-security-token|ocp-apim-subscription-key|x-functions-key|x-csrf-token|x-xsrf-token|x-goog-api-key)$/i;
// Names of parameters and fields that hold one, beyond what family.js's isSecretName knows.
const SECRET_PARAMS = /^(access_token|id_token|refresh_token|code|client_secret|sig|signature|key|apikey|api_key|auth|session|sessionid|sid|jwt|password|passwd|pwd|token|secret)$/i;

/** Whether a header carries a credential, by its name. */
export const isSecretHeader = (name) => CREDENTIAL_HEADERS.test(String(name)) || /token|secret|password|passwd|signature|session|credential|api[-_]?key/i.test(String(name));

/** Whether a query parameter or a body field holds one, by its name. */
export const isSecretParam = (name) => SECRET_PARAMS.test(String(name)) || isSecretName(name);

// The codescan rules that find a secret in any text: those for every kind of file, and that hold one.
const SECRET_RULES = RULES.filter((r) => r.kind === 'secret' && !r.files && r.id !== 'hardcoded-secret');

/** The secrets codescan's rules find in `text`, each once: the values themselves, longest first. */
export function secretsIn(text) {
  const found = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.length > 20000) continue;
    for (const r of SECRET_RULES) {
      const lower = line.toLowerCase();
      if (r.needs && !r.needs.some((w) => lower.includes(w))) continue;
      const g = new RegExp(r.pattern.source, r.pattern.flags.includes('g') ? r.pattern.flags : `${r.pattern.flags}g`);
      for (const m of line.matchAll(g)) {
        if (r.accept && !r.accept(m, line)) continue;
        const secret = r.secret === undefined ? null : (m[r.secret] ?? m[r.secret + 1] ?? m[0]);
        if (secret && secret.length >= 6) found.add(secret);
      }
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

/** `text` with what codescan's rules take for a secret cut down (kit's redact), and family.js's bearer tokens and key=value secrets masked. */
export function maskText(text) {
  let s = String(text ?? '');
  for (const secret of secretsIn(s)) s = s.split(secret).join(redact(secret));
  return redactSecrets(s);
}

/** A cookie header's value with each cookie's value masked, the names kept: "sid=••••; theme=••••". */
const maskCookies = (value) =>
  String(value)
    .split(/;\s*/)
    .map((c) => (c.includes('=') ? `${c.slice(0, c.indexOf('='))}=${MASK}` : c))
    .join('; ');

/** A Set-Cookie's value with the cookie's own value masked, its attributes kept: "sid=••••; Path=/; HttpOnly". */
const maskSetCookie = (value) => {
  const [first, ...attrs] = String(value).split(/;\s*/);
  return [first.includes('=') ? `${first.slice(0, first.indexOf('='))}=${MASK}` : MASK, ...attrs].join('; ');
};

/** A header's value as it may be shown: a credential masked (the scheme of an Authorization kept), else as it is through maskText. */
export function maskHeader(name, value) {
  const v = String(value ?? '');
  const n = String(name).toLowerCase();
  if (n === 'cookie') return maskCookies(v);
  if (n === 'set-cookie') return maskSetCookie(v);
  if (n === 'authorization' || n === 'proxy-authorization') {
    const scheme = /^([A-Za-z][\w-]*)\s+\S/.exec(v)?.[1];
    return scheme ? `${scheme} ${MASK}` : MASK;
  }
  if (isSecretHeader(name)) return v ? MASK : v;
  return maskText(v);
}

/** Whether showing a header would show a credential: what the detail view marks as hidden. */
export const headerHidden = (name, value) => maskHeader(name, value) !== String(value ?? '');

/** A URL with its query's secrets (by name, or by codescan's rules) and any password in it masked. */
export function maskUrl(url) {
  const s = String(url ?? '');
  const q = s.indexOf('?');
  const head = s.slice(0, q < 0 ? s.length : q).replace(/^([a-z][a-z0-9+.-]*:\/\/[^/@\s]*:)[^@/\s]*@/i, `$1${MASK}@`);
  if (q < 0) return maskText(head);
  const query = s
    .slice(q + 1)
    .split('&')
    .map((part) => {
      const at = part.indexOf('=');
      if (at < 0) return part;
      const name = decodeURIComponentSafe(part.slice(0, at));
      return isSecretParam(name) && part.slice(at + 1) ? `${part.slice(0, at)}=${MASK}` : part;
    })
    .join('&');
  return maskText(`${head}?${query}`);
}

export function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/**
 * A JSON value with what it holds secret replaced by `replace(name, value)`: every field whose name
 * says it's secret (a password, a token…), and every string codescan's rules take for one.
 */
export function replaceInJson(value, replace) {
  const walk = (v, name) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, name));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, isSecretParam(k) && (typeof x === 'string' || typeof x === 'number') && x !== '' ? replace(k, x) : walk(x, k)]));
    if (typeof v === 'string' && secretsIn(v).length) return replace(name ?? 'secret', v);
    return v;
  };
  return walk(value, null);
}

/** Form fields (a=1&b=2) with the secret ones replaced by `replace(name, value)`. */
export function replaceInForm(text, replace) {
  return String(text)
    .split('&')
    .map((part) => {
      const at = part.indexOf('=');
      if (at < 0) return part;
      const name = decodeURIComponentSafe(part.slice(0, at));
      const value = decodeURIComponentSafe(part.slice(at + 1));
      return (isSecretParam(name) || secretsIn(value).length) && value ? `${part.slice(0, at)}=${replace(name, value)}` : part;
    })
    .join('&');
}

/** A body's text as it may be shown: JSON and form fields named as secrets masked, then maskText. */
export function maskBody(text, contentType = '') {
  const s = String(text ?? '');
  if (/json/i.test(contentType) || /^\s*[[{]/.test(s)) {
    try {
      const masked = replaceInJson(JSON.parse(s), (name, v) => (typeof v === 'string' && secretsIn(v).length && !isSecretParam(name) ? maskText(v) : MASK));
      return maskText(JSON.stringify(masked, null, /\n/.test(s) ? 2 : 0));
    } catch {}
  }
  if (/x-www-form-urlencoded/i.test(contentType)) return maskText(replaceInForm(s, () => MASK));
  return maskText(s);
}

export { MASK };
