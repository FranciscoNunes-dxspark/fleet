// Flaky tests: ones that both passed and failed in the last runs, kept per project in
// ~/.drill/history/<hash of the project's path>.json (DRILL_HOME for tests). Each run records the tests
// it ran as passed or failed (a run of one test records that one); a test Playwright retried into a
// pass counts as a failure and a pass. Pure, but for `loadHistory` and `saveHistory`.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configDir } from './config.js';

export const KEEP_RUNS = 30;
export const WINDOW = 10;

const empty = () => ({ runs: [], tests: {} });

/** Where `root`'s history is kept (the same file whatever the path's case on Windows). */
export function historyFile(root, home = configDir(), platform = process.platform) {
  const path = resolve(root);
  const hash = createHash('sha1').update(platform === 'win32' ? path.toLowerCase() : path).digest('hex').slice(0, 16);
  return join(home, 'history', `${hash}.json`);
}

export function loadHistory(root, home) {
  try {
    const h = JSON.parse(readFileSync(historyFile(root, home), 'utf8'));
    return Array.isArray(h.runs) && h.tests ? h : empty();
  } catch {
    return empty();
  }
}

export function saveHistory(root, history, home) {
  try {
    const file = historyFile(root, home);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(history));
    renameSync(`${file}.tmp`, file);
  } catch {
    // A read-only home only loses the history.
  }
}

/**
 * `history` with a run of `tests` added (passed 'p', failed 'f', retried into a pass 'r'; skipped
 * ones left out), the newest KEEP_RUNS kept. What each test is (runner, file, suite, name, line) is
 * kept beside it, to list it when it isn't in the current results.
 */
export function recordRun(history, tests, at = Date.now()) {
  const results = {};
  const meta = { ...history.tests };
  for (const t of tests) {
    if (t.status === 'skipped') continue;
    results[t.id] = t.status === 'failed' ? 'f' : t.flaky ? 'r' : 'p';
    meta[t.id] = { runner: t.runner, file: t.file, suite: t.suite, name: t.name, ...(t.line ? { line: t.line } : {}), ...(t.fqn ? { fqn: t.fqn } : {}) };
  }
  if (!Object.keys(results).length) return history;
  const runs = [...history.runs, { at, results }].slice(-KEEP_RUNS);
  // Only what the kept runs mention stays described: asked of the newest run first, which mentions
  // most of them (a set of every run's ids took 0.15 s for thirty runs of 20,000 tests).
  const kept = {};
  for (const id in meta) {
    for (let i = runs.length - 1; i >= 0; i--) {
      if (id in runs[i].results) {
        kept[id] = meta[id];
        break;
      }
    }
  }
  return { runs, tests: kept };
}

/**
 * The tests that both passed and failed in the last `window` runs they were in: [{ id, ...meta,
 * passes, fails, marks, last, lastFailed }], most failures first. `marks` reads oldest to newest
 * (✓ passed, ✗ failed, ↻ passed on a retry).
 */
export function flakyTests(history, { window = WINDOW } = {}) {
  // Each test's results as a string, oldest first ('ppfp'): thirty runs of 20,000 tests read as
  // objects took half a second, and this runs after every run.
  const per = new Map();
  for (const run of history.runs) {
    for (const id in run.results) {
      const r = run.results[id];
      // One letter each; anything else a hand-edited file holds counts as neither.
      per.set(id, (per.get(id) ?? '') + (r === 'p' || r === 'f' || r === 'r' ? r : '?'));
    }
  }
  const out = [];
  for (const [id, all] of per) {
    const seen = all.slice(-window);
    let fails = 0;
    let passes = 0;
    for (const r of seen) {
      if (r === 'f' || r === 'r') fails++;
      if (r === 'p' || r === 'r') passes++;
    }
    if (!fails || !passes) continue;
    // The newest run it didn't simply pass in, which is among the ones seen as it failed in one of them.
    const lastFail = history.runs.findLast((run) => id in run.results && run.results[id] !== 'p');
    out.push({
      id,
      ...(history.tests[id] ?? { name: id, suite: [], file: '', runner: id.split(':')[0] }),
      passes,
      fails,
      runs: seen.length,
      marks: [...seen].map((r) => (r === 'p' ? '✓' : r === 'f' ? '✗' : '↻')).join(''),
      last: seen.at(-1),
      lastFailed: lastFail?.at ?? null,
    });
  }
  return out.sort((a, b) => b.fails / b.runs - a.fails / a.runs || (b.lastFailed ?? 0) - (a.lastFailed ?? 0));
}
