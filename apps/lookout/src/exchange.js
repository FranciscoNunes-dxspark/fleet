// A captured exchange, as proxy.js records it and every view reads it:
//
//   { id, kind: 'http'|'tunnel'|'refused', state: 'open'|'done'|'error', at, scheme, method, host, port,
//     path, url, intercepted, note?, error?,
//     request:  { httpVersion, headers: [[name, value]], body: Buffer|null, size, truncated },
//     response: { status, statusText, httpVersion, headers, body, size, truncated } | null,
//     timings:  { start, connect, ttfb, end } (ms since the epoch, null until known) }
//
// A tunnel is a CONNECT passed through untouched (its sizes are the bytes each way); a refused one is
// a client that turned Lookout's certificate down. Here: reading headers and bodies, the filter, the
// hosts, the words for a row. Pure.
import { brotliDecompressSync, gunzipSync, inflateSync, inflateRawSync } from 'node:zlib';
import { maskBody, maskHeader, maskUrl } from './redact.js';

/** A header's value (the first of that name, any case), or undefined. */
export const header = (headers = [], name) => headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];

/** Every value of a header. */
export const headerAll = (headers = [], name) => headers.filter(([n]) => n.toLowerCase() === name.toLowerCase()).map(([, v]) => v);

/** The body's bytes without its Content-Encoding (gzip, deflate, br), or as they were when it can't be undone. */
export function decoded(part) {
  const body = part?.body;
  if (!body?.length) return body ?? null;
  const enc = String(header(part.headers, 'content-encoding') ?? '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(body);
    if (enc === 'br') return brotliDecompressSync(body);
    if (enc === 'deflate') {
      try {
        return inflateSync(body);
      } catch {
        return inflateRawSync(body);
      }
    }
  } catch {
    // A body cut at maxBody can't be inflated whole: shown as it came.
  }
  return body;
}

const TEXTUAL = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|csv|yaml|x-yaml|x-ndjson|problem\+json)|image\/svg)/i;

/** The Content-Type's media type, lower case, without parameters. */
export const mediaType = (part) => String(header(part?.headers, 'content-type') ?? '').split(';')[0].trim().toLowerCase();

/** Whether a body reads as text: its type says so, or its bytes are UTF-8 without control characters. */
export function isText(part, bytes = decoded(part)) {
  if (!bytes?.length) return true;
  const type = mediaType(part);
  if (type) return TEXTUAL.test(type);
  const sample = bytes.subarray(0, 512).toString('utf8');
  return !/[\x00-\x08\x0e-\x1f]/.test(sample) && !sample.includes('�');
}

/** A body as text, or null when it's binary (or empty). */
export function bodyText(part) {
  const bytes = decoded(part);
  if (!bytes?.length || !isText(part, bytes)) return null;
  return bytes.toString('utf8');
}

/** Whether a body opens in the data viewer: JSON, JSON lines or CSV, by type or by look. */
export function isData(part) {
  const type = mediaType(part);
  if (/json|csv|tab-separated/.test(type)) return true;
  const text = bodyText(part);
  return Boolean(text && /^\s*[[{]/.test(text));
}

/** "1.2 KB" */
export function size(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** How long it took, start to end (or to now while open): "84 ms", "2.3 s". */
export function duration(ex, now = Date.now()) {
  const end = ex.timings?.end ?? (ex.state === 'open' ? now : null);
  if (end == null) return '';
  const ms = end - ex.timings.start;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

/** The status as a row shows it: 200, "tunnel", "refused", "error", or … while waiting. */
export function statusWord(ex) {
  if (ex.kind === 'refused') return 'refused';
  if (ex.kind === 'tunnel') return ex.state === 'error' ? 'error' : 'tunnel';
  if (ex.response?.status) return String(ex.response.status);
  return ex.state === 'error' ? 'error' : '…';
}

/** Which way a status leans, for its colour: ok, redirect, client, server, error, tunnel, open. */
export function statusTone(ex) {
  if (ex.kind === 'refused' || ex.state === 'error') return 'error';
  if (ex.kind === 'tunnel') return 'tunnel';
  const s = ex.response?.status;
  if (!s) return 'open';
  if (s >= 500) return 'server';
  if (s >= 400) return 'client';
  if (s >= 300) return 'redirect';
  return 'ok';
}

/** The path and query as a row shows it, secrets in the query masked. */
export const shownPath = (ex) => (ex.kind === 'http' ? maskUrl(ex.path || '/') : ex.kind === 'refused' ? ex.note ?? '' : ex.note ?? 'tunnel, not intercepted');

/** The bytes a row counts: the response's, or both ways for a tunnel. */
export const rowSize = (ex) => (ex.kind === 'tunnel' ? (ex.request.size ?? 0) + (ex.response?.size ?? 0) : ex.response?.size ?? null);

/**
 * A filter as typed: words, and `host:` `status:` `method:` ones. host: matches the end of the name
 * (host:example.com takes api.example.com); status: a code, a class (4xx) or error, refused, tunnel;
 * the other words must all be in the URL, a header's name or value, or a body (masked: what's hidden
 * isn't searchable either).
 */
export function parseFilter(text) {
  const f = { host: [], status: [], method: [], words: [] };
  for (const w of String(text ?? '').trim().split(/\s+/).filter(Boolean)) {
    const m = /^(host|status|method|h|s|m):(.*)$/i.exec(w);
    if (m && m[2]) f[{ h: 'host', s: 'status', m: 'method' }[m[1].toLowerCase()] ?? m[1].toLowerCase()].push(m[2].toLowerCase());
    else f.words.push(w.toLowerCase());
  }
  return f;
}

const statusMatches = (ex, want) => {
  const word = statusWord(ex);
  if (want === 'error' || want === 'err') return ex.state === 'error' || ex.kind === 'refused';
  if (/^\dxx$/.test(want)) return word.length === 3 && word[0] === want[0];
  return word === want;
};

/** Whether an exchange passes a parsed filter. */
export function matches(ex, f) {
  if (f.host.length && !f.host.some((h) => ex.host === h || ex.host.endsWith(`.${h}`) || ex.host.includes(h))) return false;
  if (f.status.length && !f.status.some((s) => statusMatches(ex, s))) return false;
  if (f.method.length && !f.method.includes(String(ex.method).toLowerCase())) return false;
  if (!f.words.length) return true;
  const hay = searchText(ex);
  return f.words.every((w) => hay.includes(w));
}

const searched = new WeakMap();
/** What a filter's words are looked for in: the masked URL, headers and text bodies, lower case (worked out once per state). */
function searchText(ex) {
  const key = `${ex.state}:${ex.response?.status}:${ex.response?.body?.length ?? 0}`;
  const was = searched.get(ex);
  if (was?.key === key) return was.text;
  const parts = [ex.method, maskUrl(ex.url), statusWord(ex), ex.note ?? ''];
  for (const part of [ex.request, ex.response].filter(Boolean)) {
    for (const [n, v] of part.headers ?? []) parts.push(`${n}: ${maskHeader(n, v)}`);
    const t = bodyText(part);
    if (t) parts.push(maskBody(t.slice(0, 200000), mediaType(part)));
  }
  const text = parts.join('\n').toLowerCase();
  searched.set(ex, { key, text });
  return text;
}

/** The exchanges a filter text lets through. */
export const filtered = (list, text) => {
  const f = parseFilter(text);
  return f.host.length || f.status.length || f.method.length || f.words.length ? list.filter((ex) => matches(ex, f)) : list;
};

/** The hosts seen, most requests first: [{ host, count, errors, refused, tunnels, intercepted, last }]. */
export function hosts(list) {
  const by = new Map();
  for (const ex of list) {
    const h = by.get(ex.host) ?? { host: ex.host, count: 0, errors: 0, refused: 0, tunnels: 0, intercepted: 0, plain: 0, last: 0 };
    h.count++;
    if (ex.kind === 'refused') h.refused++;
    else if (ex.kind === 'tunnel') h.tunnels++;
    else if (ex.intercepted) h.intercepted++;
    else if (ex.scheme === 'http') h.plain++;
    if (ex.state === 'error' || (ex.response?.status ?? 0) >= 500) h.errors++;
    h.last = Math.max(h.last, ex.at);
    by.set(ex.host, h);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

/**
 * The words for the family's activity log: how many requests to which hosts, nothing else (no path,
 * no header, no body): "captured 40 requests to api.example.com and 12 to 2 other hosts".
 */
export function capturedLine(list) {
  const hs = hosts(list.filter((ex) => ex.kind !== 'refused'));
  if (!hs.length) return null;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const [top, ...rest] = hs;
  const others = rest.reduce((n, h) => n + h.count, 0);
  return `captured ${plural(top.count, 'request')} to ${top.host}${rest.length ? ` and ${others} to ${plural(rest.length, 'other host')}` : ''}`;
}
