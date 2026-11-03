// What Drill hands its siblings (family.js) and the text a failure is shown and copied as. Pure.
// A failure goes as a `test` context: its file and line (the first of the project's own frames when the
// runner names no file, as TRX doesn't), its name and the first line of its message. Splice takes it
// and blames the file at that line; Drill takes it back and runs the test again.
import { duration } from './model.js';

/** Where a test is, for a hand-off and the editor: { file, line } of the project's own (or null). */
export function placeOf(t) {
  const own = t.failure?.frames?.find((f) => f.own);
  if (t.runner === 'dotnet') return own ? { file: own.file, line: own.line } : t.source ? { file: t.source, ...(t.line ? { line: t.line } : {}) } : null;
  // The line the assertion failed at, when the stack has it in the test's own file; else the test's.
  const inFile = t.failure?.frames?.find((f) => f.own && f.file === t.file);
  return { file: t.file, ...(inFile ? { line: inFile.line } : t.line ? { line: t.line } : {}) };
}

/** The `test` context for a test (failed or not): { file, line?, name, message? }. Nothing secret: the message's first line only. */
export function testContext(t) {
  const where = placeOf(t) ?? { file: t.file };
  const message = t.failure?.message?.split('\n')[0];
  return { file: where.file, ...(where.line ? { line: where.line } : {}), name: [...t.suite, t.name].join(' › '), ...(message ? { message: message.slice(0, 200) } : {}), runner: t.runner };
}

/** The test a `test` context names, among `tests`: by file and full name, else by name alone. */
export function findTest(tests, data) {
  const full = (t) => [...t.suite, t.name].join(' › ');
  const name = String(data?.name ?? '');
  return (
    tests.find((t) => full(t) === name && (t.file === data.file || t.source === data.file)) ??
    tests.find((t) => full(t) === name) ??
    tests.find((t) => t.name === name || name.endsWith(` › ${t.name}`)) ??
    null
  );
}

/** A failure as text, for y and the viewer: what failed, where, the message, the diff and the frames. */
export function failureText(t) {
  const f = t.failure ?? {};
  const where = placeOf(t);
  const lines = [`${[...t.suite, t.name].join(' › ')}`, `${t.runner} · ${where ? `${where.file}${where.line ? `:${where.line}` : ''}` : t.file} · ${duration(t.duration)}`, '', f.message ?? ''];
  if (f.diff?.length) lines.push('', '- Expected', '+ Actual', ...f.diff.map((d) => `${d.kind} ${d.text}`));
  if (f.frames?.length) lines.push('', ...f.frames.map((fr) => `    at ${fr.file}:${fr.line}${fr.method ? ` (${fr.method})` : ''}`));
  for (const a of t.attachments ?? []) lines.push(`${a.name}: ${a.path}`);
  return lines.join('\n');
}
