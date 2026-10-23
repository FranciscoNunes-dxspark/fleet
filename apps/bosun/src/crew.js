// What Bosun runs: the crew, from bosun.json in the project, or worked out from package.json's dev
// script (a `concurrently` line is split into its commands). Pure apart from reading those files.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDotenv } from './dotenv.js';

export const FILE = 'bosun.json';

/** The words of a shell line, quotes taken off: `a "b c" 'd'` → ['a', 'b c', 'd']. */
export function words(line) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (const m of String(line).matchAll(re)) out.push(m[1] != null ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]));
  return out;
}

/**
 * The commands in a `concurrently` line, each with its name (from -n/--names, else 1, 2…), or null
 * when the line isn't one: `concurrently -k -n api,web "node server" "vite"`.
 */
export function splitConcurrently(line) {
  const w = words(line);
  const at = w.findIndex((x) => /(^|\/)concurrently$/.test(x));
  if (at < 0) return null;
  const commands = [];
  let names = [];
  for (let i = at + 1; i < w.length; i++) {
    const x = w[i];
    if (x === '-n' || x === '--names') names = (w[++i] ?? '').split(',');
    else if (/^--names=/.test(x)) names = x.slice(8).split(',');
    else if (/^-(c|p|s|t|r|--prefix-colors|--prefix|--success|--timestamp-format|--restart-tries)$/.test(x)) i++;
    else if (x.startsWith('-')) continue;
    else commands.push(x);
  }
  if (!commands.length) return null;
  return commands.map((run, i) => ({ name: names[i]?.trim() || String(i + 1), run }));
}

const NAME = /^[\w.-]+$/;

/** An `envFile` as a list: a string is one file; null when it's neither (a problem to say). */
const fileList = (v) => (v == null ? [] : typeof v === 'string' ? [v] : Array.isArray(v) && v.every((f) => typeof f === 'string') ? v : null);

/** What `restart` can say: never, when it exits with an error, or whenever it ends by itself. */
export const RESTART = ['no', 'on-failure', 'always'];

/**
 * bosun.json's crew checked: { procs: [{ name, run, cwd, port, health, env, envFile, watch, ignore, after, restart }],
 * envFile, profiles, problems }. `envFile`s are lists of paths: the top level's from the project's
 * folder, a process's from its `cwd`.
 * What's wrong with an entry is said in `problems` and the entry is left out.
 */
export function readSpec(spec) {
  const problems = [];
  const procs = [];
  for (const [name, p] of Object.entries(spec?.procs ?? {})) {
    const proc = typeof p === 'string' ? { run: p } : p;
    if (!NAME.test(name)) problems.push(`"${name}": a name is letters, digits, dots, dashes and underscores`);
    else if (!proc?.run || typeof proc.run !== 'string') problems.push(`"${name}": it needs "run", the command to start it`);
    else if (proc.port != null && !(Number.isInteger(proc.port) && proc.port > 0 && proc.port < 65536)) problems.push(`"${name}": "port" is a number from 1 to 65535`);
    else if (proc.restart != null && !RESTART.includes(proc.restart)) problems.push(`"${name}": "restart" is ${RESTART.map((r) => `"${r}"`).join(', ')}`);
    else if (!fileList(proc.envFile)) problems.push(`"${name}": "envFile" is a file's path, or a list of them`);
    else if (!fileList(proc.watch) || !fileList(proc.ignore)) problems.push(`"${name}": "watch" and "ignore" are a path or glob, or a list of them`);
    else procs.push({ name, run: proc.run, cwd: proc.cwd ?? '.', port: proc.port ?? null, health: proc.health ?? null, env: proc.env ?? {}, envFile: fileList(proc.envFile), watch: fileList(proc.watch), ignore: fileList(proc.ignore), after: proc.after ?? null, restart: proc.restart ?? 'no' });
  }
  let envFile = fileList(spec?.envFile);
  if (!envFile) {
    problems.push('"envFile" is a file\'s path, or a list of them');
    envFile = [];
  }
  for (const p of procs) {
    if (p.after && !procs.some((q) => q.name === p.after)) {
      problems.push(`"${p.name}": it starts after "${p.after}", which isn't one of them`);
      p.after = null;
    }
  }
  const profiles = spec?.profiles && typeof spec.profiles === 'object' ? spec.profiles : {};
  return { procs, envFile, profiles, problems };
}

/**
 * The crew's env files read: each process gets `fileEnv`, the settings of the top level's files then
 * its own, in order (a later file wins, and ${VAR} reads the ones before and then `env`). A file that
 * can't be read, or a line that can't, is said in `problems`.
 */
export function readEnvFiles(crew, dir, { env = process.env, read = (f) => readFileSync(f, 'utf8') } = {}) {
  const problems = [];
  const cache = new Map();
  const load = (file, shown, before) => {
    const key = `${file}\n${JSON.stringify(before)}`;
    if (!cache.has(key)) {
      let text;
      try {
        text = read(file);
      } catch (e) {
        problems.push(`${shown}: ${e.code === 'ENOENT' ? "it isn't there" : e.message}`);
        cache.set(key, {});
        return {};
      }
      const parsed = parseDotenv(text, { ...env, ...before });
      problems.push(...parsed.problems.map((p) => `${shown}, ${p}`));
      cache.set(key, parsed.values);
    }
    return cache.get(key);
  };
  let shared = {};
  for (const f of crew.envFile ?? []) shared = { ...shared, ...load(resolve(dir, f), f, shared) };
  const procs = crew.procs.map((p) => {
    let fileEnv = shared;
    for (const f of p.envFile ?? []) fileEnv = { ...fileEnv, ...load(resolve(dir, p.cwd ?? '.', f), `${p.name}'s ${f}`, fileEnv) };
    return { ...p, fileEnv };
  });
  return { ...crew, procs, problems: [...crew.problems, ...[...new Set(problems)].map((p) => `env file ${p}`)] };
}

/**
 * The crew of the project in `dir`: { dir, file (bosun.json, or null), from, procs, profiles, problems }.
 * Without bosun.json, package.json's dev script: split when it's a concurrently line, else run whole
 * (and no .env read: npm doesn't, and the tools it runs read their own). `env` is what ${VAR} in an
 * env file falls back to.
 */
export function loadCrew(dir, { env = process.env } = {}) {
  const file = join(dir, FILE);
  if (existsSync(file)) {
    let spec;
    try {
      spec = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`${FILE} isn't valid JSON: ${e.message}`);
    }
    return readEnvFiles({ dir, file, from: FILE, ...readSpec(spec) }, dir, { env });
  }
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    // No package.json either: said below.
  }
  const dev = pkg?.scripts?.dev ?? pkg?.scripts?.start;
  if (!dev) return { dir, file: null, from: null, procs: [], profiles: {}, problems: [] };
  const script = pkg.scripts.dev ? 'dev' : 'start';
  const split = splitConcurrently(dev);
  const procs = (split ?? [{ name: script, run: `npm run ${script}` }]).map((p) => ({ cwd: '.', port: null, health: null, env: {}, after: null, restart: 'no', ...p }));
  // Other scripts that run the same with a twist (dev:mock) become profiles, when they split the same way.
  const profiles = {};
  for (const [name, line] of Object.entries(pkg.scripts)) {
    if (!name.startsWith(`${script}:`)) continue;
    const other = splitConcurrently(line);
    if (other && split && other.length === split.length) profiles[name.slice(script.length + 1)] = Object.fromEntries(other.map((p, i) => [split[i].name, { run: p.run }]));
  }
  return { dir, file: null, from: `package.json's ${script} script`, procs, profiles, problems: [] };
}

/**
 * The crew with profile `name` applied: a profile's entry changes `run`, adds `args` to it, merges
 * `env`, and can change `restart` (a value that isn't one of RESTART is passed over).
 */
export function withProfile(procs, profiles, name) {
  const profile = name ? profiles[name] : null;
  if (!profile) return procs;
  return procs.map((p) => {
    const change = profile[p.name];
    if (!change) return p;
    return { ...p, run: `${change.run ?? p.run}${change.args ? ` ${change.args}` : ''}`, env: { ...p.env, ...change.env }, ...(RESTART.includes(change.restart) ? { restart: change.restart } : {}) };
  });
}

/** bosun.json for a crew, to start one from what was worked out (/init). */
export function specFor(crew) {
  const procs = Object.fromEntries(crew.procs.map((p) => [p.name, Object.fromEntries(Object.entries({ run: p.run, cwd: p.cwd !== '.' ? p.cwd : undefined, port: p.port ?? undefined, health: p.health ?? undefined, envFile: p.envFile?.length ? (p.envFile.length === 1 ? p.envFile[0] : p.envFile) : undefined, watch: p.watch?.length ? p.watch : undefined, ignore: p.ignore?.length ? p.ignore : undefined, after: p.after ?? undefined, restart: p.restart && p.restart !== 'no' ? p.restart : undefined }).filter(([, v]) => v !== undefined))]));
  const envFile = crew.envFile?.length ? { envFile: crew.envFile.length === 1 ? crew.envFile[0] : crew.envFile } : {};
  return { ...envFile, procs, ...(Object.keys(crew.profiles).length ? { profiles: crew.profiles } : {}) };
}

/** Writes bosun.json in `dir` unless there's one already; returns whether it did. */
export function writeSpec(dir, spec) {
  const file = join(dir, FILE);
  if (existsSync(file)) return false;
  writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
  return true;
}

// ANSI colour and cursor codes, which a log pane can't draw (and would throw its widths off).
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** `text` without its terminal escape codes. */
export const stripAnsi = (text) => String(text).replace(ANSI, '');

/** Whether a log line reads as trouble: an error, an exception, a port already taken. */
export const isTrouble = (line) => /\b(EADDRINUSE|ECONNREFUSED|Unhandled|Uncaught|[A-Z]\w*Error|Exception|FATAL|panic)\b|^\s*Error\b|\berror:/i.test(line) && !/\b0 errors?\b|no errors?/i.test(line);

/** The port in an "address already in use" line, if it is one. */
export const portInUse = (line) => Number(/EADDRINUSE[^\d]*(?:[\d.:]*:)?(\d{2,5})/.exec(line)?.[1] ?? /address already in use[^\d]*(\d{2,5})/i.exec(line)?.[1]) || null;
