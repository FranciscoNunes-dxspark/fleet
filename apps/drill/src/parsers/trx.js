// dotnet test's TRX logger (--logger "trx;LogFileName=…"), the Visual Studio test results schema of
// 2010 that xUnit, NUnit and MSTest all write through the test platform: `TestDefinitions` (each
// `UnitTest`'s `TestMethod`: className, name) and `Results` (each `UnitTestResult`: outcome, duration,
// `Output/ErrorInfo/Message` and `StackTrace`). Read with a small XML reader of its own (elements,
// attributes, text and CDATA), as no XML library comes with Node. Pure.
import { makeFailure, makeTest, relPath } from '../model.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m));

/** An XML document as a tree of { name, attrs, children, text }: enough of XML for a TRX file (no DTDs). */
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(String(text).replace(/^﻿/, '')))) {
    const top = stack.at(-1);
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      // A closing tag: back up to its element (a stray one is ignored).
      const i = stack.findLastIndex((e) => e.name === m[2]);
      if (i > 0) stack.length = i;
    } else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1].replace(/^.*:/, '')] = decode(a[2] ?? a[3]);
      const el = { name: m[3].replace(/^.*:/, ''), attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  return root;
}

const find = (el, name) => el?.children.find((c) => c.name === name) ?? null;
const findAll = (el, name, out = []) => {
  for (const c of el?.children ?? []) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
};

/** TRX's duration ("00:00:01.2345678") in milliseconds. */
export function trxDuration(s) {
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(s ?? ''));
  return m ? Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) : 0;
}

const OUTCOME = { passed: 'passed', failed: 'failed', error: 'failed', timeout: 'failed', aborted: 'failed', notexecuted: 'skipped', inconclusive: 'skipped', pending: 'skipped', disconnected: 'failed' };

/**
 * The tests of a TRX file. Each test's "file" is its class (Namespace.Class), as TRX says nothing of
 * source files; the failure's frames say where it is, and its first own frame gives the test's line.
 * `fqn` (Namespace.Class.Method) is what `dotnet test --filter` takes to run it again. A parameterised
 * test's cases (Method(a: 1), Method(a: 2)) are tests of their own.
 */
export function parseTrx(text, { root, version } = {}) {
  const doc = parseXml(text);
  const run = find(doc, 'TestRun');
  if (!run) throw new Error("That isn't a TRX file (no <TestRun>).");
  const methods = new Map();
  for (const ut of findAll(find(run, 'TestDefinitions'), 'UnitTest')) {
    const tm = find(ut, 'TestMethod');
    methods.set(ut.attrs.id, { className: tm?.attrs.className ?? '', method: tm?.attrs.name ?? ut.attrs.name ?? '', storage: ut.attrs.storage ?? tm?.attrs.codeBase ?? '' });
  }
  const tests = [];
  for (const r of findAll(find(run, 'Results'), 'UnitTestResult')) {
    const def = methods.get(r.attrs.testId) ?? { className: '', method: r.attrs.testName ?? '' };
    // xUnit's names are the whole Namespace.Class.Method(args); NUnit's and MSTest's the method's.
    const className = def.className.replace(/,.*$/, '');
    const testName = r.attrs.testName ?? def.method;
    const name = className && testName.startsWith(`${className}.`) ? testName.slice(className.length + 1) : testName;
    const status = OUTCOME[String(r.attrs.outcome ?? '').toLowerCase()] ?? 'skipped';
    const info = find(find(r, 'Output'), 'ErrorInfo');
    const message = (find(info, 'Message')?.text ?? '').trim();
    const stack = (find(info, 'StackTrace')?.text ?? '').trim();
    const failure = status === 'failed' ? makeFailure({ message: message || (r.attrs.outcome === 'Timeout' ? 'Timed out' : 'Failed'), stack, root }) : null;
    const own = failure?.frames.find((f) => f.own);
    tests.push(
      makeTest({
        runner: 'dotnet',
        file: className || relPath(root, def.storage),
        suite: [],
        name,
        status,
        duration: trxDuration(r.attrs.duration),
        fqn: `${className ? `${className}.` : ''}${def.method.replace(/\(.*$/, '')}`,
        ...(own ? { line: own.line, source: own.file } : {}),
        ...(failure ? { failure } : {}),
      }),
    );
  }
  const counters = find(find(run, 'ResultSummary'), 'Counters');
  const errors = [];
  const runInfo = findAll(find(run, 'ResultSummary'), 'RunInfo').filter((ri) => ri.attrs.outcome === 'Error');
  for (const ri of runInfo) errors.push((find(ri, 'Text')?.text ?? '').trim().split('\n')[0]);
  if (!tests.length && counters && Number(counters.attrs.total) === 0 && find(run, 'ResultSummary')?.attrs.outcome === 'Failed') errors.push('The test run failed before any test ran.');
  return { runner: 'dotnet', version, tests, errors };
}
