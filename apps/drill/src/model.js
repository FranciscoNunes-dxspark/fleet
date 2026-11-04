// What every runner's result becomes, whichever reporter wrote it: a list of tests, each
// { id, runner, file, suite, name, status, duration, line?, fqn?, failure?, attachments?, flaky? },
// and the pieces a failure is made of (its message, expected and actual, a diff, the stack trimmed to
// the project's own frames). Pure.
import { isAbsolute, relative, resolve } from 'node:path';

export const STATUSES = ['failed', 'passed', 'skipped'];

/** Text without its colour and cursor codes (Playwright's and Jest's messages carry them). */
export const stripAnsi = (s) =>
  String(s ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');

const slashes = (p) => String(p).replace(/\\/g, '/');

/** A file URL (file:///home/x, file:///C:/x) as a path, else the text as it is. */
export function fromFileUrl(s) {
  const m = /^file:\/\/(?:localhost)?(\/[^?#]*)/i.exec(String(s));
  if (!m) return String(s);
  const path = decodeURIComponent(m[1]);
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

/**
 * `file` as the project knows it: relative to `root` and `/`-separated when it's inside it, else as it
 * was (with `/`). Windows' drive letters compare without case.
 */
export function relPath(root, file) {
  if (!file) return '';
  const f = fromFileUrl(file);
  if (!root || !(isAbsolute(f) || /^[A-Za-z]:[\\/]/.test(f))) return slashes(f).replace(/^\.\//, '');
  const r = relative(resolve(root), resolve(f));
  if (!r || r.startsWith('..') || isAbsolute(r)) return slashes(f);
  return slashes(r);
}

/** A test's id, the same from one run to the next: the runner, the file and the titles down to it. */
export const testId = ({ runner, file, suite = [], name }) => `${runner}:${file}:${[...suite, name].join(' › ')}`;

/** A test in the shape every view reads, with its id. */
export function makeTest(t) {
  const test = { suite: [], duration: 0, ...t, status: STATUSES.includes(t.status) ? t.status : 'skipped' };
  test.id = testId(test);
  return test;
}

/** { total, passed, failed, skipped, flaky } of `tests`. */
export function countTests(tests = []) {
  const c = { total: tests.length, passed: 0, failed: 0, skipped: 0, flaky: 0 };
  for (const t of tests) {
    c[t.status]++;
    if (t.flaky) c.flaky++;
  }
  return c;
}

/** "3 failed · 120 passed · 4 skipped", the parts there are. */
export function countLine(c) {
  const parts = [];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.passed) parts.push(`${c.passed} passed`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  if (c.flaky) parts.push(`${c.flaky} flaky`);
  return parts.join(' · ') || 'no tests';
}

/** A duration for a row: 12ms, 1.4s, 2m 03s. */
export function duration(ms) {
  if (ms == null || Number.isNaN(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// ---- stack frames -------------------------------------------------------------------------------

/**
 * The frames in a stack's text, as test runners write them: V8's ("at fn (file:line:col)", "at
 * file:line:col"), node:test's TAP (the same without "at"), file URLs, and .NET's ("at X in file:line N").
 * [{ file, line, column?, method? }], in order.
 */
export function parseFrames(text) {
  const out = [];
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = /^at (.+?) in (.+?):line (\d+)\s*$/.exec(line))) out.push({ method: m[1], file: m[2], line: Number(m[3]) });
    else if ((m = /^(?:at )?(?:(.+?) \()?((?:file:\/\/|[A-Za-z]:[\\/]|\/|\.{0,2}[\w@.-]*[\\/])[^()]*?):(\d+):(\d+)\)?$/.exec(line)))
      out.push({ ...(m[1] ? { method: m[1].replace(/^async /, '') } : {}), file: fromFileUrl(m[2]), line: Number(m[3]), column: Number(m[4]) });
  }
  return out;
}

// What is the runner's, Node's or a library's rather than the project's.
const NOT_OWN = /(^|[\\/])node_modules[\\/]|^node:|^internal[\\/]|[\\/]\.pnpm[\\/]|<anonymous>|^native$/;

/**
 * The frames that are the project's: inside `root`, outside node_modules and Node's own, relative to
 * `root` and `/`-separated, each marked `own`. When none is, the first few as they are, so there is
 * always somewhere to start.
 */
export function ownFrames(frames, root) {
  const own = [];
  for (const f of frames) {
    if (NOT_OWN.test(f.file)) continue;
    const rel = relPath(root, f.file);
    const inside = !(isAbsolute(rel) || /^[A-Za-z]:\//.test(rel));
    if (!inside && root) continue;
    if (own.some((o) => o.file === rel && o.line === f.line)) continue;
    own.push({ ...f, file: rel, own: true });
  }
  if (own.length) return own;
  return frames.filter((f) => !/^node:|^internal[\\/]/.test(f.file)).slice(0, 3).map((f) => ({ ...f, file: slashes(f.file), own: false }));
}

// ---- expected and actual ------------------------------------------------------------------------

/**
 * Expected and actual from an assertion's message, in the words each runner and library uses: Jest's
 * and Playwright's "Expected: … Received: …", Chai's and Vitest's "expected X to be Y", xUnit's
 * "Expected: … Actual: …", NUnit's "Expected: … But was: …", MSTest's "Expected:<…>. Actual:<…>.".
 * { expected, actual } or null.
 */
export function expectedActual(message) {
  const text = stripAnsi(message);
  let m;
  if ((m = /Expected:<([\s\S]*?)>\.?\s*Actual:<([\s\S]*?)>/.exec(text))) return { expected: m[1], actual: m[2] };
  const exp = /^\s*Expected(?: [a-z ]+)?:\s?(.*)$/m.exec(text);
  const act = /^\s*(?:Received(?: [a-z ]+)?|Actual|But was):\s*(.*)$/m.exec(text);
  if (exp && act) return { expected: exp[1].trim(), actual: act[1].trim() };
  if ((m = /expected (.+?) to (?:be|equal|deeply equal|strictly equal|be strictly equal|have length|include|contain|match) (.+?)(?:\s+\/\/ .*)?$/m.exec(text))) return { expected: m[2].trim(), actual: m[1].trim() };
  if ((m = /^\s*(\S.*?) !== (\S.*)$/m.exec(text))) return { expected: m[2].trim(), actual: m[1].trim() };
  return null;
}

/** A diff Jest or Vitest already wrote into the message ("- Expected" / "+ Received" and the lines under it), or null. */
export function diffInMessage(message) {
  const lines = stripAnsi(message).split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*- Expected/.test(l));
  if (start < 0 || !/^\s*\+ (Received|Actual)/.test(lines[start + 1] ?? '')) return null;
  const out = [];
  for (const l of lines.slice(start + 2)) {
    if (/^\s+at \S/.test(l)) break;
    if (!l.trim()) {
      if (out.length) out.push({ kind: ' ', text: '' });
      continue;
    }
    // Each line starts with its mark and a space: "- ", "+ " or "  ".
    if (!/^[-+ ] ?/.test(l)) break;
    out.push({ kind: l[0] === '-' || l[0] === '+' ? l[0] : ' ', text: l.slice(2) });
  }
  while (out.length && !out.at(-1).text) out.pop();
  return out.length ? out : null;
}

/**
 * The lines of `expected` and `actual` compared: [{ kind: ' ' | '-' | '+', text }], '-' what was
 * expected and isn't there, '+' what came instead (a longest-common-subsequence diff of the lines).
 */
export function diffLines(expected, actual) {
  const a = String(expected ?? '').split('\n');
  const b = String(actual ?? '').split('\n');
  // Long texts are compared as they are, two blocks, rather than in quadratic time.
  if (a.length * b.length > 250_000) return [...a.map((text) => ({ kind: '-', text })), ...b.map((text) => ({ kind: '+', text }))];
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: '-', text: a[i++] });
    else out.push({ kind: '+', text: b[j++] });
  }
  while (i < n) out.push({ kind: '-', text: a[i++] });
  while (j < m) out.push({ kind: '+', text: b[j++] });
  return out;
}

/** A value as a diff compares it: strings as they are, everything else as indented JSON. */
export const shown = (v) => (typeof v === 'string' ? v : v === undefined ? 'undefined' : JSON.stringify(v, null, 2) ?? String(v));

/**
 * A failure from what the runner said: `message` (the error's text, which may carry its stack after
 * it), `stack` (when given apart), `expected`/`actual` (when the reporter gives them as values).
 * { message, expected?, actual?, diff, stack, frames } with the message cut before the stack and the
 * frames trimmed to the project's own.
 */
export function makeFailure({ message = '', stack = '', expected, actual, root }) {
  const text = stripAnsi(message).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  // The message is what comes before the first frame line (V8's "    at …").
  const firstFrame = lines.findIndex((l) => /^\s+at \S/.test(l));
  const msg = (firstFrame >= 0 ? lines.slice(0, firstFrame) : lines).join('\n').trim();
  const fullStack = [firstFrame >= 0 ? lines.slice(firstFrame).join('\n') : '', stripAnsi(stack)].filter(Boolean).join('\n');
  const said = expected !== undefined || actual !== undefined ? { expected: shown(expected), actual: shown(actual) } : expectedActual(msg);
  const diff = diffInMessage(msg) ?? (said ? diffLines(said.expected, said.actual) : []);
  return {
    message: msg || 'Failed',
    ...(said ? said : {}),
    diff,
    stack: fullStack,
    frames: ownFrames(parseFrames(fullStack), root),
  };
}
