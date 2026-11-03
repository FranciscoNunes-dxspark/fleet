// Everything Drill reads, runs and asks goes through this one object, createDrill(): finding the
// suites, running one (its own output to `onData`, for the Output view's virtual terminal; the report
// to a temporary folder, parsed with the parser pinned to its version), what git says changed, the
// project's test files, watching the folder, opening an editor or Playwright's trace viewer, asking
// whether the app is up, and the flaky history. src/demo.js has the same interface for --demo and the
// tests: a new operation needs both.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { run as kitRun } from '@fleet/kit/run.js';
import { SKIP_DIRS, detect } from './detect.js';
import { parserFor } from './parsers/index.js';
import { VERSION_COMMANDS, buildCommand } from './runners.js';
import { stripAnsi } from './model.js';
import { isTestFile, parsePorcelain } from './changed.js';
import { checkApp } from './e2e.js';
import { loadHistory, saveHistory } from './flaky.js';

const slashes = (p) => p.replace(/\\/g, '/');

/** The disk, as detect.js reads it: `read(path)` → text or null, `list(dir)` → [{ name, dir }]. */
export const diskFs = {
  read: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  list: (d) => {
    try {
      return readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
    } catch {
      return [];
    }
  },
};

/** Every file under `dir` the walk `want`s (relative, /-separated), skipping build output and hidden folders, `max` at most. */
function walkFiles(dir, want, max = 3000) {
  const out = [];
  const walk = (d, level) => {
    if (out.length >= max || level > 8) return;
    for (const e of diskFs.list(d)) {
      if (e.dir) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(d, e.name), level + 1);
      } else {
        const rel = slashes(relative(dir, join(d, e.name)));
        if (want(rel) && out.length < max) out.push(rel);
      }
    }
  };
  walk(dir, 0);
  return out;
}

/** The first lines worth saying of a run that wrote no report: its error output, else its output, without colour. */
function whyNoReport(error, command) {
  const text = stripAnsi(error?.stderr || error?.stdout || error?.message || '').trim();
  const lines = text.split('\n').filter((l) => l.trim()).slice(-4);
  return lines.length ? lines.join('\n') : `${command} wrote no report${error?.code != null ? ` (exit ${error.code})` : ''}.`;
}

export function createDrill({ run = kitRun, fetchImpl = globalThis.fetch, home, fs = diskFs } = {}) {
  // Versions asked of a program (node --version), once a session.
  const versions = new Map();
  const askVersion = async (runner, cwd) => {
    if (!VERSION_COMMANDS[runner]) return null;
    if (!versions.has(runner)) {
      versions.set(
        runner,
        run(VERSION_COMMANDS[runner], { cwd }).then(
          ({ stdout }) => stdout.trim().replace(/^v/, '') || null,
          () => null,
        ),
      );
    }
    return versions.get(runner);
  };

  return {
    detect: async (root) => detect(root, fs),

    /**
     * One run of `suite` (detect's): everything, `tests` (results' tests, to run again) or `files`
     * (relative to `root`). The runner's own output goes to `onData` as it comes. Resolves
     * { suite, runner, version, pin, note, command, tests, errors, ran, error?, exit } — `ran` false
     * when no report came (the error says why); a run whose tests failed still ran.
     */
    async runSuite(suite, { root, tests = null, files = null, signal, onData = () => {} } = {}) {
      const out = mkdtempSync(join(tmpdir(), 'drill-'));
      const started = Date.now();
      try {
        const version = suite.version ?? (await askVersion(suite.runner, suite.cwd));
        const parser = parserFor(suite.runner, version);
        const { command, env, report } = buildCommand(suite, { tests, files, out });
        onData(`\x1b[2m$ ${command}\x1b[0m\r\n`);
        let exit = 0;
        let failure = null;
        try {
          await run(command, { cwd: suite.cwd, signal, env, onLine: (line) => onData(`${line}\r\n`) });
        } catch (e) {
          if (e.cancelled) throw e;
          exit = e.code ?? 1;
          failure = e;
        }
        const reports =
          suite.runner === 'dotnet'
            ? walkFiles(report, (p) => p.endsWith('.trx'), 50).map((p) => join(report, p))
            : [report];
        const texts = reports.map((p) => fs.read(p)).filter((t) => t != null && t.trim());
        const base = { suite: suite.id, runner: suite.runner, dir: suite.dir, version, pin: parser.pin, note: parser.note, command, exit, duration: Date.now() - started };
        if (!texts.length) return { ...base, ran: false, tests: [], errors: [], error: whyNoReport(failure, command) };
        const tested = [];
        const errors = [];
        try {
          for (const t of texts) {
            const r = parser.parse(t, { root, version });
            tested.push(...r.tests);
            errors.push(...r.errors);
          }
        } catch (e) {
          return { ...base, ran: false, tests: [], errors: [], error: `Couldn't read ${parser.pin}'s report: ${String(e.message).split('\n')[0]}` };
        }
        return { ...base, ran: true, tests: tested, errors };
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },

    /** Whether anything answers at `url` (e2e.js's checkApp). */
    appUp: (url, opts = {}) => checkApp(url, { fetchImpl, ...opts }),

    /**
     * The files git says changed in `root` (`git status --porcelain`, as Splice shows them), relative
     * to `root` and /-separated: { files } or { error }.
     */
    async changed(root, { signal } = {}) {
      try {
        const prefix = (await run('git rev-parse --show-prefix', { cwd: root, signal })).stdout.trim();
        const { stdout } = await run('git status --porcelain=v1 -uall', { cwd: root, signal });
        const files = parsePorcelain(stdout)
          .filter((p) => !prefix || p.startsWith(prefix))
          .map((p) => p.slice(prefix.length));
        return { files };
      } catch (e) {
        if (e.cancelled) throw e;
        return { error: /not a git repository/i.test(e.message) ? `${root} isn't in a git repository.` : `git: ${String(e.message).split('\n')[0]}` };
      }
    },

    /** The project's test files with their text (256 KB of each at most), for mapping changes to them. */
    async testFiles(root) {
      const paths = walkFiles(root, (p) => isTestFile(p) || /Tests?\/.*\.cs$/.test(p));
      return paths.map((path) => {
        const text = fs.read(join(root, path)) ?? '';
        return { path, text: text.slice(0, 256 * 1024) };
      });
    },

    /**
     * Calls `onChange(paths)` a moment after files under `root` change (build output, node_modules and
     * hidden folders aside, and drill.json's `watch.ignore` prefixes); returns the function that stops it.
     */
    watch(root, onChange, { ignore = [], debounce = 300 } = {}) {
      let timer = null;
      const seen = new Set();
      let watcher;
      try {
        watcher = fsWatch(root, { recursive: true }, (event, name) => {
          if (!name) return;
          const path = slashes(String(name));
          if (path.split('/').some((part) => SKIP_DIRS.has(part) || part.startsWith('.'))) return;
          if (ignore.some((prefix) => path.startsWith(prefix))) return;
          seen.add(path);
          clearTimeout(timer);
          timer = setTimeout(() => {
            const paths = [...seen];
            seen.clear();
            onChange(paths);
          }, debounce);
        });
      } catch (e) {
        throw new Error(`Couldn't watch ${root}: ${e.message}`);
      }
      watcher.on('error', () => {});
      return () => {
        clearTimeout(timer);
        watcher.close();
      };
    },

    /** Starts a program that stays open (an editor, the trace viewer) without waiting for it; rejects when it fails to start or fails. */
    launch: (command, { cwd } = {}) => run(command, { cwd }),

    /** ! and /run: a shell command in the folder. */
    shell: (command, { cwd, signal } = {}) => run(command, { cwd, signal }),

    /** Whether a file is there (a screenshot, a trace), for saying so before opening it. */
    exists: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },

    loadHistory: (root) => loadHistory(root, home),
    saveHistory: (root, history) => saveHistory(root, history, home),
    writeFile: (path, text) => writeFileSync(path, text),
  };
}
