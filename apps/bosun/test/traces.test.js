// Local OpenTelemetry traces: OTLP read from protobuf and JSON (otlp.js), the receiver, the store, the
// waterfall and the hand-offs (traces.js), the settings the crew is given, and the Traces view end to end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { gzipSync } from 'node:zlib';
import { decodeTraceJson, decodeTraceRequest } from '../src/otlp.js';
import { TraceStore, bar, decodeBody, otelEnv, shortDuration, spanHandoff, spanRequest, spanText, startOtlpReceiver, traceSummary, waterfall } from '../src/traces.js';
import { Supervisor } from '../src/supervisor.js';
import { contextIn } from '@fleet/kit/family.js';
import { KEYS, project, start, tempHome, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

// --- A tiny protobuf encoder, enough for an ExportTraceServiceRequest --------------------------------

const varint = (v) => {
  let n = BigInt.asUintN(64, BigInt(v));
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
};
const tag = (field, wire) => varint((field << 3) | wire);
const pb = {
  bytes: (field, b) => Buffer.concat([tag(field, 2), varint(b.length), Buffer.from(b)]),
  str: (field, s) => pb.bytes(field, Buffer.from(s, 'utf8')),
  msg: (field, ...parts) => pb.bytes(field, Buffer.concat(parts)),
  uint: (field, v) => Buffer.concat([tag(field, 0), varint(v)]),
  fixed64: (field, v) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    return Buffer.concat([tag(field, 1), b]);
  },
  double: (field, v) => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v);
    return Buffer.concat([tag(field, 1), b]);
  },
};
// KeyValue { key 1, AnyValue value 2 { string 1, bool 2, int 3, double 4, array 5 } }
const kv = (key, value) => {
  const any =
    typeof value === 'string' ? pb.str(1, value) : typeof value === 'boolean' ? pb.uint(2, value ? 1 : 0) : Number.isInteger(value) ? pb.uint(3, value) : Array.isArray(value) ? pb.msg(5, ...value.map((v) => pb.msg(1, pb.str(1, v)))) : pb.double(4, value);
  return Buffer.concat([pb.str(1, key), pb.msg(2, any)]);
};
const MS = 1_000_000n;
const T0 = 1_760_000_000_000n;
const protoSpan = ({ trace, id, parent, name, kind = 1, from, to, attrs = {}, error = false, unknown = false }) =>
  Buffer.concat([
    pb.bytes(1, Buffer.from(trace, 'hex')),
    pb.bytes(2, Buffer.from(id, 'hex')),
    ...(parent ? [pb.bytes(4, Buffer.from(parent, 'hex'))] : []),
    pb.str(5, name),
    pb.uint(6, kind),
    pb.fixed64(7, (T0 + BigInt(from)) * MS),
    pb.fixed64(8, (T0 + BigInt(to)) * MS),
    ...Object.entries(attrs).map(([k, v]) => pb.msg(9, kv(k, v))),
    // An event, and a field OTLP may add one day, which is skipped.
    pb.msg(11, pb.fixed64(1, (T0 + BigInt(from)) * MS), pb.str(2, 'started')),
    ...(unknown ? [pb.uint(99, 7)] : []),
    ...(error ? [pb.msg(15, pb.str(2, 'boom'), pb.uint(3, 2))] : []),
  ]);
const resourceSpans = (service, spans) => pb.msg(1, pb.msg(1, pb.msg(1, kv('service.name', service))), pb.msg(2, pb.msg(1, pb.str(1, 'test-scope')), ...spans.map((s) => pb.msg(2, protoSpan(s)))));

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const PROTO = Buffer.concat([
  resourceSpans('web', [{ trace: TRACE, id: '00f067aa0ba902b7', name: 'GET /orders', kind: 2, from: 0, to: 120, attrs: { 'http.request.method': 'GET', 'url.scheme': 'http', 'server.address': 'localhost', 'server.port': 3000, 'url.path': '/orders' } }]),
  resourceSpans('api', [
    { trace: TRACE, id: '1111111111111111', parent: '00f067aa0ba902b7', name: 'GET /api/orders', kind: 2, from: 10, to: 110, attrs: { 'http.method': 'GET', 'http.url': 'http://localhost:5001/api/orders?top=5', 'http.status_code': 200, ratio: 0.5, tags: ['a', 'b'], cached: false }, unknown: true },
    { trace: TRACE, id: '2222222222222222', parent: '1111111111111111', name: 'SELECT orders', kind: 3, from: 20, to: 100, attrs: { 'db.system': 'postgresql', 'db.namespace': 'shop', 'db.query.text': 'SELECT * FROM orders WHERE id = $1' }, error: true },
  ]),
]);

const jsonRequest = ({ trace = TRACE, offset = 0 } = {}) => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'worker' } }] },
      scopeSpans: [
        {
          scope: { name: 'x' },
          spans: [
            { traceId: trace, spanId: 'aaaaaaaaaaaaaaaa', name: 'job', kind: 1, startTimeUnixNano: String((T0 + BigInt(offset)) * MS), endTimeUnixNano: String((T0 + BigInt(offset) + 40n) * MS), attributes: [{ key: 'n', value: { intValue: '42' } }, { key: 'ok', value: { boolValue: true } }], status: {} },
            { traceId: trace, spanId: 'bbbbbbbbbbbbbbbb', parentSpanId: 'aaaaaaaaaaaaaaaa', name: 'UPDATE jobs', kind: 'SPAN_KIND_CLIENT', startTimeUnixNano: String((T0 + BigInt(offset) + 5n) * MS), endTimeUnixNano: String((T0 + BigInt(offset) + 15n) * MS), attributes: [{ key: 'db.statement', value: { stringValue: 'UPDATE jobs SET done = 1' } }, { key: 'db.name', value: { stringValue: 'queue' } }], status: { code: 'STATUS_CODE_ERROR', message: 'deadlock' } },
          ],
        },
      ],
    },
  ],
});

test('OTLP protobuf is read into spans: ids, times, kinds, attributes of every type, events and status', () => {
  const spans = decodeTraceRequest(PROTO);
  assert.equal(spans.length, 3);
  const [web, api, db] = spans;
  assert.equal(web.traceId, TRACE);
  assert.equal(web.spanId, '00f067aa0ba902b7');
  assert.equal(web.parentId, '');
  assert.equal(web.service, 'web');
  assert.equal(web.kind, 'server');
  assert.equal(web.end - web.start, 120);
  assert.equal(api.parentId, '00f067aa0ba902b7');
  assert.deepEqual(api.attrs, { 'http.method': 'GET', 'http.url': 'http://localhost:5001/api/orders?top=5', 'http.status_code': 200, ratio: 0.5, tags: ['a', 'b'], cached: false });
  assert.equal(api.events[0].name, 'started');
  assert.equal(db.kind, 'client');
  assert.deepEqual(db.status, { code: 2, message: 'boom' });
  assert.equal(db.resource['service.name'], 'api');
  assert.throws(() => decodeTraceRequest(Buffer.from([0x0a, 0x10, 0x01])), /ends inside/);
});

test('OTLP JSON is read the same way, with string kinds and codes and 64-bit integers as strings', () => {
  const [job, update] = decodeTraceJson(JSON.stringify(jsonRequest()));
  assert.equal(job.service, 'worker');
  assert.equal(job.kind, 'internal');
  assert.deepEqual(job.attrs, { n: 42, ok: true });
  assert.equal(update.kind, 'client');
  assert.deepEqual(update.status, { code: 2, message: 'deadlock' });
  assert.equal(update.parentId, 'aaaaaaaaaaaaaaaa');
  // snake_case, as some exporters write the proto's names, and base64 ids.
  const [snake] = decodeTraceJson({ resource_spans: [{ scope_spans: [{ spans: [{ trace_id: Buffer.from(TRACE, 'hex').toString('base64'), span_id: 'AAAAAAAAAAE=', name: 's', start_time_unix_nano: '1000000', end_time_unix_nano: '3000000' }] }] }] });
  assert.equal(snake.traceId, TRACE);
  assert.equal(snake.spanId, '0000000000000001');
  assert.equal(snake.end - snake.start, 2);
  assert.equal(snake.service, 'unknown');
  // gzip, as exporters may send it.
  assert.equal(decodeBody(gzipSync(PROTO), { type: 'application/x-protobuf', encoding: 'gzip' }).spans.length, 3);
});

test('the store keeps traces slowest first, bounded by count and age, and the waterfall nests spans under their parents', () => {
  let changes = 0;
  const store = new TraceStore({ max: 2, maxAge: 1000, onChange: () => changes++ });
  store.add(decodeTraceRequest(PROTO), 0);
  store.add(decodeTraceJson(jsonRequest({ trace: 'f'.repeat(32) })), 10);
  assert.equal(changes, 2);
  const list = store.list(20);
  assert.deepEqual(list.map((t) => t.name), ['GET /orders', 'job']);
  assert.deepEqual(list[0].services, ['web', 'api']);
  assert.equal(list[0].errors, 1);
  assert.equal(list[0].duration, 120);
  // A third pushes out the one heard of longest ago; age drops the rest.
  store.add(decodeTraceJson(jsonRequest({ trace: 'e'.repeat(32) })), 30);
  assert.deepEqual(store.list(30).map((t) => t.id), ['f'.repeat(32), 'e'.repeat(32)]);
  assert.equal(store.list(1020).length, 1);
  assert.equal(store.list(5000).length, 0);

  const spans = decodeTraceRequest(PROTO);
  // An orphan (its parent never arrived) starts a tree of its own.
  const orphan = { ...spans[2], spanId: '3333333333333333', parentId: '9999999999999999', name: 'late', start: spans[0].start + 200, end: spans[0].start + 210 };
  const rows = waterfall([spans[2], orphan, spans[1], spans[0]]);
  assert.deepEqual(rows.map((r) => [r.span.name, r.depth]), [['GET /orders', 0], ['GET /api/orders', 1], ['SELECT orders', 2], ['late', 0]]);
  const s = traceSummary({ spans: new Map(spans.map((x) => [x.spanId, x])) });
  assert.deepEqual(bar(spans[0], s.start, s.duration, 12), { before: 0, len: 12, after: 0 });
  assert.deepEqual(bar(spans[2], s.start, s.duration, 12), { before: 2, len: 8, after: 2 });
  assert.equal(shortDuration(0.5), '500 µs');
  assert.equal(shortDuration(12.34), '12.3 ms');
  assert.equal(shortDuration(3200), '3.20 s');
  assert.match(spanText(spans[2], s.start), /db\.query\.text = SELECT \* FROM orders/);
});

test('a span hands its SQL to Trawl and its request to Hail, from current and older conventions', () => {
  const [web, api, db] = decodeTraceRequest(PROTO);
  const q = spanHandoff(db);
  assert.equal(q.app, 'trawl');
  const qc = contextIn(q.line);
  assert.equal(qc.kind, 'query');
  assert.equal(qc.data.sql, 'SELECT * FROM orders WHERE id = $1');
  assert.equal(qc.data.database, 'shop');
  assert.equal(qc.data.slow.failed, 1);
  const r = contextIn(spanHandoff(api).line);
  assert.equal(r.kind, 'request');
  assert.deepEqual([r.data.method, r.data.url], ['GET', 'http://localhost:5001/api/orders?top=5']);
  // A server span gives its parts rather than url.full.
  assert.deepEqual(spanRequest(web), { method: 'GET', url: 'http://localhost:3000/orders' });
  assert.deepEqual(spanRequest({ attrs: { 'http.request.method': 'post', 'url.full': 'https://x.test/a' } }), { method: 'POST', url: 'https://x.test/a' });
  const [, update] = decodeTraceJson(jsonRequest());
  assert.equal(contextIn(spanHandoff(update).line).data.sql, 'UPDATE jobs SET done = 1');
  assert.equal(spanHandoff({ attrs: { 'rpc.system': 'grpc' } }), null);
});

const freePort = () =>
  new Promise((done) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });

test('the receiver takes OTLP/HTTP as protobuf and JSON, drops metrics, refuses what it can\'t read, and moves past a taken port', async () => {
  const got = [];
  const port = await freePort();
  const blocker = createServer().listen(port, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const rx = await startOtlpReceiver({ port, onSpans: (s) => got.push(...s) });
  try {
    assert.notEqual(rx.port, port);
    assert.equal(rx.endpoint, `http://127.0.0.1:${rx.port}`);
    const post = (path, body, type, extra = {}) => fetch(`${rx.endpoint}${path}`, { method: 'POST', headers: { 'content-type': type, ...extra }, body });
    let r = await post('/v1/traces', PROTO, 'application/x-protobuf');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/x-protobuf');
    r = await post('/v1/traces', JSON.stringify(jsonRequest()), 'application/json');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {});
    r = await post('/v1/traces', gzipSync(PROTO), 'application/x-protobuf', { 'content-encoding': 'gzip' });
    assert.equal(r.status, 200);
    r = await post('/v1/metrics', '{"resourceMetrics":[]}', 'application/json');
    assert.equal(r.status, 200);
    r = await post('/v1/traces', '{not json', 'application/json');
    assert.equal(r.status, 400);
    assert.equal(got.length, 3 + 2 + 3);
  } finally {
    await rx.close();
    blocker.close();
  }
});

test('the processes Bosun starts get the receiver, their name as the service, and what bosun.json sets wins', async () => {
  const dir = project({}, { 'env.js': "console.log(['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_SERVICE_NAME'].map((k) => k + '=' + process.env[k]).join(' '))" });
  const procs = [
    { name: 'api', run: 'node env.js', cwd: '.', env: {} },
    { name: 'own', run: 'node env.js', cwd: '.', env: { OTEL_SERVICE_NAME: 'mine' } },
  ];
  const sup = new Supervisor(procs, { dir, otel: 'http://127.0.0.1:4999' });
  try {
    sup.startAll();
    const said = (name) => sup.list().find((p) => p.name === name).lines.map((l) => l.text).join('\n');
    await until(() => said('api').includes('OTEL_SERVICE_NAME') && said('own').includes('OTEL_SERVICE_NAME'), 'both said their settings');
    assert.match(said('api'), /OTEL_EXPORTER_OTLP_ENDPOINT=http:\/\/127\.0\.0\.1:4999 OTEL_EXPORTER_OTLP_PROTOCOL=http\/protobuf OTEL_SERVICE_NAME=api/);
    assert.match(said('own'), /OTEL_SERVICE_NAME=mine/);
  } finally {
    sup.dispose();
  }
  assert.deepEqual(otelEnv('http://x', 'web'), { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf', OTEL_SERVICE_NAME: 'web' });
});

// A process that exports one trace to what Bosun gave it: web calls the api, which queries the database.
const EXPORTER = `
const T = BigInt(Date.now()) * 1000000n, ms = 1000000n, s = (v) => ({ stringValue: v });
const span = (id, parent, name, from, to, attrs) => ({ traceId: '${TRACE}', spanId: id, parentSpanId: parent, name, kind: 2, startTimeUnixNano: String(T + BigInt(from) * ms), endTimeUnixNano: String(T + BigInt(to) * ms), attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: s(v) })) });
const res = (service, spans) => ({ resource: { attributes: [{ key: 'service.name', value: s(service) }] }, scopeSpans: [{ spans }] });
const body = { resourceSpans: [
  res(process.env.OTEL_SERVICE_NAME, [span('00f067aa0ba902b7', '', 'GET /orders', 0, 240, { 'http.request.method': 'GET', 'url.full': 'http://localhost:3000/orders' })]),
  res('api', [span('1111111111111111', '00f067aa0ba902b7', 'GET /api/orders', 20, 220, { 'http.method': 'GET', 'http.url': 'http://localhost:5001/api/orders' }),
              span('2222222222222222', '1111111111111111', 'SELECT orders', 40, 200, { 'db.system': 'postgresql', 'db.statement': 'SELECT * FROM orders' })]),
] };
fetch(process.env.OTEL_EXPORTER_OTLP_ENDPOINT + '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then((r) => console.log('exported ' + r.status), (e) => console.log('failed ' + e.message));
setInterval(() => {}, 1000);
`;

test('the Traces view: the crew\'s trace slowest first, its waterfall, a span\'s attributes, and its SQL to Trawl', async () => {
  const dir = project({ procs: { web: 'node exporter.js' } }, { 'exporter.js': EXPORTER });
  const copied = [];
  const app = start({ dir, copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('exported 200'), 'the trace exported');
    app.stdin.write('3');
    await until(() => frame().includes('╭─ Traces') && frame().includes('GET /orders'), 'the trace in the list');
    assert.match(frame(), /240\.0 ms|240 ms/);
    assert.match(frame(), /web → api\s+3 spans/);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Trace GET /orders') && frame().includes('SELECT orders'), 'the waterfall');
    assert.match(frame(), /web\s+GET \/orders\s+█+/);
    assert.match(frame(), /api\s+ {4}SELECT orders\s+ +█+/);
    app.stdin.write('j');
    app.stdin.write('j');
    await until(() => /❯ api\s+ {4}SELECT orders/.test(frame()), 'on the query');
    app.stdin.write('t');
    await until(() => copied.length === 1, 'the query copied');
    const ctx = contextIn(copied[0]);
    assert.equal(ctx.kind, 'query');
    assert.equal(ctx.data.sql, 'SELECT * FROM orders');
    assert.match(frame(), /for Trawl/);
    app.stdin.write('k');
    await until(() => /❯ api\s+ {2}GET \/api\/orders/.test(frame()), 'on the request');
    app.stdin.write('t');
    await until(() => copied.length === 2, 'the request copied');
    assert.deepEqual([contextIn(copied[1]).kind, contextIn(copied[1]).data.url], ['request', 'http://localhost:5001/api/orders']);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('http.url = http://localhost:5001/api/orders'), 'its attributes');
    app.stdin.write(KEYS.esc);
    await until(() => /❯ api\s+ {2}GET \/api\/orders/.test(frame()), 'back on the waterfall, on the same span');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('╭─ Traces'), 'back on the list');
  } finally {
    app.unmount();
  }
});
