// Pre-flight: what's worth knowing before the crew starts (and /preflight any time). The checks are
// pure functions of facts gathered first (`gatherFacts`, the only part that looks at the machine,
// which App takes as a prop so tests hand it their own); a problem is said, never stops a start.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { connect } from 'node:net';
import { parseDotenv } from './dotenv.js';
import { projectAt } from '@fleet/kit/family.js';
import { run as runShell } from '@fleet/kit/run.js';
import { portOpen as portAnswers, pidsOnPort as holders } from './supervisor.js';
import { appcmdProblem, expandEnv, frameworkCovers, frameworkOfRelease, iisControl, webConfigFacts } from './iis.js';
import { findOnPath } from './which.js';

// ---------------------------------------------------------------------------------------------------
// Node versions, as .nvmrc, .node-version and engines.node give them.

/** [major, minor, patch] of `v22.3.0`, `22.3`, `22`; missing parts are null; null for what isn't one. */
export function parseVersion(text) {
  const m = /^\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(String(text ?? ''));
  if (!m) return null;
  const n = (s) => (s == null || s === 'x' || s === '*' ? null : Number(s));
  return [Number(m[1]), n(m[2]), n(m[3])];
}

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const full = (v) => v.map((x) => x ?? 0);
// The version after a partial one: 20 → 21.0.0, 20.11 → 20.12.0.
const after = ([a, b, c]) => (b == null ? [a + 1, 0, 0] : c == null ? [a, b + 1, 0] : [a, b, c + 1]);

/** The comparators of one part of a range (no ||): [[op, version]], every one of which must hold. */
function comparators(part) {
  const s = part.trim();
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
  if (hyphen) {
    const lo = parseVersion(hyphen[1]);
    const hi = parseVersion(hyphen[2]);
    if (!lo || !hi) return null;
    return [['>=', full(lo)], hi[2] == null ? ['<', after(hi)] : ['<=', hi]];
  }
  const out = [];
  for (const tok of s.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean)) {
    if (tok === '*' || tok === 'x') continue;
    const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(tok);
    const v = parseVersion(m[2]);
    if (!v) return null;
    const op = m[1] ?? '';
    const lo = full(v);
    if (op === '^') out.push(['>=', lo], ['<', v[0] > 0 || v[1] == null ? [v[0] + 1, 0, 0] : v[1] > 0 || v[2] == null ? [0, v[1] + 1, 0] : [0, 0, v[2] + 1]]);
    else if (op === '~') out.push(['>=', lo], ['<', v[1] == null ? [v[0] + 1, 0, 0] : [v[0], v[1] + 1, 0]]);
    else if (op === '>=') out.push(['>=', lo]);
    else if (op === '<') out.push(['<', lo]);
    else if (op === '>') out.push(v[2] == null ? ['>=', after(v)] : ['>', v]);
    else if (op === '<=') out.push(v[2] == null ? ['<', after(v)] : ['<=', v]);
    else if (v[2] == null) out.push(['>=', lo], ['<', after(v)]);
    else out.push(['=', v]);
  }
  return out;
}

/** Whether `version` is in `range` (npm's ranges, or .nvmrc's 20 / v20.11.1); null when the range can't be read (lts/iron, node). */
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v || v[1] == null || v[2] == null) return null;
  const parts = String(range ?? '').split('||').map(comparators);
  if (!parts.length || parts.some((p) => p == null)) return null;
  const holds = ([op, w]) => {
    const c = cmp(v, w);
    return op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0;
  };
  return parts.some((p) => p.every(holds));
}

// ---------------------------------------------------------------------------------------------------
// The checks: [{ ok, title, hint }] from the facts.

const ok = (title) => ({ ok: true, title, hint: '' });
const bad = (title, hint) => ({ ok: false, title, hint });
const list = (xs) => (xs.length <= 4 ? xs.join(', ') : `${xs.slice(0, 4).join(', ')} and ${xs.length - 4} more`);

/** Node against the version the project asks for. */
export function checkNode(node) {
  if (!node?.wanted) return [];
  const fits = satisfies(node.version, node.wanted);
  if (fits == null) return [];
  const title = `Node ${node.version.replace(/^v/, '')} (${node.source} asks for ${node.wanted})`;
  return [fits ? ok(title) : bad(title, `switch to it (nvm use, fnm use) or install it: the crew runs on the Node in your PATH`)];
}

/** Docker answering, when compose services are in the crew. */
export function checkDocker(docker) {
  if (!docker?.needed) return [];
  return [docker.ok ? ok('Docker answers') : bad("Docker doesn't answer", `start Docker Desktop (or the docker service): the compose services need it${docker.error ? ` (${docker.error})` : ''}`)];
}

/** Each process's port free (ones running are skipped: it's theirs). */
export function checkPorts(ports = []) {
  return ports.map((p) =>
    p.taken
      ? p.pids?.includes(4)
        ? bad(`${p.proc}'s port ${p.port} is taken by http.sys`, `an IIS site or IIS Express binds it (appcmd list site shows the bindings): stop that site, or give ${p.proc} another port`)
        : bad(`${p.proc}'s port ${p.port} is taken${p.pids?.length ? ` by ${p.pids.length === 1 ? `process ${p.pids[0]}` : `processes ${p.pids.join(', ')}`}` : ''}`, `/free ${p.port} (or f on ${p.proc}) stops what holds it`)
      : ok(`${p.proc}'s port ${p.port} is free`),
  );
}

/** The keys of each env file's .env.example that the file lacks. */
export function checkEnv(env = []) {
  return env.map((e) => {
    if (!e.exists) return bad(`${e.file} isn't there, and ${e.example} is`, `copy ${e.example} to ${e.file} and fill it in`);
    const missing = e.exampleKeys.filter((k) => !e.keys.includes(k));
    return missing.length ? bad(`${e.file} lacks ${list(missing)}, which ${e.example} has`, `add ${missing.length === 1 ? 'it' : 'them'} to ${e.file}`) : ok(`${e.file} has every key of ${e.example}`);
  });
}

/** The databases the project's settings name, answering. */
export function checkDatabases(databases = []) {
  return databases
    .filter((d) => d.reachable != null)
    .map((d) => {
      const where = `${d.server}:${d.port}`;
      const what = `${d.name} (${d.kind}, from ${d.source})`;
      return d.reachable ? ok(`${what} answers at ${where}`) : bad(`${what} doesn't answer at ${where}`, `start it, or check ${d.source}`);
    });
}

/** node_modules there and newer than the lock file. */
export function checkModules(m) {
  if (!m?.packageJson || !m.needed) return [];
  const install = m.tool === 'npm' ? 'npm install' : `${m.tool} install`;
  if (m.modules == null) return [bad("node_modules isn't there", install)];
  if (m.lock != null && m.lock > m.modules + 1000) return [bad(`node_modules is older than ${m.lockName}`, `${install}: the dependencies changed since they were installed`)];
  return [ok('node_modules is installed')];
}

/** IIS, for the crew's "iis" sites: Windows, an administrator, the service, each site and pool, and what its web.config needs. */
export function checkIis(iis) {
  if (!iis?.sites?.length) return [];
  if (iis.platform !== 'win32') return [bad('IIS sites run only on Windows', "open this project's crew in Bosun on the Windows machine that hosts them")];
  const out = [];
  if (iis.service === 'missing') return [bad("IIS isn't installed", 'turn on Internet Information Services in Windows Features (with ASP.NET 4.8 for a .NET Framework site)')];
  if (iis.service) out.push(iis.service === 'RUNNING' ? ok('IIS (W3SVC) is running') : bad(`IIS (W3SVC) is ${iis.service.toLowerCase().replace(/_/g, ' ')}`, 'net start w3svc, as an administrator'));
  if (iis.admin != null) out.push(iis.admin ? ok("The terminal is an administrator's (IIS needs one)") : bad("The terminal isn't an administrator's", 'IIS starts and stops sites only for an administrator: start the terminal as administrator, or run Bosun through gsudo'));
  for (const s of iis.sites) {
    if (s.error) {
      out.push(bad(`${s.proc}: couldn't read IIS site ${s.site}`, s.error));
      continue;
    }
    if (!s.exists) {
      out.push(bad(`IIS has no site "${s.site}" (${s.proc})`, 'add it in IIS Manager, or fix its "site" in bosun.json'));
      continue;
    }
    if (!s.poolExists) {
      out.push(bad(`IIS has no application pool "${s.pool}" (${s.proc})`, 'add it in IIS Manager, or fix its "pool" in bosun.json'));
      continue;
    }
    out.push(ok(`IIS site ${s.site} (pool ${s.pool}) serves ${s.physicalPath ?? 'a folder'}`));
    if (s.core) out.push(s.hostingBundle ? ok('The ASP.NET Core Hosting Bundle is installed') : bad(`The ASP.NET Core Hosting Bundle isn't installed, and ${s.site} runs through the ASP.NET Core module`, 'install the bundle for the .NET it targets (winget install Microsoft.DotNet.HostingBundle.8), then net stop was /y and net start w3svc'));
    if (s.framework) {
      if (!/^v4/.test(s.runtime ?? '')) out.push(bad(`${s.pool} loads ${s.runtime ? `.NET CLR ${s.runtime}` : 'no .NET CLR'}, and ${s.site} is ASP.NET on .NET Framework ${s.framework}`, `appcmd set apppool "${s.pool}" /managedRuntimeVersion:v4.0`));
      if (s.installed && !frameworkCovers(s.installed, s.framework)) out.push(bad(`.NET Framework ${s.installed} is installed, and ${s.site} targets ${s.framework}`, `install .NET Framework ${s.framework} (its Developer Pack too, to build)`));
      else if (s.installed) out.push(ok(`.NET Framework ${s.installed} runs ${s.site} (it targets ${s.framework})`));
    }
  }
  return out;
}

/** The tools the crew's commands name: the .NET SDK, MSBuild, IIS Express. */
export function checkTools(tools = []) {
  const hint = {
    dotnet: 'install the .NET SDK the project targets (winget install Microsoft.DotNet.SDK.8, or https://dot.net)',
    msbuild: 'install Visual Studio or its Build Tools (winget install Microsoft.VisualStudio.2022.BuildTools, with the web workload for an ASP.NET site), or run Bosun from a Developer PowerShell',
    iisexpress: 'install IIS Express (winget install Microsoft.IISExpress)',
  };
  const name = { dotnet: 'The .NET SDK (dotnet)', msbuild: 'MSBuild', iisexpress: 'IIS Express' };
  return tools.map((t) => (t.found ? ok(`${name[t.tool]} is there (${list(t.procs)})`) : bad(`${name[t.tool]} isn't there, and ${list(t.procs)} ${t.procs.length === 1 ? 'needs' : 'need'} it`, hint[t.tool])));
}

/** Every check, in the order they're shown. */
export const runChecks = (facts) => [...checkNode(facts.node), ...checkDocker(facts.docker), ...checkPorts(facts.ports), ...checkIis(facts.iis), ...checkTools(facts.tools), ...checkEnv(facts.env), ...checkDatabases(facts.databases), ...checkModules(facts.modules)];

/** One line a check: ✓ or ✗, what, and for a problem the hint after a dash. */
export const checkLine = (c) => `${c.ok ? '✓' : '✗'} ${c.title}${c.ok ? '' : ` — ${c.hint}`}`;

/** The summary: "Pre-flight: 6 checks, 2 problems". */
export function summary(checks) {
  const problems = checks.filter((c) => !c.ok).length;
  if (!checks.length) return 'Pre-flight: nothing to check here';
  return problems ? `Pre-flight: ${problems} of ${checks.length} check${checks.length === 1 ? '' : 's'} found a problem (it starts all the same)` : `Pre-flight: all ${checks.length} check${checks.length === 1 ? '' : 's'} passed`;
}

// ---------------------------------------------------------------------------------------------------
// Gathering the facts.

/** The env files the crew reads (top level, then each process's, once each), as absolute paths; the project's .env when none is named. */
export function envFilesOf(crew, dir) {
  const files = [...(crew.envFile ?? []).map((f) => resolve(dir, f)), ...(crew.procs ?? []).flatMap((p) => (p.envFile ?? []).map((f) => resolve(dir, p.cwd ?? '.', f)))];
  return files.length ? [...new Set(files)] : [resolve(dir, '.env')];
}

/** The default port of a database of `kind`. */
export const DEFAULT_PORTS = { sqlserver: 1433, postgres: 5432, mysql: 3306 };

/** Whether something answers on host:port within `timeout` ms. */
export function tcpAnswers(host, port, timeout = 2000) {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (yes) => {
      socket.destroy();
      done(yes);
    };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

const read = (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const mtime = (f) => {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return null;
  }
};

/** Whether the crew runs compose services (docker must answer). */
export const needsDocker = (crew) => /compose/i.test(crew.from ?? '') || (crew.procs ?? []).some((p) => /^\s*docker(-compose|\s+compose)\b/.test(p.run ?? ''));

/** Which of dotnet, msbuild and iisexpress the crew's commands run, and whether each is there: [{ tool, procs, found }]. */
export function toolsOf(procs, { platform = process.platform, env = process.env, exists = existsSync, which } = {}) {
  const wants = new Map();
  const want = (tool, proc) => wants.set(tool, [...(wants.get(tool) ?? []), proc]);
  for (const p of procs) {
    const lines = [p.iis ? null : p.run, p.build, p.iis?.build].filter(Boolean);
    if (lines.some((l) => /^\s*"?dotnet(\.exe)?"?\s/i.test(l))) want('dotnet', p.name);
    if (lines.some((l) => /^\s*"?msbuild(\.exe)?"?\s/i.test(l))) want('msbuild', p.name);
    if (platform === 'win32' && lines.some((l) => /iisexpress(\.exe)?"?\s/i.test(l))) want('iisexpress', p.name);
  }
  return [...wants].map(([tool, names]) => ({
    tool,
    procs: names,
    found: tool === 'iisexpress' ? exists(expandEnv('%ProgramFiles%\\IIS Express\\iisexpress.exe', env)) : Boolean(which(tool)),
  }));
}

/**
 * IIS's facts for the crew's `sites` (processes with "iis"): { platform, admin, service, sites:
 * [{ proc, site, exists, pool, poolExists, runtime, physicalPath, core, hostingBundle, framework,
 * installed }] }. `iis` is iis.js's iisControl (tests pass a fake).
 */
export async function gatherIis(sites, { platform = process.platform, run = runShell, iis = null, env = process.env, exists = existsSync, read: readText = read } = {}) {
  const facts = { platform, admin: null, service: null, sites: sites.map((p) => ({ proc: p.name, site: p.iis.site })) };
  if (platform !== 'win32') return facts;
  const out = (line) => run(line, { signal: AbortSignal.timeout(10_000) }).then((r) => r.stdout ?? '');
  const service = await out('sc query W3SVC').catch((e) => (/1060|does not exist/i.test(`${e.stdout ?? ''}${e.message}`) ? 'missing' : ''));
  facts.service = service === 'missing' ? 'missing' : (/STATE\s*:\s*\d+\s+(\w+)/.exec(service)?.[1] ?? null);
  if (facts.service === 'missing') return facts;
  facts.admin = await out('net session').then(
    () => true,
    () => false,
  );
  const release = /Release\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(await out('reg query "HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full" /v Release').catch(() => ''))?.[1];
  const installed = release ? frameworkOfRelease(Number.parseInt(release, 16)) : null;
  const control = iis ?? iisControl({ env });
  const windir = env.windir ?? env.WINDIR ?? 'C:\\Windows';
  const bundle = [join(windir, 'System32', 'inetsrv', 'aspnetcorev2.dll'), expandEnv('%ProgramFiles%\\IIS\\Asp.Net Core Module\\V2\\aspnetcorev2.dll', env)];
  for (const [i, p] of sites.entries()) {
    const s = facts.sites[i];
    try {
      const site = await control.site(p.iis.site);
      s.exists = Boolean(site);
      if (!site) continue;
      s.physicalPath = site.physicalPath;
      s.pool = p.iis.pool ?? (await control.poolOf(p.iis.site)) ?? 'DefaultAppPool';
      const pool = await control.pool(s.pool);
      s.poolExists = Boolean(pool);
      s.runtime = pool?.runtime ?? null;
      const config = site.physicalPath ? webConfigFacts(readText(join(site.physicalPath, 'web.config'))) : null;
      s.core = Boolean(config?.core);
      s.hostingBundle = s.core ? bundle.some((f) => exists(f)) : null;
      s.framework = config?.framework ?? null;
      s.installed = s.framework ? installed : null;
    } catch (e) {
      s.error = appcmdProblem(e);
    }
  }
  return facts;
}

/**
 * The facts the checks read, for the crew of the project in `dir`. `part` is 'ports' (only the ports,
 * fast: before starting), 'rest' (everything else) or 'all'. `running` names processes up already,
 * whose ports aren't checked.
 */
export async function gatherFacts(dir, crew, { part = 'all', running = [], portOpen = portAnswers, pidsOnPort = holders, run = runShell, tcp = tcpAnswers, version = process.version, platform = process.platform, iis = null, env = process.env, exists = existsSync, which = (name) => findOnPath(name, { env, platform }) } = {}) {
  const facts = {};
  if (part !== 'rest') {
    // An IIS site's port is IIS's, held for every site bound to it: not a conflict of its own.
    const procs = (crew.procs ?? []).filter((p) => p.port && !p.iis && !running.includes(p.name));
    facts.ports = await Promise.all(
      procs.map(async (p) => {
        const taken = await portOpen(p.port, { timeout: 500 });
        return { proc: p.name, port: p.port, taken, pids: taken ? pidsOnPort(p.port) : [] };
      }),
    );
  }
  if (part === 'ports') return facts;

  // Node: the first of .nvmrc, .node-version, package.json's engines.node.
  let pkg = null;
  try {
    pkg = JSON.parse(read(join(dir, 'package.json')) ?? 'null');
  } catch {}
  const nvmrc = read(join(dir, '.nvmrc'))?.trim();
  const nodeVersion = read(join(dir, '.node-version'))?.trim();
  const wanted = nvmrc ? { wanted: nvmrc, source: '.nvmrc' } : nodeVersion ? { wanted: nodeVersion, source: '.node-version' } : pkg?.engines?.node ? { wanted: pkg.engines.node, source: 'package.json engines' } : null;
  facts.node = wanted ? { version, ...wanted } : null;

  // Env files against the .env.example beside each.
  facts.env = [];
  for (const file of envFilesOf(crew, dir)) {
    const example = join(dirname(file), '.env.example');
    const exampleText = read(example);
    if (exampleText == null) continue;
    const text = read(file);
    const keys = (t) => Object.keys(parseDotenv(t ?? '').values);
    facts.env.push({ file: relative(dir, file) || file, example: relative(dir, example), exists: text != null, keys: keys(text), exampleKeys: keys(exampleText) });
  }

  // node_modules against the lock file, by the package manager that wrote it.
  const locks = [['package-lock.json', 'npm', '.package-lock.json'], ['pnpm-lock.yaml', 'pnpm', '.modules.yaml'], ['yarn.lock', 'yarn', '.yarn-integrity'], ['bun.lockb', 'bun', null]];
  const lock = locks.find(([f]) => existsSync(join(dir, f)));
  const needed = Boolean(pkg && Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length);
  const modulesDir = join(dir, 'node_modules');
  const marker = lock?.[2] ? mtime(join(modulesDir, lock[2])) : null;
  facts.modules = { packageJson: Boolean(pkg), needed, tool: lock?.[1] ?? 'npm', lockName: lock?.[0] ?? null, lock: lock ? mtime(join(dir, lock[0])) : null, modules: existsSync(modulesDir) ? (marker ?? mtime(modulesDir)) : null };

  const jobs = [];
  // IIS, for the crew's sites.
  const sites = (crew.procs ?? []).filter((p) => p.iis);
  if (sites.length) jobs.push(gatherIis(sites, { platform, run, iis, env, exists, read }).then((got) => (facts.iis = got)));
  // The tools the commands name.
  facts.tools = toolsOf(crew.procs ?? [], { platform, env, exists, which });
  // Docker, when compose services are in the crew.
  facts.docker = { needed: needsDocker(crew), ok: null };
  if (facts.docker.needed) {
    jobs.push(
      run('docker info', { signal: AbortSignal.timeout(8000) }).then(
        () => (facts.docker.ok = true),
        (e) => Object.assign(facts.docker, { ok: false, error: String(e.message ?? '').split('\n')[0].slice(0, 120) }),
      ),
    );
  }
  // The databases the project's settings name (a named instance, or a server that isn't a host, is left out).
  facts.databases = projectAt(dir).databases.map((d) => ({ name: d.name, source: d.source, kind: d.kind, server: d.server, port: d.port ?? DEFAULT_PORTS[d.kind], reachable: null }));
  for (const d of facts.databases) {
    if (/[\\()]/.test(d.server) || d.server === '.' || !d.port) continue;
    jobs.push(tcp(d.server, d.port, 2000).then((yes) => (d.reachable = yes)));
  }
  await Promise.all(jobs);
  return facts;
}
