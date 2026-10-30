// What Bosun runs: the crew, from bosun.json in the project, or worked out from package.json's dev
// script (a `concurrently` line is split into its commands). Pure apart from reading those files.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDotenv } from './dotenv.js';
import { parseYaml } from './yaml.js';
import { testSpec } from './hailcheck.js';
import { TUNNEL_TOOLS } from './tunnel.js';
import { httpsProblem } from './https.js';
import { iisSpec } from './iis.js';
import { serviceSpec } from './service.js';
import { dotnetCrew } from './dotnet.js';

const tunnelProblem = (where, v) => (v != null && !TUNNEL_TOOLS.includes(v) ? `${where}"tunnel" is ${TUNNEL_TOOLS.map((t) => `"${t}"`).join(' or ')}` : null);

export const FILE = 'bosun.json';
export const PROCFILE = 'Procfile';
// The names `docker compose` looks for, in its order.
export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
// The first port a Procfile's processes get, as foreman and honcho give them: 5000, 5100, 5200…
export const PROCFILE_PORT = 5000;

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
    const iis = proc?.iis != null ? iisSpec(proc.iis) : null;
    const service = proc?.service != null ? serviceSpec(proc.service) : null;
    if (!NAME.test(name)) problems.push(`"${name}": a name is letters, digits, dots, dashes and underscores`);
    else if (proc?.service != null && !service) problems.push(`"${name}": "service" is a Windows service's name, as sc query shows it ("MSSQL$SQLEXPRESS")`);
    else if (service && (proc.run != null || proc.iis != null || proc.build != null)) problems.push(`"${name}": it has "service" and "${proc.run != null ? 'run' : proc.iis != null ? 'iis' : 'build'}": Windows runs the service, so it has no command of its own`);
    else if (proc.dump != null && typeof proc.dump !== 'boolean') problems.push(`"${name}": "dump" is true or false`);
    else if (proc?.iis != null && !iis) problems.push(`"${name}": "iis" is a site's name, or { "site": "Shop", "pool": "ShopPool", "build": "msbuild", "failedRequests": true, "path": "src/Shop", "runtime": "v4.0" }`);
    else if (iis && proc.run != null) problems.push(`"${name}": it has "iis" and "run": IIS runs the site, so it has no command of its own`);
    else if (!iis && !service && (!proc?.run || typeof proc.run !== 'string')) problems.push(`"${name}": it needs "run", the command to start it (or "iis", an IIS site, or "service", a Windows service)`);
    else if (proc.build != null && (typeof proc.build !== 'string' || iis)) problems.push(iis ? `"${name}": an IIS site's "build" goes in "iis" ({ "site": "${iis.site}", "build": "…" })` : `"${name}": "build" is a command`);
    else if (proc.host != null && (typeof proc.host !== 'string' || !/^[\w.-]+$/.test(proc.host))) problems.push(`"${name}": "host" is a host name, as "shop.local"`);
    else if (!fileList(proc.logs)) problems.push(`"${name}": "logs" is a log file's path or glob, or a list of them`);
    else if (proc.trace != null && typeof proc.trace !== 'boolean') problems.push(`"${name}": "trace" is true or false`);
    else if (proc.port != null && !(Number.isInteger(proc.port) && proc.port > 0 && proc.port < 65536)) problems.push(`"${name}": "port" is a number from 1 to 65535`);
    else if (proc.restart != null && !RESTART.includes(proc.restart)) problems.push(`"${name}": "restart" is ${RESTART.map((r) => `"${r}"`).join(', ')}`);
    else if (!fileList(proc.envFile)) problems.push(`"${name}": "envFile" is a file's path, or a list of them`);
    else if (!fileList(proc.watch) || !fileList(proc.ignore)) problems.push(`"${name}": "watch" and "ignore" are a path or glob, or a list of them`);
    else if (proc.test != null && !testSpec(proc.test)) problems.push(`"${name}": "test" is an .http file, or { "file": "api.http", "env": "dev" }`);
    else if (proc.test != null && proc.port == null) problems.push(`"${name}": "test" runs once its port answers, so it needs "port"`);
    else if (proc.group != null && (typeof proc.group !== 'string' || !NAME.test(proc.group))) problems.push(`"${name}": "group" is a name: letters, digits, dots, dashes and underscores`);
    else if (httpsProblem(proc)) problems.push(`"${name}": ${httpsProblem(proc)}`);
    else if (tunnelProblem('', proc.tunnel)) problems.push(`"${name}": ${tunnelProblem('', proc.tunnel)}`);
    else procs.push({ name, run: iis ? `appcmd start site "${iis.site}"` : service ? `sc start "${service}"` : proc.run, iis, service, dump: proc.dump === true, build: proc.build ?? null, host: proc.host ?? null, logs: fileList(proc.logs), trace: proc.trace === true, cwd: proc.cwd ?? '.', port: proc.port ?? null, health: proc.health ?? null, env: proc.env ?? {}, envFile: fileList(proc.envFile), watch: fileList(proc.watch), ignore: fileList(proc.ignore), after: proc.after ?? null, restart: proc.restart ?? 'no', test: proc.test != null ? testSpec(proc.test) : null, tunnel: proc.tunnel ?? null, https: proc.https || null, group: proc.group ?? null });
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
  let tunnel = spec?.tunnel ?? null;
  if (tunnelProblem('', tunnel)) {
    problems.push(tunnelProblem('', tunnel));
    tunnel = null;
  }
  return { procs, envFile, profiles, problems, tunnel };
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

/** The processes in a Procfile's `text`: each `name: command` line, in order (comments and blank lines skipped). */
export function parseProcfile(text) {
  const procs = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([\w.-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) procs.push({ name: m[1], run: m[2] });
  }
  return procs;
}

/**
 * A Procfile's crew, as foreman runs one: each process gets PORT (from `base`, 100 apart), and the
 * ones whose command uses $PORT are watched on it.
 */
export function procfileProcs(list, base = PROCFILE_PORT) {
  return list.map((p, i) => {
    const port = base + 100 * i;
    const uses = /\$\{?PORT\b|%PORT%/.test(p.run);
    return { name: p.name, run: p.run, cwd: '.', port: uses ? port : null, health: null, env: { PORT: String(port) }, envFile: [], after: null, restart: 'no' };
  });
}

/** The host port of a compose `ports:` entry ("8080:80", "127.0.0.1:8080:80/tcp", { published: 8080 }), or null for one with none. */
export function hostPort(entry) {
  if (entry && typeof entry === 'object') return Number.parseInt(entry.published, 10) || null;
  if (typeof entry !== 'string') return null;
  const parts = entry.replace(/\/\w+$/, '').split(':');
  if (parts.length < 2) return null;
  return Number.parseInt(parts.at(-2), 10) || null;
}

/**
 * A compose file's services as processes, each `docker compose up --no-deps <service>` (its
 * depends_on is Bosun's `after`, so it waits for the first one of them), on its first published port.
 */
export function composeProcs(doc) {
  const services = doc?.services && typeof doc.services === 'object' ? doc.services : {};
  const names = Object.keys(services).filter((n) => NAME.test(n));
  return names.map((name) => {
    const svc = services[name] ?? {};
    const deps = Array.isArray(svc.depends_on) ? svc.depends_on : Object.keys(svc.depends_on ?? {});
    const port = (Array.isArray(svc.ports) ? svc.ports : []).map(hostPort).find(Boolean) ?? null;
    return { name, run: `docker compose up --no-deps ${name}`, cwd: '.', port, health: null, env: {}, envFile: [], after: deps.find((d) => names.includes(d) && d !== name) ?? null, restart: 'no' };
  });
}

/**
 * The crew of the project in `dir`: { dir, file (bosun.json, or null), from, procs, envFile, profiles,
 * problems }. The first of: bosun.json; a Procfile (with the project's .env, as foreman reads it); a
 * compose file, a process per service; package.json's dev script, split when it's a concurrently
 * line, else run whole (and no .env read: npm doesn't, and the tools it runs read their own). `env`
 * is what ${VAR} in an env file falls back to.
 */
export function loadCrew(dir, { env = process.env, dotnet = {} } = {}) {
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
  const none = { dir, file: null, envFile: [], profiles: {}, problems: [] };
  if (existsSync(join(dir, PROCFILE))) {
    const list = parseProcfile(readFileSync(join(dir, PROCFILE), 'utf8'));
    const envFile = existsSync(join(dir, '.env')) ? ['.env'] : [];
    const withEnv = readEnvFiles({ ...none, from: PROCFILE, envFile, procs: list.map((p) => ({ ...p, cwd: '.' })) }, dir, { env });
    const base = Number.parseInt(withEnv.procs[0]?.fileEnv?.PORT ?? env.PORT, 10) || PROCFILE_PORT;
    const fileEnv = withEnv.procs[0]?.fileEnv ?? {};
    return { ...withEnv, procs: procfileProcs(list, base).map((p) => ({ ...p, fileEnv })) };
  }
  const compose = COMPOSE_FILES.find((f) => existsSync(join(dir, f)));
  if (compose) {
    let doc;
    try {
      doc = parseYaml(readFileSync(join(dir, compose), 'utf8'));
    } catch (e) {
      throw new Error(`${compose} couldn't be read: ${e.message}`);
    }
    return { ...none, from: compose, procs: composeProcs(doc) };
  }
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    // No package.json either: said below.
  }
  const dev = pkg?.scripts?.dev ?? pkg?.scripts?.start;
  // .NET web projects (dotnet.js): on their own, or beside the dev script (a front end of their own).
  const net = dotnetCrew(dir, dotnet);
  if (!dev) return net ? { ...none, ...net } : { ...none, from: null, procs: [] };
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
  if (net) return { ...none, from: `package.json's ${script} script and ${net.from}`, procs: [...procs, ...net.procs.filter((p) => !procs.some((q) => q.name === p.name))], profiles };
  return { ...none, from: `package.json's ${script} script`, procs, profiles };
}

/**
 * The crew with profile `name` applied: a profile's entry changes `run`, adds `args` to it, merges
 * `env`, and can change `restart` (a value that isn't one of RESTART is passed over) and `group`
 * (null takes it out of its group).
 */
export function withProfile(procs, profiles, name) {
  const profile = name ? profiles[name] : null;
  if (!profile) return procs;
  return procs.map((p) => {
    const change = profile[p.name];
    if (!change) return p;
    const group = change.group === null || (typeof change.group === 'string' && NAME.test(change.group)) ? { group: change.group } : {};
    return { ...p, run: `${change.run ?? p.run}${change.args ? ` ${change.args}` : ''}`, env: { ...p.env, ...change.env }, ...(RESTART.includes(change.restart) ? { restart: change.restart } : {}), ...group };
  });
}

/** bosun.json for a crew, to start one from what was worked out (/init). */
export function specFor(crew) {
  const procs = Object.fromEntries(crew.procs.map((p) => [p.name, Object.fromEntries(Object.entries({ run: p.iis || p.service ? undefined : p.run, iis: p.iis ? iisSpecOut(p.iis) : undefined, service: p.service ?? undefined, dump: p.dump ? true : undefined, build: p.build ?? undefined, cwd: p.cwd !== '.' ? p.cwd : undefined, port: p.port ?? undefined, health: p.health ?? undefined, env: Object.keys(p.env ?? {}).length ? p.env : undefined, envFile: p.envFile?.length ? (p.envFile.length === 1 ? p.envFile[0] : p.envFile) : undefined, watch: p.watch?.length ? p.watch : undefined, ignore: p.ignore?.length ? p.ignore : undefined, after: p.after ?? undefined, restart: p.restart && p.restart !== 'no' ? p.restart : undefined, test: p.test ? (p.test.env ? p.test : p.test.file) : undefined, tunnel: p.tunnel ?? undefined, https: p.https ?? undefined, group: p.group ?? undefined, host: p.host ?? undefined, trace: p.trace ? true : undefined, logs: p.logs?.length ? (p.logs.length === 1 ? p.logs[0] : p.logs) : undefined }).filter(([, v]) => v !== undefined))]));
  const envFile = crew.envFile?.length ? { envFile: crew.envFile.length === 1 ? crew.envFile[0] : crew.envFile } : {};
  return { ...envFile, ...(crew.tunnel ? { tunnel: crew.tunnel } : {}), procs, ...(Object.keys(crew.profiles).length ? { profiles: crew.profiles } : {}) };
}

/** An "iis" as bosun.json writes it: the site's name alone when that's all there is. */
const iisSpecOut = (iis) => (iis.pool || iis.build || iis.offline === false || iis.failedRequests || iis.path || iis.runtime != null ? Object.fromEntries(Object.entries({ site: iis.site, pool: iis.pool ?? undefined, build: iis.build ?? undefined, offline: iis.offline === false ? false : undefined, failedRequests: iis.failedRequests || undefined, path: iis.path ?? undefined, runtime: iis.runtime ?? undefined }).filter(([, v]) => v !== undefined)) : iis.site);

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
