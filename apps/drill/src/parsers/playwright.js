// Playwright's JSON reporter (1.40 and on: --reporter=json, PLAYWRIGHT_JSON_OUTPUT_NAME for the file):
// `suites` per file (`title` its path relative to the test folder, `file`), nested `suites` for each
// describe, `specs` (a test each, `file` and `line`) holding `tests` (one per project: chromium,
// firefox…) holding `results` (one per try: `status`, `duration`, `error(s)`, `attachments` with the
// screenshot, the trace and the video). A test that failed and then passed on a retry is `flaky`. Pure.
import { isAbsolute, join } from 'node:path';
import { makeFailure, makeTest, relPath } from '../model.js';

const STATUS = { expected: 'passed', unexpected: 'failed', flaky: 'passed', skipped: 'skipped' };

/**
 * The tests of a Playwright report: one per spec and project (the project's name last in the suite
 * when there is more than one), its last try's error and attachments. `root` is the folder paths are
 * made relative to; the report's own `config.rootDir` is where its file paths start.
 */
export function parsePlaywright(json, { root, version } = {}) {
  const report = typeof json === 'string' ? JSON.parse(json) : json;
  const testDir = report.config?.rootDir ?? report.config?.projects?.[0]?.testDir ?? root;
  // With more than one project (chromium, firefox…) a test runs in each: the project's name tells them apart.
  const many = (report.config?.projects?.length ?? 0) > 1;
  const tests = [];
  const pathOf = (file) => relPath(root, isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file) ? file : join(testDir ?? '', file));
  const walk = (suite, titles, file) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const results = t.results ?? [];
        const last = results.at(-1) ?? {};
        const status = STATUS[t.status] ?? (last.status === 'passed' ? 'passed' : last.status === 'skipped' ? 'skipped' : 'failed');
        const failed = results.filter((r) => r.status !== 'passed' && r.status !== 'skipped');
        const shownTry = status === 'failed' ? last : failed.at(-1) ?? last;
        const err = shownTry.error ?? shownTry.errors?.[0];
        const attachments = (shownTry.attachments ?? []).filter((a) => a.path).map((a) => ({ name: a.name, path: a.path, contentType: a.contentType }));
        tests.push(
          makeTest({
            runner: 'playwright',
            file: pathOf(spec.file ?? here ?? ''),
            suite: [...titles, ...(many && t.projectName ? [t.projectName] : [])],
            name: spec.title,
            status,
            duration: results.reduce((n, r) => n + (r.duration ?? 0), 0),
            line: spec.line,
            project: t.projectName,
            ...(t.status === 'flaky' ? { flaky: true, retries: results.length - 1 } : {}),
            ...(status === 'failed'
              ? {
                  failure: {
                    ...makeFailure({ message: err?.message ?? (last.status === 'timedOut' ? `Timed out after ${t.timeout ?? '?'}ms` : 'Failed'), stack: err?.stack ?? '', root }),
                    ...(err?.location ? { location: { file: relPath(root, err.location.file), line: err.location.line } } : {}),
                    ...(last.status === 'timedOut' ? { timedOut: true } : {}),
                  },
                }
              : {}),
            ...(attachments.length ? { attachments } : {}),
          }),
        );
      }
    }
    for (const s of suite.suites ?? []) walk(s, [...titles, s.title], here);
  };
  // The top level is one suite per file, titled with its path: the path is the file, not a title.
  for (const s of report.suites ?? []) walk(s, [], s.file ?? s.title);
  const errors = (report.errors ?? []).map((e) => String(e.message ?? e).split('\n')[0]);
  return { runner: 'playwright', version, tests, errors };
}
