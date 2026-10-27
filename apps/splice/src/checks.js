// Checks before a push (and /ship): commands of the repository's own, run in its folder before git
// push, each passing or failing by its exit code. They're `.splice/checks.json` when the repository has
// one, else worked out from what's there (package.json's test and lint scripts, a .sln, Hail's .http
// files). Off until turned on, for a repository (/checks on) or everywhere (the setting); git's own
// pre-push hook still runs after them, as git always runs it. The working out and the running are
// pure over what they're given; `lookAround` reads the folder.
import { readdirSync, readFileSync, statSync, accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { run } from '@fleet/kit/run.js';

export const CHECKS_FILE = join('.splice', 'checks.json');

// npm init's placeholder test script, which only fails.
const NO_TEST = /no test specified/;

const quote = (s) => (/^[\w./:@\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** The package manager the lock file says: npm, pnpm, yarn or bun. */
export function packageManager(files) {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun';
  return 'npm';
}

/**
 * The checks worked out from the repository: [{ name, run }]. `files`: the names at its top; `pkg`:
 * package.json, parsed, or null; `http`: the .http files (paths from the top); `hail`: how to run Hail
 * (a command, `hail` or Fleet's `"<fleet>" --run hail`), or null when there's none.
 */
export function detectChecks({ files = [], pkg = null, http = [], hail = null }) {
  const out = [];
  const scripts = pkg?.scripts ?? {};
  const pm = packageManager(files);
  if (typeof scripts.test === 'string' && scripts.test.trim() && !NO_TEST.test(scripts.test)) out.push({ name: 'test', run: pm === 'npm' ? 'npm test' : `${pm} test` });
  if (typeof scripts.lint === 'string' && scripts.lint.trim()) out.push({ name: 'lint', run: `${pm} run lint` });
  const slns = files.filter((f) => /\.slnx?$/i.test(f)).sort();
  for (const sln of slns) out.push({ name: slns.length > 1 ? `dotnet test ${sln}` : 'dotnet test', run: slns.length > 1 ? `dotnet test ${quote(sln)}` : 'dotnet test' });
  if (hail) for (const file of [...http].sort()) out.push({ name: `hail ${file.replace(/\\/g, '/')}`, run: `${hail} test ${quote(file)}` });
  return out;
}

/**
 * `.splice/checks.json`: { "checks": [ "npm test", { "name": "lint", "run": "npm run lint" } ] } (a bare
 * list works too). Returns { checks, problems }; a check needs a command, and a name is made from it.
 */
export function readChecksFile(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { checks: [], problems: [`${CHECKS_FILE.replace(/\\/g, '/')} isn't JSON: ${e.message}`] };
  }
  const list = Array.isArray(raw) ? raw : raw?.checks;
  if (!Array.isArray(list)) return { checks: [], problems: [`${CHECKS_FILE.replace(/\\/g, '/')} has no "checks" list.`] };
  const checks = [];
  const problems = [];
  list.forEach((c, i) => {
    const run = typeof c === 'string' ? c : c?.run;
    if (typeof run !== 'string' || !run.trim()) return problems.push(`Check ${i + 1} has no command ("run").`);
    checks.push({ name: (typeof c === 'object' && typeof c.name === 'string' && c.name.trim()) || run.trim(), run: run.trim() });
  });
  return { checks, problems };
}

/** What `/checks edit` writes when there's no file yet: the detected checks, to change from there. */
export const checksFileText = (checks) => `${JSON.stringify({ checks: checks.map(({ name, run }) => ({ name, run })) }, null, 2)}\n`;

/**
 * Whether checks run before a push in the repository at `root`: `/checks on|off` for it (the config's
 * `checks`, by folder), else the "Checks before push" setting (`checksBeforePush`, off by default).
 */
export function checksOn(config, root, same = (a, b) => a === b) {
  const mine = Object.entries(config.checks ?? {}).find(([dir]) => same(dir, root));
  if (mine) return mine[1] === true;
  return config.checksBeforePush === true;
}

/** The config with checks turned on or off for `root`. */
export function setChecksOn(config, root, on, same = (a, b) => a === b) {
  const rest = Object.fromEntries(Object.entries(config.checks ?? {}).filter(([dir]) => !same(dir, root)));
  return { ...config, checks: { ...rest, [root]: on } };
}

/** 1.2s, 850ms, 1m 05s. */
export function duration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** A check's line in the activity lines: ✓ or ✗, its name and how long it took; … while it runs, · when it didn't. */
export function checkLine(r) {
  if (r.state === 'running') return `… ${r.name}`;
  if (r.state === 'waiting') return `· ${r.name}`;
  if (r.state === 'skipped') return `· ${r.name} (not run: stopped)`;
  return `${r.ok ? '✓' : '✗'} ${r.name}  ${duration(r.ms)}${r.ok ? '' : r.code != null ? `  (exit ${r.code})` : ''}`;
}

/**
 * Runs `checks` one after another: `runOne(check, signal)` resolves { ok, code, output } (a failure is a
 * result, not a throw; a throw counts as a failure with its message). `onUpdate(results)` hears each
 * change, for the lines on screen; `now` is the clock. A cancelled signal stops at the check running,
 * the rest marked skipped. Resolves { results, ok, failed, cancelled }.
 */
export async function runChecks(checks, { runOne, onUpdate = () => {}, now = () => Date.now(), signal } = {}) {
  const results = checks.map((c) => ({ ...c, state: 'waiting' }));
  const tell = () => onUpdate(results.map((r) => ({ ...r })));
  let cancelled = false;
  for (const [i, c] of checks.entries()) {
    if (signal?.aborted) {
      cancelled = true;
      for (const r of results.slice(i)) r.state = 'skipped';
      break;
    }
    results[i].state = 'running';
    tell();
    const started = now();
    let r;
    try {
      r = await runOne(c, signal);
    } catch (e) {
      r = { ok: false, code: e.code ?? null, output: String(e.message ?? e), cancelled: e.cancelled };
    }
    if (r.cancelled || signal?.aborted) {
      cancelled = true;
      for (const x of results.slice(i)) x.state = 'skipped';
      break;
    }
    Object.assign(results[i], { state: 'done', ok: Boolean(r.ok), code: r.code ?? null, output: String(r.output ?? ''), ms: now() - started });
  }
  tell();
  const failed = results.filter((r) => r.state === 'done' && !r.ok);
  return { results, ok: !cancelled && !failed.length, failed, cancelled };
}

/** The summary: "3 checks passed", "1 of 3 checks failed: lint". */
export function checksSummary({ results, failed, cancelled }) {
  const n = results.length;
  if (cancelled) return `Checks stopped (${results.filter((r) => r.state === 'done').length} of ${n} run)`;
  if (!failed.length) return `${n === 1 ? 'The check' : `${n} checks`} passed`;
  return `${failed.length} of ${n} check${n === 1 ? '' : 's'} failed: ${failed.map((r) => r.name).join(', ')}`;
}

/** The failed checks' output, for the viewer: each one's command and the end of what it said. */
export function failedText(failed, keep = 200) {
  return failed
    .map((r) => {
      const lines = r.output.replace(/\r\n?/g, '\n').trimEnd().split('\n');
      const cut = lines.length > keep ? [`… ${lines.length - keep} lines before`, ...lines.slice(-keep)] : lines;
      return [`✗ ${r.name}  (${r.run}, ${duration(r.ms ?? 0)}${r.code != null ? `, exit ${r.code}` : ''})`, '', ...cut].join('\n');
    })
    .join('\n\n');
}

/** The full path of `name` on the PATH, or null (each of PATHEXT's extensions on Windows). */
export function onPath(name, { env = process.env, platform = process.platform } = {}) {
  const win = platform === 'win32';
  const dirs = String((win ? (env.PATH ?? env.Path) : env.PATH) ?? '').split(win ? ';' : delimiter).filter(Boolean);
  const exts = win ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = join(dir.replace(/^"(.*)"$/, '$1'), name + ext);
      try {
        if (!statSync(file).isFile()) continue;
        if (!win) accessSync(file, constants.X_OK);
        return file;
      } catch {}
    }
  }
  return null;
}

// Folders never looked in for .http files.
const SKIP = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', 'target', 'vendor', '.venv']);

/** The .http files in `root` and the folders under it, `depth` deep at most, as paths from it. */
export function httpFiles(root, { depth = 3, fs = { readdirSync } } = {}) {
  const out = [];
  const walk = (dir, rel, left) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (left > 0 && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, left - 1);
      } else if (/\.http$/i.test(e.name)) out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk(root, '', depth);
  return out.sort();
}

/**
 * How to run Hail's tests: `hail` on the PATH, else, inside Fleet's own build (whose executable has
 * every app in it), `"<fleet>" --run hail`; null when there's neither.
 */
export function hailCommand({ findHail = () => onPath('hail'), hosted = false, compiled = false, execPath = process.execPath } = {}) {
  if (findHail()) return 'hail';
  if (hosted && compiled) return `${quote(execPath)} --run hail`;
  return null;
}

/**
 * The checks for the repository at `root`: { checks, from: 'file' | 'detected', problems }, from
 * `.splice/checks.json` when it's there, else worked out. `hail` as hailCommand says.
 */
export function lookAround(root, { hail = null, fs = { readdirSync, readFileSync } } = {}) {
  let text = null;
  try {
    text = fs.readFileSync(join(root, CHECKS_FILE), 'utf8');
  } catch {}
  if (text != null) return { ...readChecksFile(text), from: 'file' };
  let files = [];
  try {
    files = fs.readdirSync(root);
  } catch {}
  let pkg = null;
  if (files.includes('package.json')) {
    try {
      pkg = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8'));
    } catch {}
  }
  const http = hail ? httpFiles(root, { fs }) : [];
  return { checks: detectChecks({ files, pkg, http, hail }), from: 'detected', problems: [] };
}

/**
 * Runs one check's command through the shell in `cwd` (the kit's run.js: no terminal, an abort stops
 * the whole tree): { ok, code, output }, a failing exit being a result.
 */
export async function runCheckCommand(check, { cwd, signal } = {}) {
  try {
    const { stdout, stderr } = await run(check.run, { cwd, signal });
    return { ok: true, code: 0, output: [stdout, stderr].filter(Boolean).join('\n') };
  } catch (e) {
    return { ok: false, code: e.code ?? null, output: [e.stdout, e.stderr].filter(Boolean).join('\n') || e.message, cancelled: Boolean(e.cancelled) };
  }
}
