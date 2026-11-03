// OpenTelemetry's trace export (OTLP), read into plain spans: the protobuf a collector receives
// (ExportTraceServiceRequest, as opentelemetry-proto numbers its fields) and its JSON mapping. Only
// what the Traces view needs is decoded; everything else is skipped by its wire type. Pure, and with
// no dependency, so it builds into the one executable.

/**
 * A span as Bosun keeps it: { traceId, spanId, parentId, name, kind, service, start, end (ms since
 * the epoch, with fractions), attrs ({ key: value }, the resource's under `resource`), status
 * ({ code, message }), events ([{ name, time, attrs }]) }.
 */

// SpanKind, as the proto numbers it.
export const KINDS = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];
// StatusCode: 0 unset, 1 ok, 2 error.
export const STATUS = ['unset', 'ok', 'error'];

// --- The protobuf wire ---------------------------------------------------------------------------------

/** The fields of one message in `buf`: [{ field, wire, value }], value a BigInt (varint, fixed64, whose bytes are `raw` too), a number (fixed32) or bytes. */
export function readFields(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const out = [];
  let i = 0;
  const varint = () => {
    let n = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error('The protobuf ends inside a number.');
      const b = buf[i++];
      n |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return n;
      shift += 7n;
      if (shift > 70n) throw new Error('A protobuf number is too long.');
    }
  };
  while (i < buf.length) {
    const key = varint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) out.push({ field, wire, value: varint() });
    else if (wire === 1) {
      if (i + 8 > buf.length) throw new Error('The protobuf ends inside a fixed64.');
      out.push({ field, wire, value: buf.readBigUInt64LE(i), raw: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      const len = Number(varint());
      if (i + len > buf.length) throw new Error('The protobuf ends inside a field.');
      out.push({ field, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      if (i + 4 > buf.length) throw new Error('The protobuf ends inside a fixed32.');
      out.push({ field, wire, value: buf.readUInt32LE(i) });
      i += 4;
    } else throw new Error(`The protobuf has a field of wire type ${wire}, which OTLP never sends.`);
  }
  return out;
}

const text = (b) => Buffer.from(b).toString('utf8');
const hex = (b) => Buffer.from(b).toString('hex');
const nanosToMs = (n) => Number(BigInt(n) / 1000n) / 1000;

// AnyValue: one of string 1, bool 2, int64 3, double 4, ArrayValue 5, KeyValueList 6, bytes 7.
function anyValue(buf) {
  let v = null;
  for (const f of readFields(buf)) {
    if (f.field === 1 && f.wire === 2) v = text(f.value);
    else if (f.field === 2 && f.wire === 0) v = f.value !== 0n;
    else if (f.field === 3 && f.wire === 0) v = safeNumber(BigInt.asIntN(64, f.value));
    else if (f.field === 4 && f.wire === 1) v = f.raw.readDoubleLE(0);
    else if (f.field === 5 && f.wire === 2) v = readFields(f.value).filter((x) => x.field === 1 && x.wire === 2).map((x) => anyValue(x.value));
    else if (f.field === 6 && f.wire === 2) v = keyValues(readFields(f.value).filter((x) => x.field === 1 && x.wire === 2).map((x) => x.value));
    else if (f.field === 7 && f.wire === 2) v = Buffer.from(f.value).toString('base64');
  }
  return v;
}

// A 64-bit integer as a number when it's exact, else as its digits.
const safeNumber = (n) => (n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(n) : String(n));

// KeyValue: string key 1, AnyValue value 2.
function keyValues(list) {
  const out = {};
  for (const b of list) {
    let key = '';
    let value = null;
    for (const f of readFields(b)) {
      if (f.field === 1 && f.wire === 2) key = text(f.value);
      else if (f.field === 2 && f.wire === 2) value = anyValue(f.value);
    }
    if (key) out[key] = value;
  }
  return out;
}

const messages = (fields, n) => fields.filter((f) => f.field === n && f.wire === 2).map((f) => f.value);

/** An ExportTraceServiceRequest's bytes as spans. Throws when they aren't protobuf. */
export function decodeTraceRequest(buf) {
  const spans = [];
  // ResourceSpans 1: Resource resource 1, ScopeSpans scope_spans 2 (the old InstrumentationLibrarySpans 1000 the same).
  for (const rs of messages(readFields(buf), 1)) {
    const rsf = readFields(rs);
    const resource = keyValues(messages(messages(rsf, 1).flatMap((r) => readFields(r)), 1));
    for (const ss of [...messages(rsf, 2), ...messages(rsf, 1000)]) {
      // ScopeSpans: InstrumentationScope scope 1, Span spans 2.
      for (const s of messages(readFields(ss), 2)) spans.push(protoSpan(readFields(s), resource));
    }
  }
  return spans;
}

// Span: trace_id 1, span_id 2, parent_span_id 4, name 5, kind 6, start 7 and end 8 (fixed64 ns),
// attributes 9, events 11, status 15 (message 2, code 3).
function protoSpan(fields, resource) {
  const s = { traceId: '', spanId: '', parentId: '', name: '', kind: 0, start: 0, end: 0, attrs: {}, status: { code: 0, message: '' }, events: [] };
  const attrs = [];
  for (const f of fields) {
    if (f.field === 1 && f.wire === 2) s.traceId = hex(f.value);
    else if (f.field === 2 && f.wire === 2) s.spanId = hex(f.value);
    else if (f.field === 4 && f.wire === 2) s.parentId = hex(f.value);
    else if (f.field === 5 && f.wire === 2) s.name = text(f.value);
    else if (f.field === 6 && f.wire === 0) s.kind = Number(f.value);
    else if (f.field === 7 && f.wire === 1) s.start = nanosToMs(f.value);
    else if (f.field === 8 && f.wire === 1) s.end = nanosToMs(f.value);
    else if (f.field === 9 && f.wire === 2) attrs.push(f.value);
    else if (f.field === 11 && f.wire === 2) {
      const ev = { name: '', time: 0, attrs: {} };
      const evAttrs = [];
      for (const e of readFields(f.value)) {
        if (e.field === 1 && e.wire === 1) ev.time = nanosToMs(e.value);
        else if (e.field === 2 && e.wire === 2) ev.name = text(e.value);
        else if (e.field === 3 && e.wire === 2) evAttrs.push(e.value);
      }
      ev.attrs = keyValues(evAttrs);
      s.events.push(ev);
    } else if (f.field === 15 && f.wire === 2) {
      for (const st of readFields(f.value)) {
        if (st.field === 2 && st.wire === 2) s.status.message = text(st.value);
        else if (st.field === 3 && st.wire === 0) s.status.code = Number(st.value);
      }
    }
  }
  s.attrs = keyValues(attrs);
  return finish(s, resource);
}

function finish(s, resource) {
  return { ...s, kind: KINDS[s.kind] ?? 'unspecified', service: String(resource['service.name'] ?? 'unknown'), resource };
}

// --- The JSON mapping ----------------------------------------------------------------------------------

// OTLP/JSON is lowerCamelCase; some exporters send the proto's snake_case names, which are read too.
const get = (o, camel) => o?.[camel] ?? o?.[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];

function jsonAny(v) {
  if (!v || typeof v !== 'object') return v ?? null;
  if (get(v, 'stringValue') !== undefined) return String(get(v, 'stringValue'));
  if (get(v, 'boolValue') !== undefined) return Boolean(get(v, 'boolValue'));
  if (get(v, 'intValue') !== undefined) return safeNumber(BigInt(get(v, 'intValue')));
  if (get(v, 'doubleValue') !== undefined) return Number(get(v, 'doubleValue'));
  if (get(v, 'arrayValue') !== undefined) return (get(v, 'arrayValue')?.values ?? []).map(jsonAny);
  if (get(v, 'kvlistValue') !== undefined) return jsonAttrs(get(v, 'kvlistValue')?.values);
  if (get(v, 'bytesValue') !== undefined) return String(get(v, 'bytesValue'));
  return null;
}

const jsonAttrs = (list) => Object.fromEntries((Array.isArray(list) ? list : []).filter((kv) => kv?.key).map((kv) => [kv.key, jsonAny(kv.value)]));

// IDs are hex in OTLP/JSON; a base64 one (proto3's own JSON mapping, which some send) is turned into hex.
const jsonId = (id) => {
  const s = String(id ?? '');
  if (!s || /^[0-9a-f]+$/i.test(s)) return s.toLowerCase();
  return Buffer.from(s, 'base64').toString('hex');
};

const jsonKind = (k) => (typeof k === 'number' ? k : Math.max(0, KINDS.indexOf(String(k ?? '').replace(/^SPAN_KIND_/, '').toLowerCase())));
const jsonCode = (c) => (typeof c === 'number' ? c : Math.max(0, STATUS.indexOf(String(c ?? '').replace(/^STATUS_CODE_/, '').toLowerCase())));
const jsonNanos = (n) => (n == null || n === '' ? 0 : nanosToMs(BigInt(typeof n === 'number' ? Math.round(n) : String(n))));

/** An ExportTraceServiceRequest as OTLP/JSON (the object, or its text) as spans. */
export function decodeTraceJson(body) {
  const req = typeof body === 'string' ? JSON.parse(body) : body;
  const spans = [];
  for (const rs of get(req, 'resourceSpans') ?? []) {
    const resource = jsonAttrs(rs?.resource?.attributes);
    for (const ss of [...(get(rs, 'scopeSpans') ?? []), ...(get(rs, 'instrumentationLibrarySpans') ?? [])]) {
      for (const sp of ss?.spans ?? []) {
        spans.push(
          finish(
            {
              traceId: jsonId(get(sp, 'traceId')),
              spanId: jsonId(get(sp, 'spanId')),
              parentId: jsonId(get(sp, 'parentSpanId')),
              name: String(sp.name ?? ''),
              kind: jsonKind(sp.kind),
              start: jsonNanos(get(sp, 'startTimeUnixNano')),
              end: jsonNanos(get(sp, 'endTimeUnixNano')),
              attrs: jsonAttrs(sp.attributes),
              status: { code: jsonCode(sp.status?.code), message: String(sp.status?.message ?? '') },
              events: (sp.events ?? []).map((e) => ({ name: String(e?.name ?? ''), time: jsonNanos(get(e, 'timeUnixNano')), attrs: jsonAttrs(e?.attributes) })),
            },
            resource,
          ),
        );
      }
    }
  }
  return spans;
}
