// /compare: one request sent in two environments, and how the answers differ: the status, the time,
// the headers that say something and the body (JSON by path, anything else line by line). Pure:
// actions.js sends it twice and draws what this works out.
import { indexPath, keyPath, kindOf, scalarText, showPath } from '@fleet/kit/datatree.js';
import { changedOnly, lineDiff } from './diff.js';
import { VOLATILE, headerList } from './replay.js';
import { prettyBody } from './send.js';

// Besides replay.js's: headers a CDN, a proxy or a cloud adds that differ on every response.
const ALSO_VOLATILE = /^(cf-ray|cf-cache-status|x-cache|x-cache-hits|x-served-by|x-timer|x-runtime|x-response-time|x-envoy-upstream-service-time|x-amz-cf-id|x-amz-cf-pop|x-amz-request-id|x-amz-id-2|x-github-request-id|apim-request-id|x-ms-correlation-request-id|x-ms-routing-request-id|x-ms-client-request-id|x-vercel-id|fly-request-id|x-cloud-trace-context|x-b3-traceid|x-b3-spanid|request-id|x-activity-id)$/i;

/** Whether a header differs on every response whatever the server does, so comparing it says nothing. */
export const volatileHeader = (name) => (VOLATILE.test(name) && !/^set-cookie$/i.test(name)) || ALSO_VOLATILE.test(name);

/** The cookies' names in a Set-Cookie value (one, or several run together with commas; an Expires date has commas too). */
const cookieNames = (value) => String(value).split(/,(?=\s*[\w!#$%&'*+.^`|~-]+=)/).map((c) => c.split('=')[0].trim()).filter(Boolean);

/** A response's headers to compare, by lower-case name: Set-Cookie as the cookies' names alone, their values always differing. */
export function comparableHeaders(headers) {
  const out = new Map();
  for (const [k, v] of headerList(headers)) {
    const name = k.toLowerCase();
    if (volatileHeader(name)) continue;
    const value = name === 'set-cookie' ? cookieNames(v).join(', ') : String(v);
    out.set(name, out.has(name) ? `${out.get(name)}, ${value}` : value);
  }
  if (out.has('set-cookie')) out.set('set-cookie', out.get('set-cookie').split(', ').sort().join(', '));
  return out;
}

/** The headers that differ: [{ name, before, after }], `before` or `after` undefined when only one has it. */
export function headerChanges(a, b) {
  const x = comparableHeaders(a);
  const y = comparableHeaders(b);
  const names = [...new Set([...x.keys(), ...y.keys()])].sort();
  return names.filter((n) => x.get(n) !== y.get(n)).map((name) => ({ name, before: x.get(name), after: y.get(name) }));
}

/**
 * How two JSON values differ, by path (datatree.js's `.items[0].name`): [{ path, kind, before?, after? }],
 * kind being 'added', 'removed' or 'changed'. Arrays are compared index by index. At most `max`.
 */
export function jsonChanges(a, b, { max = 1000 } = {}) {
  const out = [];
  const walk = (x, y, path) => {
    if (out.length >= max) return;
    const kx = kindOf(x);
    const ky = kindOf(y);
    if (kx === 'object' && ky === 'object') {
      for (const k of Object.keys(x)) {
        if (!Object.hasOwn(y, k)) out.push({ path: keyPath(path, k), kind: 'removed', before: x[k] });
        else walk(x[k], y[k], keyPath(path, k));
      }
      for (const k of Object.keys(y)) if (!Object.hasOwn(x, k)) out.push({ path: keyPath(path, k), kind: 'added', after: y[k] });
      return;
    }
    if (kx === 'array' && ky === 'array') {
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (i >= y.length) out.push({ path: indexPath(path, i), kind: 'removed', before: x[i] });
        else if (i >= x.length) out.push({ path: indexPath(path, i), kind: 'added', after: y[i] });
        else walk(x[i], y[i], indexPath(path, i));
      }
      return;
    }
    if (kx !== ky || JSON.stringify(x) !== JSON.stringify(y)) out.push({ path, kind: 'changed', before: x, after: y });
  };
  walk(a, b, '');
  return out.slice(0, max);
}

/** A body as JSON when it is (JSON or not by its Content-Type), else undefined. */
function jsonOf(r) {
  const text = String(r?.body ?? '');
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Two answers to the same request compared: `before` (the environment Hail is in) and `after` (the
 * other). { same, status: { before, after, same }, ms: { before, after }, headers: headerChanges,
 * body: { kind: 'json', changes } | { kind: 'text', diff } | { kind: 'same' } }.
 */
export function compareAnswers(before, after) {
  const status = { before: before.status, after: after.status, same: before.status === after.status };
  const headers = headerChanges(before.headers, after.headers);
  const [x, y] = [jsonOf(before), jsonOf(after)];
  let body;
  if (x !== undefined && y !== undefined) {
    const changes = jsonChanges(x, y);
    body = changes.length ? { kind: 'json', changes } : { kind: 'same' };
  } else {
    const [p, q] = [prettyBody({ headers: headerList(before.headers), body: String(before.body ?? '') }), prettyBody({ headers: headerList(after.headers), body: String(after.body ?? '') })];
    body = p === q ? { kind: 'same' } : { kind: 'text', diff: changedOnly(lineDiff(p, q)) };
  }
  return { same: status.same && !headers.length && body.kind === 'same', status, ms: { before: before.ms, after: after.ms }, headers, body };
}

/** A value for a line of the comparison: JSON, cut at `max` characters. */
export const shortValue = (v, max = 120) => {
  const s = scalarText(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** A JSON change as a line: `~ .items[0].price  9.5 → 10`, `+ .id  42`, `- .old  "x"`. */
export function changeLine(c) {
  const path = showPath(c.path);
  if (c.kind === 'added') return `+ ${path}  ${shortValue(c.after)}`;
  if (c.kind === 'removed') return `- ${path}  ${shortValue(c.before)}`;
  return `~ ${path}  ${shortValue(c.before)} → ${shortValue(c.after)}`;
}
