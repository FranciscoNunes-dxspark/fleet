// HAR 1.2 (the HTTP Archive browsers' developer tools export and import), both ways. A HAR file is
// passed around (to a colleague, into a ticket), so Lookout's export leaves credentials out unless
// asked: headers, query and bodies go through redact.js's masks, and only `secrets: true` (/export
// … secrets, asked first) writes them as they were. Pure.
import { decoded, header, isText, mediaType } from './exchange.js';
import { maskBody, maskHeader, maskUrl } from './redact.js';

const iso = (ms) => new Date(ms).toISOString();

function queryString(url) {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/** A body as HAR's text: UTF-8 text when it is text, else base64 with `encoding`. */
function content(part, secrets) {
  const bytes = decoded(part);
  if (!bytes?.length) return { text: '' };
  if (isText(part, bytes)) {
    const text = bytes.toString('utf8');
    return { text: secrets ? text : maskBody(text, mediaType(part)) };
  }
  return { text: bytes.toString('base64'), encoding: 'base64' };
}

const harHeaders = (headers = [], secrets) => headers.map(([name, value]) => ({ name, value: secrets ? String(value) : maskHeader(name, value) }));

/** One exchange as a HAR entry. A tunnel or a refused handshake has no request to write and is left out. */
function entry(ex, secrets) {
  const t = ex.timings ?? {};
  const wait = t.ttfb != null ? t.ttfb - (t.connect ?? t.start) : -1;
  const receive = t.end != null && t.ttfb != null ? t.end - t.ttfb : -1;
  const connect = t.connect != null && t.connect !== t.start ? t.connect - t.start : -1;
  const url = secrets ? ex.url : maskUrl(ex.url);
  const reqBody = ex.request.size ? content(ex.request, secrets) : null;
  const res = ex.response;
  return {
    startedDateTime: iso(ex.at),
    time: t.end != null ? t.end - t.start : 0,
    request: {
      method: ex.method,
      url,
      httpVersion: `HTTP/${ex.request.httpVersion ?? '1.1'}`,
      cookies: [],
      headers: harHeaders(ex.request.headers, secrets),
      queryString: queryString(url),
      headersSize: -1,
      bodySize: ex.request.size ?? 0,
      ...(reqBody ? { postData: { mimeType: header(ex.request.headers, 'content-type') ?? '', text: reqBody.text, ...(reqBody.encoding ? { encoding: reqBody.encoding } : {}) } } : {}),
    },
    response: {
      status: res?.status ?? 0,
      statusText: res?.statusText ?? '',
      httpVersion: `HTTP/${res?.httpVersion ?? '1.1'}`,
      cookies: [],
      headers: harHeaders(res?.headers, secrets),
      content: { size: decoded(res)?.length ?? 0, mimeType: header(res?.headers, 'content-type') ?? '', ...(res ? content(res, secrets) : { text: '' }) },
      redirectURL: header(res?.headers, 'location') ?? '',
      headersSize: -1,
      bodySize: res?.size ?? -1,
    },
    cache: {},
    timings: { blocked: -1, dns: -1, connect, ssl: -1, send: 0, wait, receive },
    ...(ex.error ? { _error: ex.error } : {}),
    ...(ex.request.truncated || res?.truncated ? { _truncated: true } : {}),
    ...(ex.intercepted ? { _intercepted: true } : {}),
  };
}

/** The exchanges as a HAR log ({ log }), credentials masked unless `secrets`. */
export function toHar(list, { version = '0.0.0', secrets = false } = {}) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'Lookout', version },
      pages: [],
      entries: list.filter((ex) => ex.kind === 'http').map((ex) => entry(ex, secrets)),
    },
  };
}

const pairs = (headers) => (Array.isArray(headers) ? headers.map((h) => [String(h.name), String(h.value ?? '')]) : []);
const bytesOf = (text, encoding) => (text == null || text === '' ? null : Buffer.from(String(text), encoding === 'base64' ? 'base64' : 'utf8'));

/** A HAR file's text as exchanges (kind http, `imported`), oldest first; throws when it isn't a HAR. */
export function fromHar(text) {
  let har;
  try {
    har = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`That isn't a HAR file: ${e.message}`);
  }
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) throw new Error("That isn't a HAR file: it has no log.entries.");
  return entries.map((e, i) => {
    const req = e.request ?? {};
    let u;
    try {
      u = new URL(req.url);
    } catch {
      u = null;
    }
    const scheme = u?.protocol === 'https:' ? 'https' : 'http';
    const start = Date.parse(e.startedDateTime) || 0;
    const t = e.timings ?? {};
    const wait = t.wait > 0 ? t.wait : 0;
    const total = Number(e.time) > 0 ? Number(e.time) : wait + (t.receive > 0 ? t.receive : 0);
    // Content-Encoding is dropped: HAR's text is the body after it was undone.
    const resHeaders = pairs(e.response?.headers).filter(([n]) => !/^content-encoding$/i.test(n));
    const reqHeaders = pairs(req.headers).filter(([n]) => !/^content-encoding$/i.test(n));
    const reqBody = bytesOf(req.postData?.text, req.postData?.encoding);
    const resBody = bytesOf(e.response?.content?.text, e.response?.content?.encoding);
    const status = Number(e.response?.status) || 0;
    return {
      id: i + 1,
      kind: 'http',
      state: e._error || !status ? 'error' : 'done',
      at: start,
      scheme,
      method: String(req.method ?? 'GET').toUpperCase(),
      host: u ? u.hostname.replace(/^\[|\]$/g, '') : '',
      port: u ? Number(u.port) || (scheme === 'https' ? 443 : 80) : 0,
      path: u ? `${u.pathname}${u.search}` : String(req.url ?? ''),
      url: String(req.url ?? ''),
      intercepted: Boolean(e._intercepted),
      imported: true,
      note: null,
      error: e._error ?? null,
      request: { httpVersion: String(req.httpVersion ?? 'HTTP/1.1').replace(/^HTTP\//i, ''), headers: reqHeaders, body: reqBody, size: reqBody?.length ?? 0, truncated: Boolean(e._truncated) },
      response: status ? { status, statusText: e.response.statusText ?? '', httpVersion: String(e.response.httpVersion ?? 'HTTP/1.1').replace(/^HTTP\//i, ''), headers: resHeaders, body: resBody, size: resBody?.length ?? 0, truncated: Boolean(e._truncated) } : null,
      timings: { start, connect: t.connect > 0 ? start + t.connect : start, ttfb: start + total - (t.receive > 0 ? t.receive : 0), end: start + total },
    };
  });
}

