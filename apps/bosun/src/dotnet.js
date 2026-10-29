// A .NET project's crew, when there's no bosun.json (or Procfile, compose file or dev script): each web
// project in the folder or the ones under it. One that an IIS site serves runs as that site ("iis");
// an ASP.NET project on .NET Framework without one runs in IIS Express, built with MSBuild first; an
// ASP.NET Core one runs with `dotnet run` and its launch profile. Pure apart from reading files, and
// asking IIS which folders its sites serve (`iisSites`) and where MSBuild is (`msbuild`).
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { appcmdPath, expandEnv, parseAppcmd } from './iis.js';

const PROJECT = /\.(cs|vb|fs)proj$/i;
const SKIP = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', 'packages', 'TestResults']);
// Visual Studio's "ASP.NET Web Application" project type.
const WEB_APP_GUID = /349c5851-65df-11da-9384-00065b846f21/i;

/** The project files in `dir` and the folders right under it: paths relative to `dir`. */
export function projectFiles(dir, { list = (d) => readdirSync(d, { withFileTypes: true }) } = {}) {
  const found = [];
  const look = (at, depth) => {
    let entries;
    try {
      entries = list(join(dir, at));
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && PROJECT.test(e.name)) found.push(at === '.' ? e.name : join(at, e.name));
      else if (depth === 0 && e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) look(at === '.' ? e.name : join(at, e.name), 1);
    }
  };
  look('.', 0);
  return found.sort();
}

/** What a project file is: 'core' (Microsoft.NET.Sdk.Web), 'framework' (an ASP.NET Web Application), or null (not a web project). */
export function projectKind(xml) {
  const text = String(xml ?? '');
  if (/<Project\b[^>]*\bSdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/i.test(text)) return 'core';
  if (WEB_APP_GUID.test(text) || /Microsoft\.WebApplication\.targets/i.test(text) || /<IISUrl>/i.test(text)) return 'framework';
  return null;
}

/** The port IIS Express serves a .NET Framework web project on: its <IISUrl>, else <DevelopmentServerPort>; null when neither says. */
export function iisExpressPort(xml) {
  const text = String(xml ?? '');
  const url = /<IISUrl>\s*([^<\s]+)\s*<\/IISUrl>/i.exec(text)?.[1];
  const fromUrl = url && /:(\d+)/.exec(url.replace(/^\w+:\/\//, 'x'))?.[1];
  return Number(fromUrl ?? /<DevelopmentServerPort>\s*(\d+)\s*</i.exec(text)?.[1]) || null;
}

/**
 * The launch profile `dotnet run` uses for an ASP.NET Core project (launchSettings.json's first
 * "Project" one): { name, port, health: null }, or null without one.
 */
export function launchProfile(json) {
  let data;
  try {
    data = JSON.parse(String(json ?? '').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  const entry = Object.entries(data?.profiles ?? {}).find(([, p]) => p?.commandName === 'Project');
  if (!entry) return null;
  const urls = String(entry[1].applicationUrl ?? '').split(';').map((u) => u.trim()).filter(Boolean);
  const url = urls.find((u) => u.startsWith('http:')) ?? urls[0];
  const port = url ? Number(/:(\d+)/.exec(url.replace(/^\w+:\/\//, 'x'))?.[1]) || null : null;
  return { name: entry[0], port };
}

/** A process name from a project's or site's: `Shop.Web` → `shop.web`, `Default Web Site` → `default-web-site`. */
export const procName = (name) => String(name).toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'web';

const samePath = (a, b, win) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
/** Whether `inner` is `outer` or inside it. */
export function within(outer, inner, win = process.platform === 'win32') {
  const rel = relative(win ? outer.toLowerCase() : outer, win ? inner.toLowerCase() : inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The build line of a .NET Framework project: MSBuild, restoring its packages (packages.config's too), quietly. */
export const msbuildLine = (msbuild, file) => `"${msbuild}" "${basename(file)}" /restore /p:RestorePackagesConfig=true /nologo /v:m`;

/**
 * A .NET Framework project published to `to` (a folder from the project's): MSBuild's file-system
 * publish, which applies its Web.<configuration>.config transform to the web.config it writes there,
 * as Visual Studio's publish does (a site serving the project's own folder runs its web.config as it is).
 */
export const msbuildPublishLine = (msbuild, file, to, configuration = 'Debug') =>
  `${msbuildLine(msbuild, file)} /p:Configuration=${configuration} /p:DeployOnBuild=true /p:WebPublishMethod=FileSystem /p:PublishUrl="${to}" /p:DeleteExistingFiles=false`;

/** Debug when the folder says so (bin\Debug\…, publish-debug), else Release. */
const configurationOf = (path) => (/(^|[\\/._-])debug([\\/._-]|$)/i.test(path) ? 'Debug' : 'Release');

/**
 * The crew of .NET web projects under `dir`, or null with none: { from, procs }. `iisSites()` gives
 * IIS's sites' root folders ([{ site, physicalPath }]), `msbuild()` MSBuild's path; both are asked
 * only when a project needs them.
 */
export function dotnetCrew(dir, { read = (f) => readFileSync(f, 'utf8'), list, iisSites = readIisSites, msbuild = findMsbuild, win = process.platform === 'win32' } = {}) {
  const files = projectFiles(dir, list ? { list } : {});
  if (!files.length) return null;
  let sites = null;
  let msbuildPath = null;
  const tool = () => (msbuildPath ??= msbuild());
  const procs = [];
  const used = new Set();
  const named = (name) => {
    let n = procName(name);
    for (let i = 2; used.has(n); i++) n = `${procName(name)}-${i}`;
    used.add(n);
    return n;
  };
  for (const file of files) {
    let xml;
    try {
      xml = read(join(dir, file));
    } catch {
      continue;
    }
    const kind = projectKind(xml);
    if (!kind) continue;
    const cwd = dirname(file) === '.' ? '.' : dirname(file).replace(/\\/g, '/');
    const folder = resolve(dir, cwd);
    const project = basename(file).replace(PROJECT, '');
    const base = { cwd, port: null, health: null, env: {}, envFile: [], after: null, restart: 'no' };
    // An IIS site serving this folder (or its publish folder, inside it) runs as that site.
    sites ??= win ? safe(iisSites) : [];
    const site = sites.find((s) => s.physicalPath && within(folder, resolve(s.physicalPath), win));
    if (site) {
      const pp = resolve(site.physicalPath);
      // Served from the project's own folder: built in place. From a folder inside it: published
      // there, Web.<configuration>.config applied (.NET Framework) or `dotnet publish` (ASP.NET Core).
      const to = relative(folder, pp);
      const build = samePath(pp, folder, win) ? (kind === 'framework' ? msbuildLine(tool(), file) : null) : kind === 'framework' ? msbuildPublishLine(tool(), file, to, configurationOf(to)) : `dotnet publish -c ${configurationOf(to)} -o "${to}"`;
      procs.push({ ...base, name: named(site.site), run: `appcmd start site "${site.site}"`, iis: { site: site.site, pool: null, build, offline: true } });
      continue;
    }
    if (kind === 'framework') {
      const port = iisExpressPort(xml) ?? 8080;
      procs.push({ ...base, name: named(project), run: `"%ProgramFiles%\\IIS Express\\iisexpress.exe" /path:"%CD%" /port:${port} /systray:false`, build: msbuildLine(tool(), file), port });
      continue;
    }
    let profile = null;
    try {
      profile = launchProfile(read(join(dir, cwd, 'Properties', 'launchSettings.json')));
    } catch {
      // No launch settings: dotnet run as it is.
    }
    procs.push({ ...base, name: named(project), run: profile ? `dotnet run --launch-profile "${profile.name}"` : 'dotnet run', port: profile?.port ?? null });
  }
  if (!procs.length) return null;
  return { from: `the .NET projects (${files.map((f) => basename(f)).join(', ')})`, procs };
}

const safe = (f) => {
  try {
    return f() ?? [];
  } catch {
    return [];
  }
};

/** IIS's sites' root folders, from appcmd (an administrator's terminal); none when it can't say. */
export function readIisSites({ run = spawnSync, env = process.env } = {}) {
  const r = run(appcmdPath(env), ['list', 'vdir'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (r.status !== 0) return [];
  return parseAppcmd(r.stdout)
    .filter((v) => /^[^/]+\/$/.test(v.name))
    .map((v) => ({ site: v.name.slice(0, -1), physicalPath: expandEnv(v.attrs.physicalPath ?? '', env) }));
}

/** MSBuild's path, from Visual Studio's vswhere; `msbuild` (the PATH's) when it can't say. */
export function findMsbuild({ run = spawnSync, env = process.env } = {}) {
  const vswhere = join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  try {
    const r = run(vswhere, ['-latest', '-prerelease', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const path = String(r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (r.status === 0 && path) return path;
  } catch {
    // No Visual Studio: the PATH's.
  }
  return 'msbuild';
}
