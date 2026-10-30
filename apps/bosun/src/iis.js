// IIS sites as crew processes (bosun.json's "iis"): IIS starts the worker (w3wp.exe) itself, on the
// first request, and recycles it when it likes, so Bosun can't run one as its child. It drives the
// site and its application pool through appcmd instead, watches the pool's state and its worker, and
// reads what the site says from where IIS puts it: the ASP.NET Core module's stdout log, the W3C
// request log and the Windows event log. The parsers are pure; `iisControl` runs appcmd and
// PowerShell (injectable), and `IisChild` looks to the supervisor like a child process.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tailLogs } from './tail.js';

// ---------------------------------------------------------------------------------------------------
// bosun.json's "iis".

/**
 * bosun.json's "iis" read: "Shop" or { site, pool, build, offline, failedRequests, path, runtime } as
 * { site, pool, build, offline, failedRequests, path, runtime }, or null when it's neither. `pool` is
 * the site's own when not given; `build` runs before a start and each restart with app_offline.htm in
 * the site's folder (unless `offline` is false); `failedRequests` turns on IIS's Failed Request Tracing
 * for 5xx while it runs. `path` (the site's folder, from the process's cwd) and `runtime` (the pool's
 * .NET CLR version, "" for none) only matter to /register, which creates a site IIS doesn't have yet.
 */
export function iisSpec(v) {
  if (typeof v === 'string' && v.trim()) return { site: v.trim(), pool: null, build: null, offline: true, failedRequests: false, path: null, runtime: null };
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.site !== 'string' || !v.site.trim()) return null;
  if (v.pool != null && typeof v.pool !== 'string') return null;
  if (v.build != null && typeof v.build !== 'string') return null;
  if (v.failedRequests != null && typeof v.failedRequests !== 'boolean') return null;
  if (v.path != null && typeof v.path !== 'string') return null;
  if (v.runtime != null && typeof v.runtime !== 'string') return null;
  return { site: v.site.trim(), pool: v.pool?.trim() || null, build: v.build || null, offline: v.offline !== false, failedRequests: v.failedRequests === true, path: v.path?.trim() || null, runtime: v.runtime ?? null };
}

/** The binding /register gives a new site: `http/*:<port>:<host>` (port 80 when none). */
export const newBinding = ({ host, port }) => `http/*:${port || 80}:${host ?? ''}`;

/** The CLR version a new pool gets: none for ASP.NET Core (it runs out of process or in the module), else v4.0. */
export const poolRuntime = (spec, webConfig) => spec.runtime ?? (webConfigFacts(webConfig).core ? '' : 'v4.0');

// ---------------------------------------------------------------------------------------------------
// appcmd's output.

/**
 * appcmd's list lines, `SITE "Shop" (id:2,bindings:http/*:80:,state:Started)`, as [{ kind, name,
 * attrs }]. A binding list holds commas too, so an attribute starts only at `,word:`.
 */
export function parseAppcmd(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*(\w+)\s+"([^"]*)"\s*(?:\((.*)\))?\s*$/.exec(line);
    if (!m) continue;
    const attrs = {};
    for (const part of (m[3] ?? '').split(/,(?=[A-Za-z][\w.]*:)/)) {
      const at = part.indexOf(':');
      if (at > 0) attrs[part.slice(0, at)] = part.slice(at + 1);
    }
    out.push({ kind: m[1].toUpperCase(), name: m[2], attrs });
  }
  return out;
}

/** A site's bindings, `http/*:80:,https/*:443:shop.local`, the http and https ones: [{ scheme, ip, port, host }]. */
export function parseBindings(text) {
  const out = [];
  for (const b of String(text ?? '').split(/,(?=[a-z.]+\/)/i)) {
    const m = /^(https?)\/(.*):(\d+):(.*)$/i.exec(b.trim());
    if (m) out.push({ scheme: m[1].toLowerCase(), ip: m[2] === '*' || m[2] === '' ? null : m[2].replace(/^\[|\]$/g, ''), port: Number(m[3]), host: m[4] || null });
  }
  return out;
}

/** The binding Bosun watches and opens: plain http first (a host name's before none), else https; null with none. */
export function mainBinding(bindings) {
  const rank = (b) => (b.scheme === 'http' ? 0 : 2) + (b.host ? 0 : 1);
  return [...(bindings ?? [])].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** A site's address as a browser opens it: http://shop.local, https://localhost:4443. */
export function bindingUrl(b) {
  if (!b) return null;
  const host = b.host ?? (b.ip && !/^(0\.0\.0\.0|::)$/.test(b.ip) ? (b.ip.includes(':') ? `[${b.ip}]` : b.ip) : 'localhost');
  const usual = (b.scheme === 'http' && b.port === 80) || (b.scheme === 'https' && b.port === 443);
  return `${b.scheme}://${host}${usual ? '' : `:${b.port}`}`;
}

/** `appcmd list site "Shop" /config`: { id, name, physicalPath, logDir } of the site's root (null where it doesn't say). */
export function parseSiteConfig(xml) {
  const text = String(xml ?? '');
  const site = /<site\b([^>]*)>/i.exec(text)?.[1] ?? '';
  const attr = (s, name) => new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(s)?.[1] ?? null;
  const root = /<application\b[^>]*\bpath="\/"[^>]*>([\s\S]*?)<\/application>/i.exec(text)?.[1] ?? text;
  const vdir = /<virtualDirectory\b[^>]*\bpath="\/"[^>]*>/i.exec(root)?.[0] ?? '';
  const log = /<logFile\b[^>]*>/i.exec(text)?.[0] ?? '';
  const freb = /<traceFailedRequestsLogging\b[^>]*>/i.exec(text)?.[0] ?? '';
  const id = attr(site, 'id');
  return { id: id != null ? Number(id) : null, name: attr(site, 'name'), physicalPath: attr(vdir, 'physicalPath'), logDir: attr(log, 'directory'), freb: { enabled: /^true$/i.test(attr(freb, 'enabled') ?? ''), directory: attr(freb, 'directory') } };
}

// ---------------------------------------------------------------------------------------------------
// An application pool's settings (/iis).

/**
 * `appcmd list apppool "X" /text:*` as a flat object: `startMode`, `processModel.idleTimeout`,
 * `recycling.periodicRestart.time`… (the nesting of its [sections], under [add]).
 */
export function parsePoolSettings(text) {
  const out = {};
  const stack = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      stack.push({ indent, name: section[1] });
      continue;
    }
    const m = /^\s*([\w.]+):"(.*)"\s*$/.exec(line);
    if (!m || !stack.length) continue;
    out[[...stack.map((s) => s.name).filter((n) => n !== 'add'), m[1]].join('.')] = m[2];
  }
  return out;
}

/**
 * The pool settings /iis shows: [{ key, label, value, about, next }], `next` the value ↵ sets (the
 * one for development when it's the default, back again when it isn't), absent for one only shown.
 */
export function poolRows(s) {
  const toggle = (key, a, b) => (s[key] === a ? b : a);
  const rows = [
    { key: 'processModel.idleTimeout', label: 'Idle timeout', about: 'the worker shuts down after this long without a request, and the next one waits for it to start (00:00:00: never)', next: toggle('processModel.idleTimeout', '00:00:00', '00:20:00') },
    { key: 'startMode', label: 'Start mode', about: 'AlwaysRunning starts the worker with IIS, not on the first request', next: toggle('startMode', 'AlwaysRunning', 'OnDemand') },
    { key: 'recycling.periodicRestart.time', label: 'Recycle every', about: 'IIS recycles it on this schedule (1.05:00:00, 29 hours, by default; 00:00:00: never)', next: toggle('recycling.periodicRestart.time', '00:00:00', '1.05:00:00') },
    { key: 'failure.rapidFailProtection', label: 'Rapid-fail protection', about: 'stops the pool after 5 crashes in 5 minutes, until it is started again', next: toggle('failure.rapidFailProtection', 'false', 'true') },
    { key: 'enable32BitAppOnWin64', label: '32-bit', about: 'runs the worker as a 32-bit process (for 32-bit native DLLs)', next: toggle('enable32BitAppOnWin64', 'true', 'false') },
    { key: 'managedRuntimeVersion', label: '.NET CLR', about: 'v4.0 for .NET Framework, empty (No Managed Code) for ASP.NET Core' },
    { key: 'managedPipelineMode', label: 'Pipeline', about: 'Integrated, or Classic for old ASP.NET' },
    { key: 'processModel.identityType', label: 'Identity', about: 'the account the worker runs as: its files and databases must let it in' },
    { key: 'processModel.maxProcesses', label: 'Workers', about: 'more than 1 is a web garden: in-memory state isn\'t shared between them' },
  ];
  return rows.filter((r) => s[r.key] != null).map((r) => ({ ...r, value: s[r.key] }));
}

// ---------------------------------------------------------------------------------------------------
// Failed Request Tracing: a file per request that failed, saying which module failed it.

/**
 * A Failed Request Tracing file (fr000012.xml) as { time, url, verb, status, ms, module, notification,
 * reason, error, warnings }: the request, the module that set the error status and why, and the
 * other warnings and errors on the way (their opcodes, once each). Null for one not written out yet.
 */
export function parseFreb(xml) {
  const text = String(xml ?? '');
  const root = /<failedRequest\b([^>]*)>/i.exec(text)?.[1];
  if (!root || !/<\/failedRequest>/i.test(text)) return null;
  const attr = (s, name) => new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(s)?.[1] ?? null;
  const events = [...text.matchAll(/<Event\b[\s\S]*?<\/Event>/gi)].map(([e]) => {
    const data = Object.fromEntries([...e.matchAll(/<Data Name="([^"]+)">([\s\S]*?)<\/Data>/gi)].map((m) => [m[1], htmlish(m[2])]));
    const described = Object.fromEntries([...e.matchAll(/<freb:Description Data="([^"]+)">([\s\S]*?)<\/freb:Description>/gi)].map((m) => [m[1], htmlish(m[2])]));
    return { level: Number(/<Level>(\d+)<\/Level>/i.exec(e)?.[1] ?? 4), opcode: /<RenderingInfo[^>]*>[\s\S]*?<Opcode>([^<]*)<\/Opcode>/i.exec(e)?.[1] ?? '', time: /<TimeCreated SystemTime="([^"]+)"/i.exec(e)?.[1] ?? null, data, described };
  });
  const failed = events.filter((e) => e.opcode === 'MODULE_SET_RESPONSE_ERROR_STATUS').at(-1);
  const warnings = [...new Set(events.filter((e) => e.level <= 3 && e !== failed).map((e) => [e.opcode, e.data.ErrorMessage ?? e.data.Message ?? e.data.ExceptionMessage].filter(Boolean).join(': ')))].slice(0, 6);
  const url = attr(root, 'url');
  return {
    time: Date.parse(events[0]?.time ?? '') || null,
    url,
    path: url ? url.replace(/^\w+:\/\/[^/]+/, '') || '/' : null,
    verb: attr(root, 'verb'),
    status: attr(root, 'statusCode'),
    ms: Number(attr(root, 'timeTaken')) || 0,
    module: failed?.data.ModuleName ?? null,
    notification: failed?.described.Notification ?? null,
    reason: failed?.data.HttpReason ?? null,
    error: failed?.described.ErrorCode ?? null,
    warnings,
  };
}

const htmlish = (s) =>
  String(s)
    .replace(/&#x([0-9a-f]+);|&#(\d+);/gi, (m, hex, dec) => String.fromCodePoint(hex ? Number.parseInt(hex, 16) : Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** A failed request as a structured line's JSON. */
export const frebJson = (f, file) =>
  JSON.stringify({ time: f.time ?? undefined, level: 'error', msg: `failed request ${f.verb ?? ''} ${f.path ?? f.url ?? ''} ${f.status ?? ''}${f.ms ? ` in ${f.ms}ms` : ''}${f.module ? `: ${f.module}${f.notification ? ` (${f.notification})` : ''}` : ''}${f.reason ? ` ${f.reason}` : ''}`.replace(/\s+/g, ' ').trim(), error: f.error && !/completed successfully/i.test(f.error) ? f.error : undefined, warnings: f.warnings.length ? f.warnings : undefined, source: 'failed request tracing', file });

/** `%SystemDrive%\inetpub` with this machine's settings put in (as cmd does, any case). */
export const expandEnv = (path, env = process.env) => {
  const lower = Object.fromEntries(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return String(path ?? '').replace(/%([^%]+)%/g, (m, name) => lower[name.toLowerCase()] ?? m);
};

/** What appcmd says when the terminal isn't an administrator's. */
export const needsAdmin = (text) => /80070005|access is denied|administrator/i.test(String(text ?? ''));

/** The message for an appcmd that failed: an administrator needed, IIS not there, or what it said. */
export function appcmdProblem(e) {
  const said = String(e?.stdout || e?.message || '').trim();
  if (e?.code === 'ENOENT') return "IIS isn't installed here (no appcmd.exe): turn on Internet Information Services in Windows Features";
  if (needsAdmin(said)) return 'IIS needs an administrator: start the terminal as administrator (or run Bosun through gsudo)';
  return said.replace(/^ERROR \( (?:hresult:\w+, )?message:/i, '').replace(/\s*\)\s*$/, '') || 'appcmd failed';
}

// ---------------------------------------------------------------------------------------------------
// web.config.

/**
 * What the site's web.config says that Bosun cares about: { core (it runs through the ASP.NET Core
 * module), hostingModel, stdoutLog (enabled), stdoutFile, framework (.NET Framework's
 * targetFramework, as "4.8"), customErrors }.
 */
export function webConfigFacts(xml) {
  const text = String(xml ?? '');
  const core = /<aspNetCore\b([^>]*)>/i.exec(text)?.[1];
  const attr = (s, name) => new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(s ?? '')?.[1] ?? null;
  const framework = attr(/<compilation\b([^>]*)>/i.exec(text)?.[1], 'targetFramework') ?? attr(/<httpRuntime\b([^>]*)>/i.exec(text)?.[1], 'targetFramework');
  return {
    core: core != null,
    hostingModel: core != null ? (attr(core, 'hostingModel') ?? 'inprocess').toLowerCase() : null,
    stdoutLog: core != null && /^true$/i.test(attr(core, 'stdoutLogEnabled') ?? ''),
    stdoutFile: core != null ? (attr(core, 'stdoutLogFile') ?? '.\\logs\\stdout') : null,
    framework: core == null ? framework : null,
    customErrors: attr(/<customErrors\b([^>]*)>/i.exec(text)?.[1], 'mode'),
  };
}

/** The .NET Framework 4.x a registry `Release` number is (4.5 and later), as "4.8.1"; null below 4.5. */
export function frameworkOfRelease(release) {
  const r = Number(release);
  const known = [[533320, '4.8.1'], [528040, '4.8'], [461808, '4.7.2'], [461308, '4.7.1'], [460798, '4.7'], [394802, '4.6.2'], [394254, '4.6.1'], [393295, '4.6'], [379893, '4.5.2'], [378675, '4.5.1'], [378389, '4.5']];
  return known.find(([at]) => r >= at)?.[1] ?? null;
}

/** Whether .NET Framework `have` (4.8) is at least `want` (4.7.2). */
export const frameworkCovers = (have, want) => {
  const a = String(have).split('.').map(Number);
  const b = String(want).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

// ---------------------------------------------------------------------------------------------------
// The W3C request log and the event log, as structured lines (structured.js draws them).

/** The columns a W3C log's `#Fields:` line names, or null for another line. */
export const w3cFields = (line) => (/^#Fields:\s*/i.test(line) ? line.replace(/^#Fields:\s*/i, '').trim().split(/\s+/) : null);

const STATUS_LEVEL = (s) => (s >= 500 ? 'error' : s >= 400 ? 'warn' : 'info');

/**
 * A W3C log line under `fields` as a structured line's JSON: the time, a level from the status (5xx
 * error, 4xx warn), `GET /orders 500 812ms` and the fields worth filtering on (status, ms, ip…).
 * Null for a comment or a line that doesn't fit.
 */
export function w3cJson(fields, line) {
  if (!fields || !line || line.startsWith('#')) return null;
  const cols = line.trim().split(/\s+/);
  if (cols.length !== fields.length) return null;
  const v = Object.fromEntries(fields.map((f, i) => [f, cols[i] === '-' ? null : cols[i]]));
  const status = Number(v['sc-status']) || null;
  const ms = v['time-taken'] != null ? Number(v['time-taken']) : null;
  const path = `${v['cs-uri-stem'] ?? ''}${v['cs-uri-query'] ? `?${v['cs-uri-query']}` : ''}`;
  const sub = v['sc-substatus'] && v['sc-substatus'] !== '0' ? `.${v['sc-substatus']}` : '';
  const obj = {
    time: v.date && v.time ? `${v.date}T${v.time}Z` : undefined,
    level: STATUS_LEVEL(status ?? 0),
    msg: `${v['cs-method'] ?? ''} ${path} ${status ?? '?'}${sub}${ms != null ? ` ${ms}ms` : ''}`.trim(),
    status: status ?? undefined,
    ms: ms ?? undefined,
    ip: v['c-ip'] ?? undefined,
    win32: v['sc-win32-status'] && v['sc-win32-status'] !== '0' ? Number(v['sc-win32-status']) : undefined,
    user: v['cs-username'] ?? undefined,
    agent: v['cs(User-Agent)']?.replace(/\+/g, ' ') ?? undefined,
  };
  return JSON.stringify(obj);
}

/** The PowerShell that lists the event log's entries for IIS and ASP.NET since `since` (ms), as JSON. */
export function eventsScript(since) {
  const providers = EVENT_SOURCES.map((s) => `'${s}'`).join(',');
  const at = new Date(since).toISOString();
  return `Get-WinEvent -FilterHashtable @{LogName='Application','System'; ProviderName=${providers}; StartTime=[datetime]::Parse('${at}').ToLocalTime()} -ErrorAction SilentlyContinue | Select-Object TimeCreated,Id,Level,ProviderName,Message | ConvertTo-Json -Compress`;
}

/** Where IIS, its modules and ASP.NET say what went wrong. */
export const EVENT_SOURCES = ['IIS AspNetCore Module V2', 'IIS AspNetCore Module', 'ASP.NET 4.0.30319.0', 'ASP.NET 2.0.50727.0', 'WAS', 'W3SVC-WP', 'W3SVC', 'Application Error', '.NET Runtime'];

/** ConvertTo-Json's events (one object or a list; dates as `\/Date(ms)\/` or ISO) as [{ time, id, level, source, message }]. */
export function parseEvents(text) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  let data;
  try {
    data = JSON.parse(t);
  } catch {
    return [];
  }
  const when = (v) => {
    const ms = /Date\((\d+)/.exec(String(v))?.[1];
    return ms ? Number(ms) : Date.parse(v?.DateTime ?? v) || null;
  };
  return (Array.isArray(data) ? data : [data]).filter(Boolean).map((e) => ({ time: when(e.TimeCreated), id: e.Id, level: { 1: 'fatal', 2: 'error', 3: 'warn' }[e.Level] ?? 'info', source: e.ProviderName, message: String(e.Message ?? '').trim() }));
}

/**
 * Whether an event is this site's: it names the site's applications (/LM/W3SVC/<id>/), its pool, or
 * (a crash) a worker it had. A runtime's event about w3wp.exe that names neither counts only when
 * `pids` says nothing else could be it (the pool isn't shared).
 */
export function eventIsSite(e, { siteId, pool, pids = [], alone = false }) {
  const m = e.message;
  if (siteId != null && new RegExp(`W3SVC/${siteId}(/|\\b)`, 'i').test(m)) return true;
  if (pool && (m.includes(`'${pool}'`) || m.includes(`"${pool}"`))) return true;
  const hex = /process id:\s*0x([0-9a-f]+)/i.exec(m)?.[1];
  if (hex && pids.includes(Number.parseInt(hex, 16))) return true;
  return alone && /w3wp\.exe/i.test(m) && /^(\.NET Runtime|Application Error)$/.test(e.source);
}

/** An event as a structured line's JSON. */
export const eventJson = (e) => JSON.stringify({ time: e.time ?? undefined, level: e.level, msg: e.message, source: e.source, event: e.id });

// ---------------------------------------------------------------------------------------------------
// Running appcmd.

/** Where appcmd is. */
export const appcmdPath = (env = process.env) => join(env.windir ?? env.WINDIR ?? env.SystemRoot ?? 'C:\\Windows', 'System32', 'inetsrv', 'appcmd.exe');

const execText = (file, args, opts = {}) =>
  new Promise((done, fail) =>
    execFile(file, args, { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, ...opts }, (e, stdout, stderr) => {
      if (e) return fail(Object.assign(e, { stdout: String(stdout || stderr || '') }));
      done(String(stdout));
    }),
  );

/**
 * IIS through appcmd: `exec(args)` runs it (resolving with its output, failing with `stdout` on the
 * error), `execSync(args)` the same at once (for Bosun exiting), `powershell(script)` the event log.
 * Each method resolves with what appcmd said, read.
 */
export function iisControl({ exec, execSync, powershell, env = process.env } = {}) {
  const appcmd = appcmdPath(env);
  exec ??= (args) => execText(appcmd, args);
  execSync ??= (args) => spawnSync(appcmd, args, { windowsHide: true, stdio: 'ignore', timeout: 20_000 });
  powershell ??= (script) => execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30_000 });
  const list = async (args) => parseAppcmd(await exec(['list', ...args]));
  // An object appcmd can't find is null; anything else (an administrator needed) is thrown.
  const one = async (args) => {
    try {
      return (await list(args))[0] ?? null;
    } catch (e) {
      if (/cannot find|not found/i.test(e.stdout ?? '') && !needsAdmin(e.stdout)) return null;
      throw e;
    }
  };
  // Starting what's started (or stopping what's stopped) isn't a problem.
  const act = async (args) => {
    try {
      await exec(args);
    } catch (e) {
      if (!/already (started|stopped)|is already/i.test(e.stdout ?? '')) throw e;
    }
  };
  return {
    async site(name) {
      const s = await one(['site', name]);
      if (!s) return null;
      const config = parseSiteConfig(await exec(['list', 'site', name, '/config']).catch(() => ''));
      return { name: s.name, id: Number(s.attrs.id) || config.id, state: s.attrs.state ?? null, bindings: parseBindings(s.attrs.bindings), physicalPath: config.physicalPath ? expandEnv(config.physicalPath, env) : null, logDir: expandEnv(config.logDir ?? '%SystemDrive%\\inetpub\\logs\\LogFiles', env), freb: { enabled: config.freb.enabled, directory: expandEnv(config.freb.directory ?? '%SystemDrive%\\inetpub\\logs\\FailedReqLogFiles', env) } };
    },
    async pool(name) {
      const p = await one(['apppool', name]);
      return p && { name: p.name, state: p.attrs.state ?? null, runtime: p.attrs.MgdVersion ?? '', mode: p.attrs.MgdMode ?? null };
    },
    /** The pool of the site's root application. */
    async poolOf(site) {
      const apps = await list(['app']);
      return apps.find((a) => a.name.toLowerCase() === `${site}/`.toLowerCase())?.attrs.applicationPool ?? null;
    },
    /** Whether `pool` runs another site's applications too (stopping or recycling it reaches them). */
    async shared(pool, site) {
      const apps = await list(['app']);
      return apps.some((a) => a.attrs.applicationPool === pool && !a.name.toLowerCase().startsWith(`${site}/`.toLowerCase()));
    },
    /** The process ids of the pool's workers. */
    async workers(pool) {
      return (await list(['wp'])).filter((w) => w.attrs.applicationPool === pool).map((w) => Number(w.name)).filter(Boolean);
    },
    /** Every site's folders: [{ site, path, physicalPath }] (`appcmd list vdir`). */
    async vdirs() {
      return (await list(['vdir'])).map((v) => ({ site: v.name.split('/')[0], path: v.name.slice(v.name.indexOf('/')), physicalPath: expandEnv(v.attrs.physicalPath ?? '', env) }));
    },
    /** Adds an application pool (`runtime` the CLR version, "" for no managed code). */
    createPool: (name, runtime) => exec(['add', 'apppool', `/name:${name}`, `/managedRuntimeVersion:${runtime}`]),
    /** Adds a site on `binding` (`http/*:80:shop.local`) serving `physicalPath`, its root application in `pool`. */
    async createSite(name, physicalPath, binding, pool) {
      await exec(['add', 'site', `/name:${name}`, `/bindings:${binding}`, `/physicalPath:${physicalPath}`]);
      await exec(['set', 'app', `${name}/`, `/applicationPool:${pool}`]);
    },
    startSite: (name) => act(['start', 'site', name]),
    stopSite: (name) => act(['stop', 'site', name]),
    startPool: (name) => act(['start', 'apppool', name]),
    stopPool: (name) => act(['stop', 'apppool', name]),
    recycle: (name) => exec(['recycle', 'apppool', name]),
    /** The pool's settings, as parsePoolSettings reads them. */
    async poolSettings(name) {
      return parsePoolSettings(await exec(['list', 'apppool', name, '/text:*']));
    },
    /** Sets one of the pool's settings (`processModel.idleTimeout`, `startMode`…). */
    setPool: (name, key, value) => exec(['set', 'apppool', name, `/${key}:${value}`]),
    /** Failed Request Tracing for the site on (with a rule for 5xx on every path) or off. */
    async failedRequests(site, on) {
      if (!on) return act(['configure', 'trace', `${site}/`, '/disablesite']);
      await act(['configure', 'trace', `${site}/`, '/enablesite']);
      try {
        await exec(['configure', 'trace', `${site}/`, '/enable', '/path:*', '/statuscodes:500-599']);
      } catch (e) {
        // The rule's there from before.
        if (!/already|exists|duplicate/i.test(e.stdout ?? '')) throw e;
      }
    },
    /** Failed Request Tracing off at once: Bosun is exiting. */
    failedRequestsOffNow: (site) => execSync(['configure', 'trace', `${site}/`, '/disablesite']),
    /** Stops the site (and its pool, unless `site` only) at once: Bosun is exiting. */
    stopNow(site, pool) {
      execSync(['stop', 'site', site]);
      if (pool) execSync(['stop', 'apppool', pool]);
    },
    /** The event log's entries from IIS's sources since `since` (ms). */
    async events(since) {
      return parseEvents(await powershell(eventsScript(since)));
    },
    /** Writes the request log's buffer out (IIS keeps up to a minute of it in memory). */
    flushLogs: () => execText('netsh', ['http', 'flush', 'logbuffer']).catch(() => {}),
  };
}

// ---------------------------------------------------------------------------------------------------
// A site as a child process.

const OFFLINE = '<!doctype html><title>Building</title><p>Bosun is building this site; it is back in a moment.</p>\n';

/**
 * An IIS site, looking to the supervisor like a spawned child: `stdout` and `stderr` streams, `pid`
 * (its pool's worker, which changes: 'pid' says so), 'spawn' once the site is started, 'close' with a
 * code when it stops. `stop()` stops it, `stopNow()` at once (Bosun exiting; a site that was running
 * before Bosun is left running), `recycle()` builds again (when it has `build`) and recycles its pool.
 * 'site' says the binding (port, host, scheme) once the site has been read.
 */
export class IisChild extends EventEmitter {
  constructor(spec, { control, dir, env = process.env, spawnImpl = spawn, every = 2000, eventsEvery = 10_000, tailEvery = 1000, tail = tailLogs, now = Date.now, readFile = (f) => readFileSync(f, 'utf8'), settings = () => {} }) {
    super();
    // `settings(folder)` writes the site's appSettings file from its settings (the supervisor's writeSettings).
    Object.assign(this, { spec, iis: spec.iis, control, dir, env, spawnImpl, every, eventsEvery, tailEvery, tail, now, readFile, settings });
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = null;
    this.seen = new Set();
    this.timers = [];
    setImmediate(() => this.begin());
  }

  say(text) {
    if (!this.closed) this.stdout.write(`${text}\n`);
  }

  warn(text) {
    if (!this.closed) this.stderr.write(`${text}\n`);
  }

  async begin() {
    const { site: name } = this.iis;
    try {
      const site = await this.control.site(name);
      if (!site) throw new Error(`IIS has no site named "${name}": appcmd list site shows the ones it has`);
      this.site = site;
      this.pool = this.iis.pool ?? (await this.control.poolOf(name)) ?? 'DefaultAppPool';
      this.shared = await this.control.shared(this.pool, name).catch(() => true);
      const pool = await this.control.pool(this.pool);
      if (!pool) throw new Error(`IIS has no application pool named "${this.pool}"`);
      const binding = mainBinding(site.bindings);
      this.emit('site', { id: site.id, pool: this.pool, physicalPath: site.physicalPath, binding });
      if (this.stopping) return this.end(null);
      this.adopted = site.state === 'Started' && pool.state === 'Started';
      if (this.iis.build && !(await this.build())) return this.end(1);
      // A site already running reads its appSettings file again only when its pool recycles.
      if (this.settings(site.physicalPath) && this.adopted) await this.control.recycle(this.pool).catch(() => {});
      if (this.stopping) return this.end(null);
      if (this.adopted) this.say(`── ${name} was already running in IIS (pool ${this.pool}): Bosun leaves it running when it quits`);
      else {
        if (pool.state !== 'Started') await this.control.startPool(this.pool);
        if (site.state !== 'Started') await this.control.startSite(name);
        this.say(`── started ${name} in IIS (pool ${this.pool}${this.shared ? ', shared with other sites' : ''})${binding ? `: ${bindingUrl(binding)}` : ''}`);
      }
      this.started = this.now();
      if (this.iis.failedRequests) await this.traceFailures(site);
      // Stopped while it was starting: stopped now that there's something to stop.
      if (this.stopping) {
        this.stopping = false;
        return this.stop();
      }
      this.emit('spawn');
      this.readLogs();
      this.poll();
      this.timers.push(setInterval(() => this.poll(), this.every));
      if (this.control.events) {
        this.eventsSince = this.started - 5000;
        this.timers.push(setInterval(() => this.pollEvents(), this.eventsEvery));
      }
    } catch (e) {
      this.warn(`── ${e.stdout != null || e.code === 'ENOENT' ? appcmdProblem(e) : e.message}`);
      this.end(1);
    }
  }

  /** The site's own logs: the ASP.NET Core module's stdout log, the request log; what else to name in "logs". */
  readLogs() {
    const folder = this.site.physicalPath;
    let config = null;
    try {
      config = folder && webConfigFacts(this.readFile(join(folder, 'web.config')));
    } catch {
      // No web.config: a static site, or one not built yet.
    }
    const patterns = [];
    if (config?.core) {
      // `.\logs\stdout` names files `stdout_<time>_<pid>.log`, a new one each time the app starts.
      if (config.stdoutLog) patterns.push(`${resolve(folder, config.stdoutFile.replace(/\\/g, '/'))}*.log`);
      else this.say('── its web.config has stdoutLogEnabled="false": turn it on to see what the app writes');
    } else if (config?.framework && !this.spec.logs?.length) {
      this.say(`── an ASP.NET site on .NET Framework ${config.framework} writes nothing Bosun can hear: name its log files in "logs" (log4net, NLog, Serilog's files); the request log and the event log are here`);
    }
    if (this.site.id != null && this.site.logDir) patterns.push(join(this.site.logDir, `W3SVC${this.site.id}`, 'u_ex*.log'));
    if (!patterns.length) return;
    this.tails = this.tail(patterns, { cwd: folder ?? this.dir, env: this.env, every: this.tailEvery, onLine: (text) => this.say(text) });
  }

  /** Failed Request Tracing on for 5xx (off again when it stops, when Bosun turned it on), and its folder followed. */
  async traceFailures(site) {
    try {
      await this.control.failedRequests(this.iis.site, true);
      this.frebOn = !site.freb?.enabled;
      this.frebDir = join(site.freb?.directory ?? 'C:\\inetpub\\logs\\FailedReqLogFiles', `W3SVC${site.id}`);
      this.frebSeen = new Set(this.frebFiles());
      this.say(`── Failed Request Tracing is on for 5xx: each one's trace is read into this log (${this.frebDir})`);
    } catch (e) {
      this.warn(`── couldn't turn on Failed Request Tracing: ${appcmdProblem(e)} (it needs IIS's Tracing feature: Windows Features, Internet Information Services, World Wide Web Services, Health and Diagnostics, Tracing)`);
    }
  }

  frebFiles() {
    try {
      return readdirSync(this.frebDir).filter((f) => /^fr\d+\.xml$/i.test(f)).sort();
    } catch {
      return [];
    }
  }

  /** The traces written since the last look, into the log; one not finished yet waits for the next. */
  readFreb() {
    if (!this.frebDir) return;
    for (const file of this.frebFiles()) {
      if (this.frebSeen.has(file)) continue;
      let f = null;
      try {
        f = parseFreb(this.readFile(join(this.frebDir, file)));
      } catch {
        // Being written: the next look.
      }
      if (!f) continue;
      this.frebSeen.add(file);
      this.say(frebJson(f, file));
    }
  }

  async poll() {
    if (this.closed || this.stopping || this.polling) return;
    this.polling = true;
    try {
      this.readFreb();
      const [pool, site] = await Promise.all([this.control.pool(this.pool), this.control.site(this.iis.site)]);
      if (this.closed || this.stopping) return;
      if (!pool || pool.state === 'Stopped') {
        this.warn(`── the application pool ${this.pool} stopped by itself: rapid-fail protection, most likely (the event log's lines say why)`);
        return this.end(1);
      }
      if (!site || site.state === 'Stopped') {
        this.say(`── ${this.iis.site} was stopped outside Bosun`);
        return this.end(0);
      }
      const pids = await this.control.workers(this.pool);
      const pid = pids[0] ?? null;
      if (pid !== this.pid) {
        if (this.pid && pid) this.say(`── recycled: worker ${this.pid} → ${pid}`);
        else if (pid) this.say(`── worker started (pid ${pid})`);
        else this.say('── worker ended (idle, or recycling): the next request starts it again');
        this.pid = pid;
        if (pid) this.seen.add(pid);
        this.emit('pid', pid);
      }
    } catch (e) {
      // One look that failed (appcmd busy): the next one says.
      if (needsAdmin(e.stdout)) this.warn(`── ${appcmdProblem(e)}`);
    } finally {
      this.polling = false;
    }
  }

  async pollEvents() {
    if (this.closed || this.eventsBusy) return;
    this.eventsBusy = true;
    try {
      this.control.flushLogs?.();
      const events = await this.control.events(this.eventsSince);
      const fresh = events.filter((e) => e.time == null || e.time > this.eventsSince).sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
      for (const e of fresh) {
        if (e.time) this.eventsSince = Math.max(this.eventsSince, e.time);
        if (eventIsSite(e, { siteId: this.site?.id, pool: this.pool, pids: [...this.seen], alone: !this.shared })) this.say(eventJson(e));
      }
    } catch {
      // PowerShell couldn't say this time.
    } finally {
      this.eventsBusy = false;
    }
  }

  /** Runs `build` with app_offline.htm in the site's folder; resolves whether it passed. */
  build() {
    const folder = this.site?.physicalPath;
    const offline = this.iis.offline && folder ? join(folder, 'app_offline.htm') : null;
    // One that's there already is someone else's, and stays.
    const ours = offline && !existsSync(offline);
    if (ours) {
      try {
        writeFileSync(offline, OFFLINE);
      } catch {
        // Can't write there: build all the same.
      }
    }
    this.say(`── build: ${this.iis.build}`);
    return new Promise((done) => {
      const child = this.spawnImpl(this.iis.build, { cwd: resolve(this.dir, this.spec.cwd ?? '.'), shell: true, windowsHide: true, env: { ...this.env, ...this.spec.fileEnv, ...this.spec.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      this.building = child;
      child.stdout?.on('data', (d) => this.stdout.write(d));
      child.stderr?.on('data', (d) => this.stderr.write(d));
      const finish = (code) => {
        this.building = null;
        if (ours) rmSync(offline, { force: true });
        if (code === 0) this.say('── built');
        else this.warn(`── the build failed${code != null ? ` (exit ${code})` : ''}`);
        done(code === 0);
      };
      child.on('error', (e) => {
        this.warn(`── the build couldn't start: ${e.message}`);
        finish(1);
      });
      child.on('close', finish);
    });
  }

  /** r and a watched change: build again (with "build"), then recycle the pool. Resolves whether it built. */
  async recycle() {
    const built = this.iis.build ? await this.build() : true;
    if (this.closed || this.stopping) return built;
    if (!built) this.warn('── the site still runs what was built before');
    this.settings(this.site?.physicalPath);
    try {
      await this.control.recycle(this.pool);
      this.say(`── recycled ${this.pool}${this.shared ? ' (it runs other sites too: they restarted with it)' : ''}`);
    } catch (e) {
      this.warn(`── couldn't recycle ${this.pool}: ${appcmdProblem(e)}`);
    }
    return built;
  }

  /** s and q: stops the site, and its pool unless it runs other sites too. Closes once it has. */
  async stop() {
    if (this.closed || this.stopping) return;
    this.stopping = true;
    this.building?.kill();
    if (!this.started) return; // begin() ends it at its next step.
    try {
      if (this.frebOn) await this.control.failedRequests(this.iis.site, false);
      await this.control.stopSite(this.iis.site);
      if (!this.shared) await this.control.stopPool(this.pool);
    } catch (e) {
      this.warn(`── couldn't stop it: ${appcmdProblem(e)}`);
    }
    this.end(null);
  }

  /** Bosun exiting: stops what Bosun started, at once. */
  stopNow() {
    if (this.closed) return;
    this.building?.kill();
    // Tracing Bosun turned on goes off, even on a site it leaves running.
    if (this.frebOn) {
      try {
        this.control.failedRequestsOffNow(this.iis.site);
      } catch {
        // Exiting all the same.
      }
    }
    if (this.started && !this.adopted) {
      try {
        this.control.stopNow(this.iis.site, this.shared ? null : this.pool);
      } catch {
        // Exiting all the same.
      }
    }
    this.end(null);
  }

  end(code) {
    if (this.closed) return;
    for (const t of this.timers) clearInterval(t);
    this.tails?.close();
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.pid = null;
    // After the streams have said their last.
    setImmediate(() => this.emit('close', code, null));
  }
}
