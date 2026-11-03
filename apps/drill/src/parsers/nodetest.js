// node --test's reporters, as Node 22 writes them: TAP (version 13, a level of subtests every four
// spaces, a YAML block after each result with its duration, location, error, expected, actual and
// stack), which Drill asks for in a file; and spec (✔ ✖ ﹣ under ▶ suites, the failures again at the
// end), for output a project's own script printed. Pure.
import { makeFailure, makeTest, relPath, stripAnsi } from '../model.js';

const unescapeName = (s) => String(s ?? '').replace(/\\#/g, '#').replace(/\\\\/g, '\\');

/** A YAML scalar as the TAP reporter writes one: 'single quoted', "double quoted", a number, or bare. */
function scalar(v) {
  const s = v.trim();
  if (/^'.*'$/s.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/s.test(s)) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  if (s === 'null' || s === '~') return null;
  return s;
}

/**
 * A result's YAML block (the lines between --- and ..., their common indent taken off) as an object:
 * `key: scalar`, `key: |-` or `key: >-` with the more indented lines under it as text, `key:` with a
 * nested map under it kept as its text (an object's expected and actual).
 */
export function parseDiagnostics(lines) {
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  const rows = lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
  const out = {};
  for (let i = 0; i < rows.length; i++) {
    const m = /^([\w-]+):(?:\s+(.*))?$/.exec(rows[i]);
    if (!m) continue;
    const [, key, value = ''] = m;
    if (value && !/^[|>][-+]?$/.test(value.trim())) {
      out[key] = scalar(value);
      continue;
    }
    const block = [];
    while (i + 1 < rows.length && (rows[i + 1] === '' || /^\s/.test(rows[i + 1]))) block.push(rows[++i]);
    const bi = Math.min(...block.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    const text = block.map((l) => l.slice(Number.isFinite(bi) ? bi : 0)).join('\n').replace(/\s+$/, '');
    out[key] = value.trim().startsWith('>') ? text.replace(/\n(?!\n)/g, ' ') : text;
  }
  return out;
}

/** A location ('/abs/file.test.js:8:3' or a file URL) as { file, line }. */
function locationOf(loc) {
  const m = /^(.*):(\d+):(\d+)$/.exec(String(loc ?? ''));
  return m ? { file: m[1], line: Number(m[2]) } : null;
}

/**
 * The tests in node --test's TAP. Suites (a result with subtests, or `type: 'suite'`) give their
 * names to the tests under them; each test's file is its location's, else its suite's, else the
 * top-level name when that is a path (a file that failed to load). Node 22 gives a location only to a
 * failure and a suite, and reports each file's tests together at the top level, so a top-level test
 * that passed takes the file of the one before it (or after it).
 */
export function parseTap(text, { root, version } = {}) {
  const lines = stripAnsi(text).replace(/\r\n/g, '\n').split('\n');
  // Finished results per depth, waiting for their parent's result line.
  const pending = [[]];
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^(\s*)(not ok|ok) \d+(?: - (.*?))?(?:\s+# (SKIP|TODO)\b.*)?$/i.exec(line);
    if (!m) {
      if (/^Bail out!/.test(line.trim())) errors.push(line.trim());
      continue;
    }
    const depth = Math.floor(m[1].length / 4);
    let diag = {};
    if (/^\s*---\s*$/.test(lines[i + 1] ?? '')) {
      const block = [];
      let j = i + 2;
      for (; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) block.push(lines[j]);
      diag = parseDiagnostics(block);
      i = j;
    }
    while (pending.length < depth + 2) pending.push([]);
    const children = pending[depth + 1];
    pending[depth + 1] = [];
    const node = { name: unescapeName(m[3] ?? ''), ok: m[2].toLowerCase() === 'ok', directive: m[4]?.toUpperCase() ?? null, diag, children };
    pending[depth].push(node);
  }
  const found = [];
  let top = 0;
  const walk = (node, suite, file) => {
    const loc = locationOf(node.diag.location);
    const here = loc?.file ?? file;
    // Node 20 wrapped each file's tests in a subtest named with the file's path: a file, not a suite.
    if (!suite.length && node.children.length && /^(?:\/|[A-Za-z]:[\\/]|file:)/.test(node.name)) {
      for (const c of node.children) walk(c, [], node.name);
      return;
    }
    if (node.children.length || node.diag.type === 'suite') {
      for (const c of node.children) walk(c, [...suite, node.name], here);
      // A suite that failed with nothing under it failing (a hook that threw) is a failure of its own.
      if (!node.ok && !node.children.some((c) => !c.ok) && node.diag.failureType !== 'subtestsFailed') walk({ ...node, children: [], diag: { ...node.diag, type: 'test' } }, suite, here);
      return;
    }
    const status = node.directive ? 'skipped' : node.ok ? 'passed' : 'failed';
    const fileOf = here ?? (/[\\/]/.test(node.name) ? node.name : null);
    const d = node.diag;
    const values = 'expected' in d || 'actual' in d ? { expected: d.expected, actual: d.actual } : {};
    found.push({
      top,
      fileOf,
      test: {
        runner: 'node',
        suite: suite.map(String),
        name: node.name,
        status,
        duration: typeof d.duration_ms === 'number' ? d.duration_ms : 0,
        ...(loc ? { line: loc.line } : {}),
        ...(status === 'failed' ? { failure: makeFailure({ message: [d.name && d.name !== 'Error' && !String(d.error ?? '').startsWith(d.name) ? `${d.name}: ` : '', String(d.error ?? 'Failed')].join(''), stack: String(d.stack ?? ''), root, ...values }) } : {}),
      },
    });
  };
  for (const n of pending[0]) {
    walk(n, [], null);
    top++;
  }
  // Each top-level result's file, from any of its tests; one with none takes its neighbour's.
  const fileOfTop = Array.from({ length: top }, (_, i) => found.find((f) => f.top === i && f.fileOf)?.fileOf ?? null);
  const near = (i) => {
    for (let j = i - 1; j >= 0; j--) if (fileOfTop[j]) return fileOfTop[j];
    for (let j = i + 1; j < top; j++) if (fileOfTop[j]) return fileOfTop[j];
    return '';
  };
  const tests = found.map((f) => makeTest({ ...f.test, file: relPath(root, f.fileOf ?? fileOfTop[f.top] ?? near(f.top)) }));
  return { runner: 'node', version, tests, errors };
}

/**
 * The tests in node --test's spec output: ▶ opens a suite (its indent the level), ✔ passed, ✖ failed,
 * ﹣ skipped (or # SKIP / # TODO after the name), each with its duration. The "failing tests:" part
 * at the end gives each failure's location and error, matched back by name.
 */
export function parseSpec(text, { root, version } = {}) {
  const lines = stripAnsi(text).replace(/\r\n/g, '\n').split('\n');
  const tests = [];
  const stack = [];
  const end = lines.findIndex((l) => /^✖ failing tests:/.test(l.trim()));
  const body = end >= 0 ? lines.slice(0, end) : lines;
  for (const line of body) {
    const m = /^(\s*)([▶✔✖﹣])\s+(.*?)(?:\s+\(([\d.]+)ms\)(?:\s+#\s*(SKIP|TODO)?\b.*)?)?$/.exec(line);
    if (!m) continue;
    const level = Math.floor(m[1].length / 2);
    while (stack.length > level) stack.pop();
    if (m[2] === '▶') {
      // The suite's closing line (with its duration) at the same level, or its opening one.
      if (!m[4]) stack.push(m[3]);
      continue;
    }
    const status = m[5] || m[2] === '﹣' ? 'skipped' : m[2] === '✔' ? 'passed' : 'failed';
    tests.push({ runner: 'node', file: '', suite: [...stack], name: m[3], status, duration: m[4] ? Number(m[4]) : 0 });
  }
  // The failures again, each "test at <location>", "✖ <name> (…ms)" and its error, indented.
  if (end >= 0) {
    const rest = lines.slice(end + 1);
    for (let i = 0; i < rest.length; i++) {
      const at = /^test at (.+):(\d+):\d+$/.exec(rest[i].trim());
      if (!at) continue;
      const name = /^\s*✖\s+(.*?)(?:\s+\([\d.]+ms\))?$/.exec(rest[i + 1] ?? '')?.[1];
      const errorLines = [];
      let j = i + 2;
      for (; j < rest.length && !/^test at /.test(rest[j].trim()); j++) errorLines.push(rest[j].replace(/^ {2}/, ''));
      i = j - 1;
      const t = tests.find((x) => x.status === 'failed' && x.name === name && !x.failure);
      if (!t) continue;
      const text = errorLines.join('\n').trim();
      // Node prints the error's own properties after it as a { … } block: expected and actual are there.
      const props = /\s\{\n([\s\S]*)\n\}\s*$/.exec(text);
      const exp = props && /^\s*expected: (.*?),?$/m.exec(props[1]);
      const act = props && /^\s*actual: (.*?),?$/m.exec(props[1]);
      Object.assign(t, {
        file: relPath(root, at[1]),
        line: Number(at[2]),
        failure: makeFailure({ message: props ? text.slice(0, props.index) : text, root, ...(exp && act ? { expected: scalar(exp[1]), actual: scalar(act[1]) } : {}) }),
      });
    }
  }
  return { runner: 'node', version, tests: tests.map(makeTest), errors: [] };
}
