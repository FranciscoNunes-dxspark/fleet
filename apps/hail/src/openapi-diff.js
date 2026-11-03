// What changed between two versions of an API's description (OpenAPI 3.0 or 3.1, or Swagger 2), and
// whether each change breaks the clients written against the old one. Pure, but loadSpec.
//
// Operations are matched by method and path, the path's {parameters} by position, so renaming
// {id} to {userId} changes nothing. Schemas are compared with the direction in mind: what a client
// sends (parameters, the request body) breaks it when the new version accepts less (a narrower type,
// an enum value gone, a new required field), and what it gets back (responses) breaks it when the new
// version may say more or other than it did (a field gone, a wider type, a value that may now be null);
// a new enum value in a response may break a client that switches over the values, so it's said as
// "may break". $refs are followed within the document; one to another file isn't.
import { relative, resolve, isAbsolute, dirname, basename } from 'node:path';
import { run as runCommand } from '@fleet/kit/run.js';
import { deref, loadContract, parseContract } from './contract.js';

export const LEVELS = ['breaking', 'may-break', 'non-breaking'];
const LEVEL_NAMES = { breaking: 'Breaking', 'may-break': 'May break', 'non-breaking': 'Non-breaking' };
const MARKS = { breaking: '✗', 'may-break': '!', 'non-breaking': '+' };
const TONES = { breaking: 'del', 'may-break': 'warn', 'non-breaking': 'add' };
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** "OpenAPI 3.1.0" or "Swagger 2.0": what the document says it is. */
export const specKind = (spec) => (spec?.openapi ? `OpenAPI ${spec.openapi}` : spec?.swagger ? `Swagger ${spec.swagger}` : 'OpenAPI');

/** The document's name and version from its info, and what it is: { title, version, kind }. */
export const specInfo = (spec) => ({ title: spec?.info?.title ?? null, version: spec?.info?.version != null ? String(spec.info.version) : null, kind: specKind(spec) });

// A path with its parameters' names left out: /users/{id} and /users/{userId} are the same path.
const pathKey = (path) => String(path).replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '') || '/';
const pathNames = (path) => [...String(path).matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);

/** The document's operations: Map of "GET /users/{}" to { method, path, op, item }. */
function operations(spec) {
  const out = new Map();
  for (const [path, raw] of Object.entries(spec.paths ?? {})) {
    const item = deref(spec, raw) ?? {};
    for (const m of HTTP_METHODS) if (item[m] && typeof item[m] === 'object') out.set(`${m.toUpperCase()} ${pathKey(path)}`, { method: m.toUpperCase(), path, op: item[m], item });
  }
  return out;
}

// What Swagger 2 says inline about a parameter that isn't a body, as a schema.
const INLINE = ['type', 'format', 'enum', 'items', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'x-nullable', 'default'];
const inlineSchema = (p) => Object.fromEntries(INLINE.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));

/**
 * The operation's parameters but a body: Map of a key ("query:limit", a path parameter by its place,
 * "path:#0") to { name, in, required, schema, deprecated }. The operation's win over its path's.
 */
function parameters(spec, { op, item, path }) {
  const out = new Map();
  const names = pathNames(path);
  for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
    const p = deref(spec, raw);
    if (!p || typeof p !== 'object' || !p.name || !p.in || p.in === 'body' || p.in === 'formData') continue;
    const at = names.indexOf(p.name);
    const key = p.in === 'path' && at >= 0 ? `path:#${at}` : `${p.in}:${p.in === 'header' ? p.name.toLowerCase() : p.name}`;
    out.set(key, { name: p.name, in: p.in, required: p.in === 'path' || Boolean(p.required), schema: p.schema ?? (p.content ? Object.values(p.content)[0]?.schema : null) ?? inlineSchema(p), deprecated: Boolean(p.deprecated) });
  }
  return out;
}

/** The request body: { required, content: { media: schema } }, or null. Swagger 2's body and form parameters too. */
function requestBody(spec, { op, item }) {
  if (op.requestBody) {
    const b = deref(spec, op.requestBody) ?? {};
    return { required: Boolean(b.required), content: Object.fromEntries(Object.entries(b.content ?? {}).map(([m, v]) => [m, v?.schema ?? null])) };
  }
  const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => deref(spec, p)).filter(Boolean);
  const consumes = op.consumes ?? spec.consumes ?? ['application/json'];
  const body = params.find((p) => p.in === 'body');
  if (body) return { required: Boolean(body.required), content: Object.fromEntries(consumes.map((m) => [m, body.schema ?? null])) };
  const form = params.filter((p) => p.in === 'formData');
  if (!form.length) return null;
  const schema = { type: 'object', properties: Object.fromEntries(form.map((p) => [p.name, inlineSchema(p)])), required: form.filter((p) => p.required).map((p) => p.name) };
  const media = consumes.filter((m) => /form/i.test(m));
  return { required: form.some((p) => p.required), content: Object.fromEntries((media.length ? media : ['application/x-www-form-urlencoded']).map((m) => [m, schema])) };
}

/** The responses: { status: { media: schema } }. */
function responses(spec, { op }) {
  const produces = op.produces ?? spec.produces ?? ['application/json'];
  const out = {};
  for (const [status, raw] of Object.entries(op.responses ?? {})) {
    const r = deref(spec, raw) ?? {};
    if (r.content && typeof r.content === 'object') out[status] = Object.fromEntries(Object.entries(r.content).map(([m, v]) => [m, v?.schema ?? null]));
    else out[status] = r.schema ? Object.fromEntries(produces.map((m) => [m, r.schema])) : {};
  }
  return out;
}

// The security an operation asks for: its own, else the document's. Each requirement as its schemes' names.
const security = (spec, op) => (op.security ?? spec.security ?? []).map((req) => Object.keys(req ?? {}).sort().join(' + '));

/** The path the API lives under: Swagger 2's basePath, or the first server's path. */
function basePath(spec) {
  if (spec.basePath != null) return String(spec.basePath).replace(/\/+$/, '');
  const url = String(spec.servers?.[0]?.url ?? '');
  const filled = Object.entries(spec.servers?.[0]?.variables ?? {}).reduce((u, [k, v]) => u.split(`{${k}}`).join(v?.default ?? ''), url);
  return filled.replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/\/+$/, '');
}

const isSuccess = (status) => /^2(\d\d|XX)$/i.test(status);
const shown = (v) => {
  const s = JSON.stringify(v);
  return s && s.length > 40 ? `${s.slice(0, 39)}…` : s;
};

// allOf's parts made one schema: their properties, required lists and the rest together.
function flatten(spec, schema, depth = 0) {
  if (!schema?.allOf || depth > 20) return schema;
  const out = { ...schema };
  delete out.allOf;
  for (const raw of schema.allOf) {
    const p = flatten(spec, deref(spec, raw), depth + 1);
    if (!p || typeof p !== 'object') continue;
    if (p.properties) out.properties = { ...(out.properties ?? {}), ...p.properties };
    if (p.required) out.required = [...new Set([...(out.required ?? []), ...p.required])];
    for (const [k, v] of Object.entries(p)) if (!['properties', 'required'].includes(k) && out[k] === undefined) out[k] = v;
  }
  return out;
}

/** The types a schema allows, 'null' among them when it's nullable; null when it says nothing (anything goes). */
function typeSet(s) {
  const t = s.type !== undefined ? [].concat(s.type) : s.properties ? ['object'] : s.items ? ['array'] : null;
  if (!t) return null;
  const set = new Set(t);
  if (s.nullable || s['x-nullable'] || (enumOf(s) ?? []).includes(null)) set.add('null');
  return set;
}
const accepts = (set, t) => set.has(t) || (t === 'integer' && set.has('number'));
const covers = (a, b) => [...b].every((t) => accepts(a, t));
const typeText = (set) => (set ? [...set].join(' or ') : 'anything');
const enumOf = (s) => (Array.isArray(s.enum) ? s.enum : s.const !== undefined ? [s.const] : null);

// Bounds: a bigger maximum or smaller minimum lets more through.
const MAXIMA = ['maxLength', 'maximum', 'maxItems', 'maxProperties'];
const MINIMA = ['minLength', 'minimum', 'minItems', 'minProperties'];

/**
 * Compares two schemas at `path` ($, $.items[].id) for direction `dir` ('request' or 'response'),
 * calling `emit(level, rule, path, text)` for each difference. `stack` holds the $refs being compared,
 * so a schema that contains itself is compared once.
 */
function compareSchemas(cx, oldRaw, newRaw, dir, path, stack, depth = 0) {
  const { emit } = cx;
  if (depth > 40) return;
  const refKey = oldRaw?.$ref || newRaw?.$ref ? `${oldRaw?.$ref ?? ''}|${newRaw?.$ref ?? ''}` : null;
  if (refKey && stack.has(refKey)) return;
  const o = flatten(cx.old, deref(cx.old, oldRaw));
  const n = flatten(cx.new, deref(cx.new, newRaw));
  if (!o || !n || typeof o !== 'object' || typeof n !== 'object') {
    if (o && !n && dir === 'response') emit('breaking', 'response-body-removed', path, 'no longer described');
    return;
  }
  if (refKey) stack.add(refKey);
  try {
    const req = dir === 'request';
    // The type.
    const ot = typeSet(o);
    const nt = typeSet(n);
    if (ot || nt) {
      const wider = !nt || (ot && covers(nt, ot));
      const narrower = !ot || (nt && covers(ot, nt));
      if (!(wider && narrower)) {
        const onlyNull = ot && nt && [...ot].filter((t) => t !== 'null').sort().join() === [...nt].filter((t) => t !== 'null').sort().join();
        if (wider) {
          const text = onlyNull ? 'may now be null' : `type widened: ${typeText(ot)} → ${typeText(nt)}`;
          if (req) emit('non-breaking', 'request-type-widened', path, text);
          else emit('breaking', onlyNull ? 'response-became-nullable' : 'response-type-widened', path, text);
        } else if (narrower) {
          const text = onlyNull ? 'can no longer be null' : `type narrowed: ${typeText(ot)} → ${typeText(nt)}`;
          if (req) emit('breaking', onlyNull ? 'request-no-longer-nullable' : 'request-type-narrowed', path, text);
          else emit('non-breaking', 'response-type-narrowed', path, text);
        } else {
          emit('breaking', `${dir}-type-changed`, path, `type changed: ${typeText(ot)} → ${typeText(nt)}`);
          return;
        }
      }
    }
    // The format, which says what the text or number holds.
    if (o.format !== n.format && (n.format ? req || o.format : !req && o.format)) {
      if (o.format && n.format) emit('may-break', `${dir}-format-changed`, path, `format ${o.format} → ${n.format}`);
      else if (n.format) emit('may-break', 'request-format-added', path, `format ${n.format} added`);
      else emit('may-break', 'response-format-removed', path, `format ${o.format} no longer promised`);
    }
    // The values it may be.
    const oe = enumOf(o);
    const ne = enumOf(n);
    if (oe && ne) {
      const has = (list, v) => list.some((x) => JSON.stringify(x) === JSON.stringify(v));
      const gone = oe.filter((v) => !has(ne, v));
      const added = ne.filter((v) => !has(oe, v));
      if (gone.length) {
        const text = `enum value${gone.length === 1 ? '' : 's'} ${gone.map(shown).join(', ')} removed`;
        if (req) emit('breaking', 'request-enum-value-removed', path, text);
        else emit('non-breaking', 'response-enum-value-removed', path, text);
      }
      if (added.length) {
        const text = `enum value${added.length === 1 ? '' : 's'} ${added.map(shown).join(', ')} added`;
        if (req) emit('non-breaking', 'request-enum-value-added', path, text);
        else emit('may-break', 'response-enum-value-added', path, `${text} (a client that expects only the old ones may not handle it)`);
      }
    } else if (ne && !oe) {
      const text = `now limited to ${ne.map(shown).join(', ')}`;
      if (req) emit('breaking', 'request-enum-added', path, text);
      else emit('non-breaking', 'response-enum-added', path, text);
    } else if (oe && !ne) {
      const text = `no longer limited to ${oe.map(shown).join(', ')}`;
      if (req) emit('non-breaking', 'request-enum-removed', path, text);
      else emit('may-break', 'response-enum-removed', path, text);
    }
    // Bounds and pattern.
    for (const k of [...MAXIMA, ...MINIMA]) {
      const a = typeof o[k] === 'number' ? o[k] : null;
      const b = typeof n[k] === 'number' ? n[k] : null;
      if (a === b) continue;
      const max = MAXIMA.includes(k);
      const narrowed = b != null && (a == null || (max ? b < a : b > a));
      const text = `${k} ${a ?? 'none'} → ${b ?? 'none'}`;
      if (narrowed) emit(req ? 'breaking' : 'non-breaking', `${dir}-${k}-narrowed`, path, text);
      else emit(req ? 'non-breaking' : 'may-break', `${dir}-${k}-widened`, path, text);
    }
    if (o.pattern !== n.pattern && n.pattern && req) emit('may-break', 'request-pattern-changed', path, o.pattern ? `pattern ${o.pattern} → ${n.pattern}` : `pattern ${n.pattern} added`);
    // Objects: the properties, which are required, and what else may be there.
    if (o.properties || n.properties) {
      const op = o.properties ?? {};
      const np = n.properties ?? {};
      const oreq = new Set(o.required ?? []);
      const nreq = new Set(n.required ?? []);
      // A read-only property is never sent, a write-only one never comes back.
      const skip = (s) => (req ? s?.readOnly : s?.writeOnly);
      const at = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`);
      for (const k of Object.keys(op)) {
        if (k in np || skip(deref(cx.old, op[k]))) continue;
        if (req) emit(n.additionalProperties === false ? 'breaking' : 'may-break', 'request-property-removed', at(k), n.additionalProperties === false ? 'removed, and no other properties are allowed' : 'removed (the server may reject or ignore it)');
        else emit('breaking', 'response-property-removed', at(k), 'removed');
      }
      for (const k of Object.keys(np)) {
        const ns = deref(cx.new, np[k]);
        if (skip(ns)) continue;
        if (!(k in op)) {
          if (req && nreq.has(k)) emit('breaking', 'request-property-required-added', at(k), 'new required property');
          else emit('non-breaking', `${dir}-property-added`, at(k), req ? 'new optional property' : 'new property');
          continue;
        }
        if (skip(deref(cx.old, op[k]))) continue;
        if (!oreq.has(k) && nreq.has(k)) {
          if (req) emit('breaking', 'request-property-became-required', at(k), 'now required');
          else emit('non-breaking', 'response-property-became-required', at(k), 'now always there');
        } else if (oreq.has(k) && !nreq.has(k)) {
          if (req) emit('non-breaking', 'request-property-became-optional', at(k), 'now optional');
          else emit('may-break', 'response-property-became-optional', at(k), 'no longer always there');
        }
        compareSchemas(cx, op[k], np[k], dir, at(k), stack, depth + 1);
      }
      if (req && o.additionalProperties !== false && n.additionalProperties === false) emit('may-break', 'request-additional-properties-closed', path, 'no properties but the described ones are allowed now');
    }
    if (o.additionalProperties && n.additionalProperties && typeof o.additionalProperties === 'object' && typeof n.additionalProperties === 'object') compareSchemas(cx, o.additionalProperties, n.additionalProperties, dir, `${path}{}`, stack, depth + 1);
    // Arrays: their items.
    if (o.items && n.items) compareSchemas(cx, o.items, n.items, dir, `${path}[]`, stack, depth + 1);
    // oneOf and anyOf: the variants, paired by the $ref each is, else by place.
    for (const kw of ['oneOf', 'anyOf']) {
      const ov = o[kw] ?? [];
      const nv = n[kw] ?? [];
      if (!ov.length && !nv.length) continue;
      const name = (v, i) => v?.$ref?.split('/').pop() ?? `#${i + 1}`;
      const byRef = ov.every((v) => v?.$ref) && nv.every((v) => v?.$ref);
      const left = new Map(ov.map((v, i) => [byRef ? name(v, i) : i, v]));
      const right = new Map(nv.map((v, i) => [byRef ? name(v, i) : i, v]));
      for (const [k, v] of left) {
        if (right.has(k)) compareSchemas(cx, v, right.get(k), dir, `${path}<${byRef ? k : `${kw} ${Number(k) + 1}`}>`, stack, depth + 1);
        else if (req) emit('breaking', 'request-variant-removed', path, `${kw} variant ${byRef ? k : Number(k) + 1} removed`);
        else emit('non-breaking', 'response-variant-removed', path, `${kw} variant ${byRef ? k : Number(k) + 1} removed`);
      }
      for (const k of right.keys()) {
        if (left.has(k)) continue;
        if (req) emit('non-breaking', 'request-variant-added', path, `${kw} variant ${byRef ? k : Number(k) + 1} added`);
        else emit('may-break', 'response-variant-added', path, `${kw} variant ${byRef ? k : Number(k) + 1} added (a client may not know it)`);
      }
    }
  } finally {
    if (refKey) stack.delete(refKey);
  }
}

/**
 * What changed from `oldSpec` to `newSpec`: { changes: [{ level, rule, operation, where, text }],
 * counts: { breaking, 'may-break', 'non-breaking' } }. `level` is one of LEVELS; `operation` is
 * "GET /users/{id}" (null for the document as a whole); `where` says what in it ("query parameter
 * limit", "request body $.name", "response 200 $.items[].id"), null for the operation itself.
 */
export function diffSpecs(oldSpec, newSpec) {
  const changes = [];
  const add = (level, rule, operation, where, text) => changes.push({ level, rule, operation, where: where || null, text });
  const ob = basePath(oldSpec);
  const nb = basePath(newSpec);
  if (ob !== nb) add('breaking', 'base-path-changed', null, null, `the API moved from ${ob || '/'} to ${nb || '/'}`);
  const olds = operations(oldSpec);
  const news = operations(newSpec);
  for (const [key, o] of olds) {
    const n = news.get(key);
    const name = `${o.method} ${(n ?? o).path}`;
    if (!n) {
      add('breaking', 'operation-removed', name, null, `removed${o.op.deprecated ? ' (it was deprecated)' : ''}`);
      continue;
    }
    const cx = { old: oldSpec, new: newSpec };
    const schemaDiff = (place, a, b, dir) =>
      compareSchemas({ ...cx, emit: (level, rule, path, text) => add(level, rule, name, path === '$' ? place : `${place} ${path}`, text) }, a, b, dir, '$', new Set());
    if (!o.op.deprecated && n.op.deprecated) add('non-breaking', 'operation-deprecated', name, null, 'deprecated');
    if (o.op.operationId && n.op.operationId && o.op.operationId !== n.op.operationId) add('may-break', 'operation-id-changed', name, null, `operationId ${o.op.operationId} → ${n.op.operationId} (generated clients name their methods by it)`);
    // Security.
    const os = security(oldSpec, o.op);
    const ns = security(newSpec, n.op);
    const open = (list) => !list.length || list.includes('');
    if (open(os) && !open(ns)) add('breaking', 'security-added', name, null, `now needs ${ns.join(' or ')}`);
    else if (!open(os) && open(ns)) add('non-breaking', 'security-removed', name, null, 'no longer needs authentication');
    else if (os.slice().sort().join('|') !== ns.slice().sort().join('|')) add('may-break', 'security-changed', name, null, `security ${os.join(' or ') || 'none'} → ${ns.join(' or ') || 'none'}`);
    // Parameters.
    const op = parameters(oldSpec, o);
    const np = parameters(newSpec, n);
    const pname = (p) => `${p.in} parameter ${p.name}`;
    for (const [k, p] of op) if (!np.has(k)) add('may-break', 'request-parameter-removed', name, pname(p), 'removed (the server may reject or ignore it)');
    for (const [k, p] of np) {
      const was = op.get(k);
      if (!was) {
        if (p.required) add('breaking', 'request-parameter-required-added', name, pname(p), 'new required parameter');
        else add('non-breaking', 'request-parameter-added', name, pname(p), 'new optional parameter');
        continue;
      }
      if (!was.required && p.required) add('breaking', 'request-parameter-became-required', name, pname(p), 'now required');
      else if (was.required && !p.required) add('non-breaking', 'request-parameter-became-optional', name, pname(p), 'now optional');
      if (!was.deprecated && p.deprecated) add('non-breaking', 'request-parameter-deprecated', name, pname(p), 'deprecated');
      schemaDiff(pname(p), was.schema, p.schema, 'request');
    }
    // The request body.
    const ok = requestBody(oldSpec, o);
    const nk = requestBody(newSpec, n);
    if (!ok && nk) {
      if (nk.required) add('breaking', 'request-body-required-added', name, 'request body', 'now required');
      else add('non-breaking', 'request-body-added', name, 'request body', 'new optional body');
    } else if (ok && !nk) add('may-break', 'request-body-removed', name, 'request body', 'removed (the server may reject or ignore one)');
    else if (ok && nk) {
      if (!ok.required && nk.required) add('breaking', 'request-body-became-required', name, 'request body', 'now required');
      else if (ok.required && !nk.required) add('non-breaking', 'request-body-became-optional', name, 'request body', 'now optional');
      for (const m of Object.keys(ok.content)) if (!(m in nk.content)) add('breaking', 'request-media-type-removed', name, 'request body', `${m} no longer accepted`);
      for (const m of Object.keys(nk.content)) {
        if (!(m in ok.content)) add('non-breaking', 'request-media-type-added', name, 'request body', `${m} accepted too`);
        else schemaDiff(`request body${Object.keys(nk.content).length > 1 ? ` (${m})` : ''}`, ok.content[m], nk.content[m], 'request');
      }
    }
    // Responses.
    const or = responses(oldSpec, o);
    const nr = responses(newSpec, n);
    for (const s of Object.keys(or)) {
      if (s in nr) continue;
      if (isSuccess(s)) add('breaking', 'response-status-removed', name, `response ${s}`, 'removed');
      else add('non-breaking', 'response-status-removed', name, `response ${s}`, 'removed');
    }
    for (const s of Object.keys(nr)) {
      if (!(s in or)) {
        if (isSuccess(s)) add('may-break', 'response-success-status-added', name, `response ${s}`, 'new success status (a client may expect only the old ones)');
        else add('non-breaking', 'response-status-added', name, `response ${s}`, 'new status');
        continue;
      }
      const om = or[s];
      const nm = nr[s];
      for (const m of Object.keys(om)) if (!(m in nm)) add('breaking', 'response-media-type-removed', name, `response ${s}`, `${m} no longer returned`);
      for (const m of Object.keys(nm)) {
        if (!(m in om)) add('non-breaking', 'response-media-type-added', name, `response ${s}`, `${m} returned too`);
        else schemaDiff(`response ${s}${Object.keys(nm).length > 1 ? ` (${m})` : ''}`, om[m], nm[m], 'response');
      }
    }
  }
  for (const [key, n] of news) if (!olds.has(key)) add('non-breaking', 'operation-added', `${n.method} ${n.path}`, null, n.op.deprecated ? 'added (deprecated)' : 'added');
  const order = (c) => LEVELS.indexOf(c.level);
  changes.sort((a, b) => order(a) - order(b) || String(a.operation ?? '').localeCompare(String(b.operation ?? '')));
  return { changes, counts: countChanges(changes) };
}

/** How many changes there are of each level. */
export const countChanges = (changes) => Object.fromEntries(LEVELS.map((l) => [l, changes.filter((c) => c.level === l).length]));

/** `--fail-on`'s value: 'breaking', 'may-break' or 'none'; null when it's none of them. */
export const parseDiffFailOn = (v) => (['breaking', 'may-break', 'none'].includes(String(v).toLowerCase()) ? String(v).toLowerCase() : null);

/** The changes that fail a run at `failOn`: breaking ones (breaking), those and the may-break ones (may-break), none (none). */
export const failingChanges = (changes, failOn = 'breaking') => (failOn === 'none' ? [] : changes.filter((c) => LEVELS.indexOf(c.level) <= LEVELS.indexOf(failOn)));

/** "2 breaking · 1 may break · 3 non-breaking", or "no changes". */
export function countsLine(counts) {
  const parts = [counts.breaking ? `${counts.breaking} breaking` : null, counts['may-break'] ? `${counts['may-break']} may break` : null, counts['non-breaking'] ? `${counts['non-breaking']} non-breaking` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'no changes';
}

const describe = (side) => `${side.source}${side.title || side.version ? ` (${[side.title, side.version].filter(Boolean).join(' ')}, ${side.kind})` : ` (${side.kind})`}`;

/**
 * The diff as lines of segments ({ text, tone, bold }, tones add, del, warn, dim) for the viewer and the
 * headless report: a line for each document, the counts, then each level's changes by operation.
 */
export function diffLines(result, { old, new: next }) {
  const out = [[{ text: describe(old), tone: 'dim' }], [{ text: `→ ${describe(next)}`, tone: 'dim' }], [{ text: countsLine(result.counts), bold: true, tone: result.counts.breaking ? 'del' : result.counts['may-break'] ? 'warn' : 'add' }]];
  if (!result.changes.length) out.push([], [{ text: 'The operations, parameters, bodies and responses are the same.', tone: 'dim' }]);
  for (const level of LEVELS) {
    const list = result.changes.filter((c) => c.level === level);
    if (!list.length) continue;
    out.push([], [{ text: `${LEVEL_NAMES[level]} (${list.length})`, bold: true, tone: TONES[level] }]);
    let last;
    for (const c of list) {
      if (c.operation !== last) out.push([{ text: `  ${c.operation ?? 'The document'}`, bold: true }]);
      last = c.operation;
      out.push([{ text: `    ${MARKS[level]} `, tone: TONES[level] }, ...(c.where ? [{ text: `${c.where}: ` }] : []), { text: c.text }, { text: `  ${c.rule}`, tone: 'dim' }]);
    }
  }
  return out;
}

/** The diff as plain text. */
export const diffText = (result, meta) => diffLines(result, meta).map((segs) => segs.map((s) => s.text).join('')).join('\n');

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (s) => (s ? `\`${String(s).replace(/`/g, "'")}\`` : '');

/** The diff as Markdown for a pull request: the counts, then a table per level. */
export function diffMarkdown(result, { old, new: next }) {
  const lines = [`## API changes: ${code(old.source)} → ${code(next.source)}`, '', `${result.counts.breaking ? '**' : ''}${countsLine(result.counts)}${result.counts.breaking ? '**' : ''}${next.title ? ` · ${cell(next.title)}${old.version && next.version && old.version !== next.version ? ` ${cell(old.version)} → ${cell(next.version)}` : ''}` : ''}`];
  if (!result.changes.length) lines.push('', 'The operations, parameters, bodies and responses are the same.');
  for (const level of LEVELS) {
    const list = result.changes.filter((c) => c.level === level);
    if (!list.length) continue;
    lines.push('', `### ${LEVEL_NAMES[level]} (${list.length})`, '', '| Operation | Where | Change | Rule |', '| --- | --- | --- | --- |');
    for (const c of list) lines.push(`| ${c.operation ? code(c.operation) : 'The document'} | ${cell(c.where ?? '')} | ${cell(c.text)} | ${code(c.rule)} |`);
  }
  return `${lines.join('\n')}\n`;
}

/** The diff as JSON for a program: { app, check, old, new, counts, changes, failing? }. */
export const diffJson = (result, { old, new: next }, failOn = 'breaking') => ({
  app: 'hail',
  check: 'openapi-diff',
  old,
  new: next,
  failOn,
  counts: result.counts,
  failing: failingChanges(result.changes, failOn).length,
  changes: result.changes,
});

/** `git:<ref>:<path>` read apart: { ref, path } (path '' when it's left out), or null for any other source. */
export function gitSource(source) {
  const m = /^git:([^:]+)(?::(.*))?$/.exec(String(source));
  return m ? { ref: m[1], path: m[2] ?? '' } : null;
}

// An argument for the shell run.js starts: quoted for sh, or for cmd.exe on Windows.
const shellArg = (s) => (process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * Reads a description: a file (relative to `cwd`), an http(s) URL, or `git:<ref>:<path>` (the file as
 * it is in that commit, through `git show`; `path` relative to `cwd`). Resolves with { spec, source,
 * ...specInfo }; throws a reason it can't.
 */
export async function loadSpec(source, { cwd = process.cwd(), fetch = globalThis.fetch, signal, run = runCommand } = {}) {
  const git = gitSource(source);
  if (!git) {
    const { spec } = await loadContract(source, { dir: cwd, fetch, signal });
    return { spec, source, ...specInfo(spec) };
  }
  if (!git.path) throw new Error(`${source} names no file: git:<ref>:<path>, like git:main:openapi.yaml`);
  if (!/^[\w./~^@{}+-]+$/.test(git.ref)) throw new Error(`${git.ref} doesn't look like a git ref`);
  if (/["\0\n]/.test(git.path)) throw new Error(`${git.path} can't be read from git`);
  const abs = isAbsolute(git.path) ? git.path : resolve(cwd, git.path);
  // Relative to the folder git runs in, which `./` tells git show to read it from.
  const dir = dirname(abs);
  const rel = `./${basename(abs)}`;
  let text;
  try {
    ({ stdout: text } = await run(`git show ${shellArg(`${git.ref}:${rel}`)}`, { cwd: dir, signal }));
  } catch (e) {
    if (e.cancelled) throw e;
    const why = String(e.message ?? '').split('\n')[0];
    throw new Error(`Couldn't read ${relative(cwd, abs) || basename(abs)} at ${git.ref}: ${why || "git couldn't"}`);
  }
  const spec = parseContract(text);
  return { spec, source, ...specInfo(spec) };
}

/**
 * The two sources an `openapi-diff` names, `git:<ref>` with no path taking the other one's: { old,
 * new } or { problem }. Without `newSource`, `fallback` (the open file's contract) is the new one,
 * else the file a `git:<ref>:<path>` names, as it is now.
 */
export function diffSources(oldSource, newSource, fallback = null) {
  // git:<ref>:<path> alone is that file then and now.
  const next = newSource ?? fallback ?? (gitSource(oldSource ?? '')?.path || null);
  if (!oldSource || !next) return { problem: 'Name two descriptions: openapi-diff <old> <new> (a file, a URL, or git:<ref>:<path>)' };
  const g = gitSource(oldSource);
  if (g && !g.path) {
    const other = gitSource(next)?.path ?? (/^https?:\/\//i.test(next) ? null : next);
    if (!other) return { problem: `${oldSource} names no file, and ${next} isn't one to read from git` };
    return { old: `git:${g.ref}:${other}`, new: next };
  }
  return { old: oldSource, new: next };
}
