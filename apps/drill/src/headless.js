// drill run and drill list: the same finding and running as the app, without the screen, for a
// pipeline and for `fleet mcp` (an agent asking "what fails?"). `drill run` prints the failures first
// (or --json), and its exit code is the family's: 0 everything passed, 1 a test failed (as --fail-on
// counts them), 2 it couldn't run (no tests found, or a runner wrote no report).
import { resolve } from 'node:path';
import { RUNNERS, RUNNER_NAMES } from './parsers/index.js';
import { countLine, countTests, duration } from './model.js';
import { filesBySuiteOf, runSuites } from './session.js';
import { flakyTests, recordRun } from './flaky.js';
import { classesIn, testsTouching } from './changed.js';

export const HEADLESS = ['run', 'list'];
export const FAIL_ON = ['any', 'not-flaky', 'none'];

/** { command, dir, json, failOn, runners, changed, all } from the arguments after `drill`; `error` when they don't add up. */
export function parseArgs(args) {
  const [command, ...rest] = args;
  const opts = { command, dir: '.', json: false, failOn: 'any', runners: [], changed: false, all: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--changed') opts.changed = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--fail-on') opts.failOn = String(rest[++i] ?? '').toLowerCase();
    else if (a.startsWith('--fail-on=')) opts.failOn = a.slice(10).toLowerCase();
    else if (a === '--runner') opts.runners.push(String(rest[++i] ?? '').toLowerCase());
    else if (a.startsWith('--runner=')) opts.runners.push(a.slice(9).toLowerCase());
    else if (a.startsWith('-')) return { ...opts, error: `Unknown option ${a}` };
    else opts.dir = a;
  }
  if (!FAIL_ON.includes(opts.failOn)) return { ...opts, error: `--fail-on is one of ${FAIL_ON.join(', ')}` };
  const bad = opts.runners.find((r) => !RUNNERS.includes(r));
  if (bad !== undefined) return { ...opts, error: `--runner is one of ${RUNNERS.join(', ')}` };
  return opts;
}

/** A failure as the JSON gives it: where, what, expected and actual, the diff as text, the project's frames. */
export function failureJson(t) {
  const f = t.failure ?? {};
  return {
    id: t.id,
    runner: t.runner,
    file: t.source ?? t.file,
    ...(t.line ? { line: t.line } : {}),
    suite: t.suite,
    name: t.name,
    ...(t.fqn ? { fqn: t.fqn } : {}),
    message: f.message ?? '',
    ...(f.expected !== undefined ? { expected: f.expected, actual: f.actual } : {}),
    ...(f.diff?.length ? { diff: f.diff.map((d) => `${d.kind}${d.text}`).join('\n') } : {}),
    frames: (f.frames ?? []).map((x) => ({ file: x.file, line: x.line, ...(x.method ? { method: x.method } : {}) })),
    ...(t.attachments?.length ? { attachments: t.attachments } : {}),
    ...(t.flaky ? { flaky: true } : {}),
  };
}

/** Runs one of HEADLESS; resolves the exit code. `write` prints; `provider` is provider.js's (demo.js's in tests). */
export async function runHeadless(args, { provider, write = (s) => process.stdout.write(s), onData = () => {} }) {
  const opts = parseArgs(args);
  if (opts.error) {
    write(`drill ${opts.command}: ${opts.error}\n`);
    return 2;
  }
  const root = resolve(opts.dir);
  try {
    const found = await provider.detect(root);
    const suites = found.suites.filter((s) => !opts.runners.length || opts.runners.includes(s.runner));
    if (opts.command === 'list') {
      if (opts.json) write(`${JSON.stringify({ app: 'drill', dir: root, suites: suites.map(({ cwd, ...s }) => s), notes: found.notes }, null, 2)}\n`);
      else {
        write(suites.length ? '' : `${found.notes.join('\n') || 'No tests found.'}\n`);
        for (const s of suites) write(`${RUNNER_NAMES[s.runner].padEnd(12)} ${s.dir || '.'}${s.target ? ` (${s.target})` : ''}${s.version ? `  ${s.version}` : ''}${s.url ? `  e2e against ${s.url}` : ''}  from ${s.from}\n`);
      }
      return suites.length ? 0 : 2;
    }
    if (!suites.length) {
      const why = found.notes.join(' ') || 'No tests found.';
      write(opts.json ? `${JSON.stringify({ app: 'drill', dir: root, ok: false, error: why, counts: countTests([]), runners: [], failures: [] }, null, 2)}\n` : `${why}\n`);
      return 2;
    }
    let filesBySuite = null;
    let changedNote = null;
    if (opts.changed) {
      const changed = await provider.changed(root);
      if (changed.error) {
        write(`drill run --changed: ${changed.error}\n`);
        return 2;
      }
      const testFiles = await provider.testFiles(root);
      const touching = testsTouching(changed.files, testFiles);
      filesBySuite = filesBySuiteOf(suites, touching.map((t) => t.path), { classesOf: (p) => classesIn(testFiles.find((f) => f.path === p)?.text) });
      changedNote = `${changed.files.length} changed file${changed.files.length === 1 ? '' : 's'}, ${touching.length} test file${touching.length === 1 ? '' : 's'} touching them`;
      if (!filesBySuite.size) {
        write(opts.json ? `${JSON.stringify({ app: 'drill', dir: root, ok: true, changed: changedNote, counts: countTests([]), runners: [], failures: [] }, null, 2)}\n` : `${changedNote}: nothing to run.\n`);
        return 0;
      }
    }
    const started = Date.now();
    const { results, tests, counts, ranAll } = await runSuites(provider, { root, suites, filesBySuite, onData });
    const history = recordRun(provider.loadHistory(root), tests);
    provider.saveHistory(root, history);
    const flaky = flakyTests(history);
    const flakyIds = new Set(flaky.map((f) => f.id));
    const failures = tests.filter((t) => t.status === 'failed');
    const counting = opts.failOn === 'none' ? [] : opts.failOn === 'not-flaky' ? failures.filter((t) => !flakyIds.has(t.id)) : failures;
    const code = !ranAll ? 2 : counting.length ? 1 : 0;
    if (opts.json) {
      write(
        `${JSON.stringify(
          {
            app: 'drill',
            dir: root,
            ok: code === 0,
            ...(changedNote ? { changed: changedNote } : {}),
            counts,
            duration: Date.now() - started,
            runners: results.map((r) => ({ suite: r.suite, runner: r.runner, dir: r.dir, version: r.version ?? null, pin: r.pin ?? null, ...(r.note ? { note: r.note } : {}), ...(r.command ? { command: r.command } : {}), ran: r.ran, ...(r.error ? { error: r.error } : {}), ...(r.errors?.length ? { errors: r.errors } : {}), counts: countTests(r.tests) })),
            failures: failures.map(failureJson),
            flaky: flaky.map((f) => ({ id: f.id, runner: f.runner, file: f.file, name: f.name, passes: f.passes, fails: f.fails, marks: f.marks })),
            ...(opts.all ? { tests: tests.map((t) => ({ id: t.id, runner: t.runner, file: t.file, suite: t.suite, name: t.name, status: t.status, duration: t.duration, ...(t.line ? { line: t.line } : {}) })) } : {}),
          },
          null,
          2,
        )}\n`,
      );
      return code;
    }
    const out = [];
    for (const r of results) {
      const c = countTests(r.tests);
      out.push(`${RUNNER_NAMES[r.runner]}${r.dir ? ` in ${r.dir}` : ''}${r.pin ? ` (${r.pin})` : ''}: ${r.ran ? countLine(c) : "couldn't run"}`);
      if (r.note) out.push(`  ${r.note}`);
      if (!r.ran) out.push(...String(r.error).split('\n').map((l) => `  ${l}`));
      for (const e of r.errors ?? []) out.push(`  ${e}`);
    }
    for (const t of failures) {
      const f = t.failure;
      out.push('', `FAIL ${t.source ?? t.file}${t.line ? `:${t.line}` : ''}  ${[...t.suite, t.name].join(' › ')}${flakyIds.has(t.id) ? '  (flaky)' : ''}`);
      out.push(...f.message.split('\n').slice(0, 6).map((l) => `     ${l}`));
      if (f.diff?.length) out.push(...f.diff.slice(0, 20).map((d) => `     ${d.kind} ${d.text}`));
      for (const fr of f.frames.slice(0, 5)) out.push(`     at ${fr.file}:${fr.line}${fr.method ? ` (${fr.method})` : ''}`);
    }
    out.push('', `${countLine(counts)} in ${duration(Date.now() - started)}${changedNote ? ` (${changedNote})` : ''}`);
    write(`${out.join('\n')}\n`);
    return code;
  } catch (e) {
    write(`drill ${opts.command}: ${String(e.message).split('\n')[0]}\n`);
    return 2;
  }
}
