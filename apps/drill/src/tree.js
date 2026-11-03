// The Tree view's rows from a run's tests: a file, the suites in it, the tests in them, each file and
// suite with its counts and time. `failuresOnly` keeps only what has a failure under it; a collapsed
// file or suite hides what's under it. Pure.
import { countTests } from './model.js';

/**
 * [{ kind: 'file'|'suite'|'test', key, depth, label, tests, counts, duration, test? }] in the run's
 * order of files. `key` is what `collapsed` holds (file:<path> or suite:<path>:<titles>).
 */
export function treeRows(tests, { failuresOnly = false, collapsed = new Set() } = {}) {
  const shown = failuresOnly ? tests.filter((t) => t.status === 'failed') : tests;
  const files = new Map();
  for (const t of shown) {
    const k = `${t.from ?? t.runner}\u0000${t.file}`;
    if (!files.has(k)) files.set(k, []);
    files.get(k).push(t);
  }
  const rows = [];
  const group = (list) => ({ tests: list, counts: countTests(list), duration: list.reduce((n, t) => n + (t.duration ?? 0), 0) });
  for (const list of files.values()) {
    const file = list[0].file;
    const fileKey = `file:${list[0].from ?? list[0].runner}:${file}`;
    rows.push({ kind: 'file', key: fileKey, depth: 0, label: file || '(no file)', runner: list[0].runner, ...group(list) });
    if (collapsed.has(fileKey)) continue;
    // Suites in the order their first test came, each test under the deepest of them.
    const walk = (items, path, depth) => {
      const direct = [];
      const subs = new Map();
      for (const t of items) {
        if (t.suite.length > path.length) {
          const name = t.suite[path.length];
          if (!subs.has(name)) subs.set(name, []);
          subs.get(name).push(t);
          direct.push({ sub: name });
        } else direct.push({ test: t });
      }
      const done = new Set();
      for (const d of direct) {
        if (d.test) {
          rows.push({ kind: 'test', key: `test:${d.test.id}`, depth, label: d.test.name, test: d.test, tests: [d.test], counts: countTests([d.test]), duration: d.test.duration ?? 0 });
        } else if (!done.has(d.sub)) {
          done.add(d.sub);
          const under = subs.get(d.sub);
          const key = `suite:${fileKey}:${[...path, d.sub].join('\u0000')}`;
          rows.push({ kind: 'suite', key, depth, label: d.sub, ...group(under) });
          if (!collapsed.has(key)) walk(under, [...path, d.sub], depth + 1);
        }
      }
    };
    walk(list, [], 1);
  }
  return rows;
}
