// The command line each runner is started with: its reporter for Drill (to a file in a temporary
// folder) beside the one it shows people (into the Output view), and what to run: everything, some
// files, or some tests by name (or, for Playwright, file:line; for dotnet, the method's full name).
// **Everything put in a command line passes through `safeFile`, `namePattern` or `safeFqn`**: a test's
// name becomes a pattern of letters, digits and a few marks with '.' for the rest, so nothing in it
// is ever the shell's. Pure.
import { join } from 'node:path';

/** An argument quoted for the shell run.js starts: '…' for /bin/sh, "…" for cmd.exe. */
export const quote = (arg, platform = process.platform) => (platform === 'win32' ? `"${arg}"` : `'${arg}'`);

// What a path may hold to go in a command line, quoted, on either shell: no quotes, $, `, % or !.
const SAFE_PATH = /^[\p{L}\p{N} _.,/\\@+=:()[\]{}~#-]+$/u;

/** A path when it is one Drill will quote into a command, else null. */
export const safeFile = (p) => (typeof p === 'string' && p && SAFE_PATH.test(p) && !p.startsWith('-') ? p : null);

/** An option or path from drill.json's `args` (--project=chromium), when it is one Drill will quote into a command. */
export const safeArg = (a) => (typeof a === 'string' && a && SAFE_PATH.test(a) ? a : null);

/**
 * A test's name as a pattern the runners match names with (Vitest's and Jest's -t, node's
 * --test-name-pattern, Playwright's -g are regular expressions): letters, digits, spaces and a few
 * plain marks kept, anything else '.', which matches it. Never empty.
 */
export function namePattern(name) {
  const p = String(name ?? '').replace(/[^\p{L}\p{N} _,:@#=-]/gu, '.').slice(0, 200);
  return /[^.]/.test(p) ? p : null;
}

/** A .NET test's Namespace.Class.Method when it's one Drill will put in --filter, else null. */
export const safeFqn = (fqn) => (/^[\w.]+$/.test(String(fqn ?? '')) ? fqn : null);

const BASE = {
  vitest: (s) => `${s.exec ?? 'npx --no'} vitest run`,
  jest: (s) => `${s.exec ?? 'npx --no'} jest`,
  node: () => 'node --test',
  playwright: (s) => `${s.exec ?? 'npx --no'} playwright test`,
  dotnet: () => 'dotnet test',
};

/** Which file a test is in, relative to its suite's folder (the paths in results are the project's). */
export function suitePath(suite, file) {
  if (!suite.dir) return file;
  return file.startsWith(`${suite.dir}/`) ? file.slice(suite.dir.length + 1) : file;
}

/**
 * The command for one run of `suite`: { command, env, report } where `report` is the file (or for
 * dotnet the folder) the reporter writes. `tests` (results' tests, to run again) or `files` (paths
 * relative to the project) narrow it; neither runs everything. `out` is the temporary folder.
 */
export function buildCommand(suite, { tests = null, files = null, out, platform = process.platform }) {
  const q = (a) => quote(a, platform);
  const parts = [suite.command ?? BASE[suite.runner](suite)];
  const env = { FORCE_COLOR: '1' };
  const report = join(out, suite.runner === 'node' ? 'report.tap' : suite.runner === 'dotnet' ? 'trx' : 'report.json');
  const fileArgs = (list) => [...new Set(list.map((f) => safeFile(suitePath(suite, f))).filter(Boolean))].map(q);
  const names = (list) => {
    const ps = [...new Set(list.map((t) => namePattern(t.name)).filter(Boolean))];
    return ps.length ? (ps.length === 1 ? ps[0] : `(${ps.join('|')})`) : null;
  };
  const picked = tests ?? null;
  const pickedFiles = picked ? [...new Set(picked.map((t) => t.file))] : files;

  switch (suite.runner) {
    case 'vitest': {
      parts.push('--reporter=default', '--reporter=json', q(`--outputFile.json=${report}`));
      if (pickedFiles) parts.push(...fileArgs(pickedFiles));
      const n = picked && names(picked);
      if (n) parts.push('-t', q(n));
      break;
    }
    case 'jest': {
      parts.push('--json', q(`--outputFile=${report}`), '--testLocationInResults');
      if (pickedFiles) parts.push(...fileArgs(pickedFiles));
      const n = picked && names(picked);
      if (n) parts.push('-t', q(n));
      break;
    }
    case 'node': {
      parts.push('--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', q(`--test-reporter-destination=${report}`));
      const n = picked && names(picked);
      if (n) parts.push(q(`--test-name-pattern=${n}`));
      if (pickedFiles) parts.push(...fileArgs(pickedFiles));
      else if (suite.args?.length) parts.push(...suite.args.filter(safeArg).map(q));
      break;
    }
    case 'playwright': {
      parts.push('--reporter=list,json');
      env.PLAYWRIGHT_JSON_OUTPUT_NAME = report;
      // A test by its file and line: exactly that one, in every project.
      if (picked) parts.push(...[...new Set(picked.map((t) => (t.line ? `${suitePath(suite, t.file)}:${t.line}` : suitePath(suite, t.file))))].filter(safeFile).map(q));
      else if (pickedFiles) parts.push(...fileArgs(pickedFiles));
      break;
    }
    case 'dotnet': {
      if (suite.target && safeFile(suite.target)) parts.push(q(suite.target));
      parts.push('--logger', q('trx;LogFileName=drill.trx'), '--logger', q('console;verbosity=normal'), '--results-directory', q(report));
      const fqns = picked ? [...new Set(picked.map((t) => safeFqn(t.fqn)).filter(Boolean))] : [];
      // Files, for .NET, are test classes (changed files mapped to them): ~ matches the class's name in the full one.
      const classes = !picked && files ? [...new Set(files.map((f) => safeFqn(f)).filter(Boolean))] : [];
      const filter = [...fqns.map((f) => `FullyQualifiedName=${f}`), ...classes.map((c) => `FullyQualifiedName~${c}.`)].join('|');
      if (filter) parts.push('--filter', q(filter));
      break;
    }
  }
  if (suite.args?.length && suite.runner !== 'node') parts.push(...suite.args.filter(safeArg).map(q));
  return { command: parts.join(' '), env, report };
}

/** How to ask a runner which version it is, when no package says (node, dotnet). */
export const VERSION_COMMANDS = { node: 'node --version', dotnet: 'dotnet --version' };
