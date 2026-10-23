// A process's Hail checks: its "test" (an .http file, and maybe an environment) run with
// `hail test` once its port answers, and again after each restart. The command line and reading the
// outcome are pure; `hailTest` runs it through run.js when hail is on the PATH.
import { findOnPath } from './which.js';
import { run } from './run.js';

/** bosun.json's "test": "api.http" or { "file": "api.http", "env": "dev" }, as { file, env }; null when it's neither. */
export function testSpec(value) {
  if (typeof value === 'string' && value.trim()) return { file: value.trim(), env: null };
  if (value && typeof value === 'object' && typeof value.file === 'string' && value.file.trim() && (value.env == null || typeof value.env === 'string')) return { file: value.file.trim(), env: value.env ?? null };
  return null;
}

const quote = (s, platform) => (/^[\w./\\:@-]+$/.test(s) ? s : platform === 'win32' ? `"${s.replace(/"/g, '""')}"` : `'${s.replace(/'/g, `'\\''`)}'`);

/** The shell line that runs `hail` (its path) on a test. */
export const hailCommand = (hail, { file, env }, platform = process.platform) => [quote(hail, platform), 'test', quote(file, platform), ...(env ? ['--env', quote(env, platform)] : [])].join(' ');

/**
 * What a run of hail test came to, from its exit code and output: { state: 'ok' | 'failed' | 'error',
 * failed, text }. 0 is all well, 1 something failed (the report's "N failed", else 1), 2 it couldn't run.
 */
export function testOutcome({ code, stdout = '', stderr = '' }) {
  const text = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
  if (code === 0) return { state: 'ok', failed: 0, text };
  if (code === 1) {
    const counts = [...text.matchAll(/(\d+) failed/g)].map((m) => Number(m[1]));
    return { state: 'failed', failed: counts.at(-1) || 1, text };
  }
  return { state: 'error', failed: 0, text };
}

/** How a process's tests read beside it: ✓ tests, ✗ 2 failed, ✗ tests (couldn't run), … tests. */
export function testsLabel(tests) {
  if (!tests) return null;
  if (tests.state === 'running') return { text: ' … tests', tone: 'warn' };
  if (tests.state === 'ok') return { text: ' ✓ tests', tone: 'add' };
  if (tests.state === 'failed') return { text: ` ✗ ${tests.failed} failed`, tone: 'del' };
  return { text: ' ✗ tests', tone: 'del' };
}

/**
 * Runs `hail test` on `test` in `cwd`: { missing: true } when hail isn't on the PATH, else the
 * { code, stdout, stderr } it ended with.
 */
export async function hailTest(test, { cwd, signal, find = findOnPath } = {}) {
  const hail = find('hail');
  if (!hail) return { missing: true };
  try {
    const { stdout, stderr } = await run(hailCommand(hail, test), { cwd, signal });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 2, stdout: e.stdout ?? '', stderr: e.stderr || (e.code == null ? e.message : '') };
  }
}
