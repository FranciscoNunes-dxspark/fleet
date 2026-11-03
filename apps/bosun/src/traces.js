// Local OpenTelemetry traces: a small OTLP/HTTP receiver on 127.0.0.1 that the processes Bosun starts
// export to (the supervisor's `otel`, otelEnv), the traces it keeps (TraceStore, bounded by count and
// age), and what the Traces view draws from them (traceRows, waterfall, bar) and hands to the
// siblings (spanHandoff). Everything but startOtlpReceiver is pure.
import { createServer } from 'node:http';
import { gunzipSync, inflateSync } from 'node:zlib';
import { takeLine } from '@fleet/kit/family.js';
import { decodeTraceJson, decodeTraceRequest } from './otlp.js';

export const OTLP_PORT = 4318;
// What's kept: the newest traces up to MAX_TRACES, none older than MAX_AGE, and a trace's first MAX_SPANS spans.
export const MAX_TRACES = 300;
export const MAX_AGE = 30 * 60_000;
export const MAX_SPANS = 2000;
// A request bigger than this is refused (413): an exporter sends batches far smaller.
const MAX_BODY = 32 * 1024 * 1024;

/** The settings a process exports its traces with: Bosun's receiver, and its name in the crew as the service. */
export const otelEnv = (endpoint, name) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf', OTEL_SERVICE_NAME: name });

/**
 * The traces received, in memory: spans grouped by trace id. `add(spans, now)` keeps them (calling
 * `onChange`), dropping the oldest traces past `max` and those not heard of for `maxAge`.
 */
export class TraceStore {
  constructor({ max = MAX_TRACES, maxAge = MAX_AGE, maxSpans = MAX_SPANS, onChange = () => {} } = {}) {
    Object.assign(this, { max, maxAge, maxSpans, onChange });
    this.traces = new Map();
    this.received = 0;
  }

  add(spans, now = Date.now()) {
    for (const s of spans) {
      if (!s.traceId || !s.spanId) continue;
      let t = this.traces.get(s.traceId);
      if (!t) {
        t = { id: s.traceId, spans: new Map(), seen: now };
        this.traces.set(s.traceId, t);
      }
      // A trace keeps its place by when it was last heard of: Map order is insertion order.
      this.traces.delete(s.traceId);
      this.traces.set(s.traceId, t);
      t.seen = now;
      if (t.spans.size < this.maxSpans || t.spans.has(s.spanId)) t.spans.set(s.spanId, s);
      this.received++;
    }
    this.prune(now);
    if (spans.length) this.onChange();
  }

  prune(now = Date.now()) {
    for (const [id, t] of this.traces) {
      if (this.traces.size > this.max || now - t.seen > this.maxAge) this.traces.delete(id);
      else break;
    }
  }

  clear() {
    this.traces.clear();
    this.onChange();
  }

  get(id) {
    return this.traces.get(id) ?? null;
  }

  /** The traces as rows (traceSummary), slowest first. */
  list(now = Date.now()) {
    this.prune(now);
    return [...this.traces.values()].map(traceSummary).sort((a, b) => b.duration - a.duration || b.start - a.start);
  }
}

/** A trace's root span: the one whose parent isn't in it (the earliest such), else the earliest. */
export function rootOf(spans) {
  const ids = new Set(spans.map((s) => s.spanId));
  const byStart = [...spans].sort((a, b) => a.start - b.start);
  return byStart.find((s) => !s.parentId || !ids.has(s.parentId)) ?? byStart[0] ?? null;
}

/** { id, name, service, services, spans, start, end, duration, errors } for a trace in the store. */
export function traceSummary(t) {
  const spans = [...t.spans.values()];
  const root = rootOf(spans);
  const start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end || s.start));
  return {
    id: t.id,
    name: root?.name ?? '?',
    service: root?.service ?? '?',
    services: [...new Set(spans.map((s) => s.service))],
    spans: spans.length,
    start,
    end,
    duration: Math.max(0, end - start),
    errors: spans.filter((s) => s.status?.code === 2).length,
    seen: t.seen,
  };
}

/**
 * The waterfall: every span under its parent, by start, as [{ span, depth }]. A span whose parent
 * never arrived starts a tree of its own, so nothing is lost.
 */
export function waterfall(spans) {
  const ids = new Set(spans.map((s) => s.spanId));
  const children = new Map();
  for (const s of spans) {
    const parent = s.parentId && ids.has(s.parentId) && s.parentId !== s.spanId ? s.parentId : '';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(s);
  }
  for (const list of children.values()) list.sort((a, b) => a.start - b.start);
  const out = [];
  const seen = new Set();
  const walk = (parent, depth) => {
    for (const s of children.get(parent) ?? []) {
      if (seen.has(s.spanId)) continue;
      seen.add(s.spanId);
      out.push({ span: s, depth });
      walk(s.spanId, depth + 1);
    }
  };
  walk('', 0);
  // A loop of parents (a broken exporter) never reaches the roots: shown flat after them.
  for (const s of spans) if (!seen.has(s.spanId)) out.push({ span: s, depth: 0 });
  return out;
}

/** A span's place in its trace as a bar `width` cells wide: { before, len, after }, at least one cell long. */
export function bar(span, start, duration, width) {
  if (width <= 0) return { before: 0, len: 0, after: 0 };
  const total = duration > 0 ? duration : 1;
  const before = Math.min(width - 1, Math.max(0, Math.floor(((span.start - start) / total) * width)));
  const len = Math.max(1, Math.min(width - before, Math.round((((span.end || span.start) - span.start) / total) * width)));
  return { before, len, after: width - before - len };
}

/** A duration in ms as people read it: 840 µs, 12.4 ms, 3.20 s. */
export function shortDuration(ms) {
  if (!(ms >= 0)) return '?';
  if (ms < 1) return `${Math.round(ms * 1000)} µs`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** The SQL a span ran: db.query.text (current semantic conventions), else the older db.statement. */
export const spanSql = (span) => String(span.attrs?.['db.query.text'] ?? span.attrs?.['db.statement'] ?? '').trim() || null;

/** The request an HTTP span made or served: { method, url }, from the current or the older conventions; null when it isn't one. */
export function spanRequest(span) {
  const a = span.attrs ?? {};
  const method = a['http.request.method'] ?? a['http.method'];
  if (!method) return null;
  let url = a['url.full'] ?? a['http.url'];
  if (!url) {
    // A server span names its parts rather than the whole address.
    const scheme = a['url.scheme'] ?? a['http.scheme'] ?? 'http';
    const host = a['server.address'] ? `${a['server.address']}${a['server.port'] ? `:${a['server.port']}` : ''}` : a['http.host'] ?? (a['net.host.name'] ? `${a['net.host.name']}${a['net.host.port'] ? `:${a['net.host.port']}` : ''}` : null);
    const path = a['url.path'] ? `${a['url.path']}${a['url.query'] ? `?${a['url.query']}` : ''}` : a['http.target'];
    if (!host || !path) return null;
    url = `${scheme}://${host}${path}`;
  }
  return { method: String(method).toUpperCase(), url: String(url) };
}

/**
 * What a span offers a sibling: its SQL to Trawl as a `query` context, or its request to Hail as a
 * `request`; { app, line, what } or null. Attribute values other than these never leave Bosun.
 */
export function spanHandoff(span) {
  const sql = spanSql(span);
  if (sql) {
    const database = span.attrs['db.namespace'] ?? span.attrs['db.name'];
    const ms = Math.round(((span.end || span.start) - span.start) * 10) / 10;
    return { app: 'trawl', what: 'the query', line: takeLine('query', { sql, ...(database ? { database: String(database) } : {}), slow: { calls: 1, avg: ms, p95: ms, ...(span.status?.code === 2 ? { failed: 1 } : {}), span: span.name, app: span.service } }) };
  }
  const req = spanRequest(span);
  if (req) return { app: 'hail', what: 'the request', line: takeLine('request', { ...req, name: `${span.service}: ${span.name}`, app: 'bosun' }) };
  return null;
}

/** The text ↵ shows for a span: what it is, its attributes, its resource's, and its events. */
export function spanText(span, traceStart) {
  const lines = [
    `${span.service} · ${span.name}`,
    `kind ${span.kind} · ${shortDuration((span.end || span.start) - span.start)} · from +${shortDuration(span.start - traceStart)}`,
    `status ${['unset', 'ok', 'error'][span.status?.code] ?? span.status?.code}${span.status?.message ? `: ${span.status.message}` : ''}`,
    `trace ${span.traceId} · span ${span.spanId}${span.parentId ? ` · parent ${span.parentId}` : ''}`,
  ];
  const kv = (o) => Object.entries(o ?? {}).map(([k, v]) => `  ${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  if (Object.keys(span.attrs ?? {}).length) lines.push('', 'Attributes', ...kv(span.attrs));
  if (Object.keys(span.resource ?? {}).length) lines.push('', 'Resource', ...kv(span.resource));
  if (span.events?.length) {
    lines.push('', 'Events');
    for (const e of span.events) lines.push(`  +${shortDuration(e.time - traceStart)} ${e.name}`, ...kv(e.attrs).map((l) => `  ${l}`));
  }
  return lines.join('\n');
}

/** A request's body as spans, by its content type (JSON or protobuf) and encoding (gzip, deflate). */
export function decodeBody(body, { type = '', encoding = '' } = {}) {
  let buf = body;
  const enc = String(encoding).toLowerCase();
  if (enc === 'gzip') buf = gunzipSync(buf);
  else if (enc === 'deflate') buf = inflateSync(buf);
  if (/json/i.test(type)) return { json: true, spans: decodeTraceJson(buf.toString('utf8')) };
  return { json: false, spans: decodeTraceRequest(buf) };
}

/**
 * The receiver: OTLP/HTTP on 127.0.0.1, `port` or the next free one (up to `tries` further). POST
 * /v1/traces gives `onSpans` the spans; metrics and logs are taken and dropped, so an exporter of
 * them doesn't complain. Resolves { port, endpoint, close() }.
 */
export async function startOtlpReceiver({ port = OTLP_PORT, tries = 20, host = '127.0.0.1', onSpans = () => {} } = {}) {
  const server = createServer((req, res) => {
    const reply = (status, json, body) => {
      res.writeHead(status, { 'content-type': json ? 'application/json' : 'application/x-protobuf' });
      res.end(body ?? (json ? '{}' : ''));
    };
    const json = /json/i.test(req.headers['content-type'] ?? '');
    if (req.method !== 'POST') return reply(405, true, JSON.stringify({ message: 'OTLP takes POST' }));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reply(413, json, json ? JSON.stringify({ message: 'too big' }) : undefined);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      const path = (req.url ?? '').split('?')[0];
      if (path !== '/v1/traces') return reply(200, json);
      try {
        const { spans } = decodeBody(Buffer.concat(chunks), { type: req.headers['content-type'], encoding: req.headers['content-encoding'] });
        onSpans(spans);
        reply(200, json);
      } catch (e) {
        reply(400, json, json ? JSON.stringify({ message: e.message }) : undefined);
      }
    });
    req.on('error', () => {});
  });
  server.on('clientError', (_, socket) => socket.destroy());
  for (let p = port, n = 0; ; p++, n++) {
    try {
      await new Promise((done, fail) => {
        server.once('error', fail);
        server.listen(p, host, () => {
          server.off('error', fail);
          done();
        });
      });
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || n >= tries) throw e;
    }
  }
  // Nothing waits on it: Bosun quits however long an exporter holds a connection open.
  server.unref();
  const bound = server.address().port;
  return {
    port: bound,
    endpoint: `http://${host}:${bound}`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
