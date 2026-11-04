// Vitest's and Jest's JSON reporters: both write Jest's shape, `testResults` (a file each, `name` its
// absolute path) holding `assertionResults` (a test each: `ancestorTitles`, `title`, `status`,
// `duration`, `failureMessages`, `location`), and a file that couldn't run has a `message` and no tests.
// Where the versions differ is read here: Jest's `failureDetails` (with `matcherResult`'s expected and
// actual), Vitest 1's `pending` for a skip, Vitest 3's per-file `startTime`/`endTime`. Pure.
import { makeFailure, makeTest, relPath, stripAnsi } from '../model.js';

const STATUS = { passed: 'passed', failed: 'failed', pending: 'skipped', skipped: 'skipped', todo: 'skipped', disabled: 'skipped', focused: 'passed' };

/** The matcher's own expected and actual, when Jest kept them (failureDetails[i].matcherResult), else nothing. */
function matcherValues(details) {
  for (const d of details ?? []) {
    const r = d?.matcherResult;
    if (r && ('expected' in r || 'actual' in r) && !r.pass) return { expected: r.expected, actual: r.actual };
  }
  return {};
}

/**
 * The tests of one Jest-shaped report. `runner` names them (`vitest`, `jest`); `root` is the folder
 * the paths are made relative to. A file whose suite failed before any test (a syntax error, an import
 * that threw) becomes one failed test named after the file, so it isn't lost.
 */
export function parseJestShape(json, { runner, root, version }) {
  const report = typeof json === 'string' ? JSON.parse(json) : json;
  const tests = [];
  const errors = [];
  for (const file of report.testResults ?? []) {
    const path = relPath(root, file.name ?? file.testFilePath ?? '');
    const assertions = file.assertionResults ?? file.testResults ?? [];
    if (!assertions.length && file.status === 'failed' && file.message) {
      tests.push(makeTest({ runner, file: path, suite: [], name: '(the file failed to run)', status: 'failed', duration: 0, failure: makeFailure({ message: file.message, root }) }));
      continue;
    }
    for (const a of assertions) {
      const status = STATUS[a.status] ?? 'skipped';
      const messages = (a.failureMessages ?? []).map(stripAnsi);
      const values = runner === 'jest' ? matcherValues(a.failureDetails) : {};
      tests.push(
        makeTest({
          runner,
          file: path,
          suite: a.ancestorTitles ?? [],
          name: a.title ?? a.fullName ?? '?',
          status,
          duration: a.duration ?? 0,
          ...(a.location?.line ? { line: a.location.line } : {}),
          ...(status === 'failed' ? { failure: makeFailure({ message: messages.join('\n\n') || 'Failed', root, ...values }) } : {}),
          ...(a.retryReasons?.length ? { flaky: status === 'passed' } : {}),
        }),
      );
    }
  }
  if (report.success === false && !tests.some((t) => t.status === 'failed') && report.numRuntimeErrorTestSuites) errors.push(`${report.numRuntimeErrorTestSuites} test file(s) failed to run`);
  return { runner, version, tests, errors, started: report.startTime ?? null };
}

/** Vitest 1, 2 and 3's JSON reporter (--reporter=json --outputFile.json=…). */
export const parseVitest = (json, opts) => parseJestShape(json, { ...opts, runner: 'vitest' });

/** Jest 29 and 30's --json --outputFile=… (with --testLocationInResults for the lines). */
export const parseJest = (json, opts) => parseJestShape(json, { ...opts, runner: 'jest' });
