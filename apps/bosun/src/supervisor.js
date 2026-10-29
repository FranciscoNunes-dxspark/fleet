// Starting the crew's processes, keeping what they say, and stopping them: each runs through the shell
// in its own process group (taskkill's tree on Windows), so stopping one stops what it started too.
// Nothing here draws: App subscribes and redraws.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, watch as fsWatch } from 'node:fs';
import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { portInUse, stripAnsi } from './crew.js';
import { skipsFolder, tidy, watchMatcher, watchRoots } from './watch.js';
import { walksTree, watchTree } from './treewatch.js';
import { crewOf, envHash, stateOf } from './recorder.js';
import { troubleText } from './structured.js';
import { tunnelArgs, tunnelProblem, tunnelUrl } from './tunnel.js';
import { httpsPort, startHttpsProxy } from './https.js';
import { IisChild, iisControl } from './iis.js';
import { tailLogs } from './tail.js';
import { fromTree, sharedDebugOutput } from './dbwin.js';
import { appSettingsNote, writeAppSettings } from './appsettings.js';
import { errorPage } from './errorpage.js';
import { ServiceChild, serviceControl } from './service.js';
import { PROCDUMP_HINT, dumpEnv, dumpNote, isDumpOf, procdumpArgs, procdumpSays } from './dumps.js';
import { findOnPath } from './which.js';

// A folder that's still there: Windows reports one whose files changed as changed itself, and the files
// it holds report themselves, so it's no change of its own (one removed isn't there, and counts).
function isFolder(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export const KEEP_LINES = 3000;
const WIN = process.platform === 'win32';
// Every supervisor with processes, so cli.jsx can stop them all when Bosun exits, however it does.
const LIVE = new Set();

/** Stops every process every supervisor started, at once: for process 'exit'. */
export function killEverything() {
  for (const s of LIVE) s.killAllNow();
}

/** Stops the process tree under `pid` and waits for nothing (on exit, say). */
export function killTreeNow(pid) {
  if (!pid) return;
  try {
    if (WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, 'SIGTERM');
  } catch {
    // Gone already.
  }
}

/** Whether something listens on `port` on this machine. */
export function portOpen(port, { host = '127.0.0.1', timeout = 800 } = {}) {
  return new Promise((done) => {
    const socket = connect({ port, host });
    const finish = (open) => {
      socket.destroy();
      done(open);
    };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// The most of an error page kept, to read what it says.
const PAGE_BYTES = 256 * 1024;

/**
 * The status a page answers with, as fetch would say it ({ status, text() }), for the health checks:
 * `host` goes in the Host header (a site bound to a host name answers nothing else), and https takes
 * any certificate (IIS's own, a development one). The page's text is kept only when it's an error (5xx).
 */
export function httpStatus(url, { signal, headers = {} } = {}) {
  return new Promise((done, fail) => {
    const u = new URL(url);
    const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(u, { method: 'GET', headers, signal, rejectUnauthorized: false, servername: headers.host?.replace(/:\d+$/, '') || undefined }, (res) => {
      if (res.statusCode < 500) {
        res.resume();
        return done({ status: res.statusCode, text: async () => '' });
      }
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        if (size < PAGE_BYTES) chunks.push(d);
        size += d.length;
      });
      const finish = () => done({ status: res.statusCode, text: async () => Buffer.concat(chunks).toString('utf8') });
      res.on('end', finish);
      res.on('error', finish);
    });
    req.on('error', fail);
    req.end();
  });
}

/** Process ids nothing may stop: 0 and 4, Windows' own (System holds http.sys's ports, IIS's among them). */
export const SYSTEM_PIDS = new Set([0, 4]);

/**
 * How restarts wait: the first after `first` ms, each one after twice as long as the one before, up
 * to `max`; a process that stayed up `stable` ms starts counting again. One that ends within `quick`
 * ms of starting, `giveUpAfter` times in a row, isn't started again. Supervisor's `restartTimes`
 * changes them (the tests).
 */
export const RESTART_TIMES = { first: 1000, max: 30_000, stable: 30_000, quick: 10_000, giveUpAfter: 5 };

/**
 * What to do once a process ended by itself (never after a stop): `policy` is its `restart`, `code`
 * its exit code (null when a signal ended it), `ran` how long it was up, `state` the { attempt, quick }
 * counts so far. Returns the new counts with { restart, delay } or { gaveUp }. Pure.
 */
export function afterExit({ policy = 'no', code, ran, state = {} }, times = RESTART_TIMES) {
  const wanted = policy === 'always' || (policy === 'on-failure' && code !== 0);
  if (!wanted) return { restart: false, attempt: 0, quick: 0 };
  const attempt = ran >= times.stable ? 1 : (state.attempt ?? 0) + 1;
  const quick = ran < times.quick ? (state.quick ?? 0) + 1 : 0;
  if (quick >= times.giveUpAfter) return { restart: false, gaveUp: true, attempt, quick };
  return { restart: true, delay: Math.min(times.max, times.first * 2 ** (attempt - 1)), attempt, quick };
}

/** 4000 → "4s", 1500 → "2s": a wait as the list says it. */
export const seconds = (ms) => `${Math.max(1, Math.ceil(ms / 1000))}s`;

/**
 * The crew's processes, by name: each { name, status, pid, startedAt, endedAt, code, lines, trouble,
 * port, portOpen, health, restartAt, gaveUp }. `status` is stopped, starting, running, crashed (exited
 * with an error), exited (by itself, cleanly) or stopping. `restartAt` is when one that `restart`s
 * starts again, `gaveUp` that it ended too quickly too often to. `onChange` is called after anything
 * changes (with the process, when only its log did); `onEvent` hears { type: 'exit', p, plan } when one ended by itself (not stopped), and
 * { type: 'ready', p } the first time in a start that its port answers (and its health page is well). One with
 * `watch` is restarted when a file it names changes, `debounce` ms after the last change, from its
 * first start until it's stopped.
 */
export class Supervisor {
  constructor(procs, { dir, onChange = () => {}, onEvent = () => {}, spawnImpl = spawn, tunnelSpawn = spawn, tls = null, httpsProxy = startHttpsProxy, env = process.env, restartTimes = RESTART_TIMES, debounce = 300, watchImpl = fsWatch, treeWatch = walksTree(), recorder = null, iis = null, iisTimes = {}, tail = tailLogs, debugOutput, appSettings = writeAppSettings, services = null, fetchImpl = httpStatus, warmWait = 90_000, dumpDir = join(tmpdir(), 'bosun-dumps'), dumpEvery = 3000, procdumpSpawn = spawn, findTool = findOnPath } = {}) {
    this.dir = dir;
    // "service" processes: service.js's serviceControl (made when the first one starts; tests pass a fake).
    this.services = services;
    // The health checks' and warm-ups' requests (httpStatus; tests may pass their own), and how long a warm-up waits.
    this.fetchImpl = fetchImpl;
    this.warmWait = warmWait;
    // "dump": where dumps go (App gives the project's own, dumps.js's dumpsDir), how often it looks for
    // new ones, and ProcDump (started through `procdumpSpawn`, found with `findTool`).
    this.dumpDir = dumpDir;
    this.dumpEvery = dumpEvery;
    this.procdumpSpawn = procdumpSpawn;
    this.findTool = findTool;
    // "iis" processes: iis.js's iisControl (made when the first one starts; tests pass a fake), and
    // how often their pool and event log are looked at (`every`, `eventsEvery`).
    this.iis = iis;
    this.iisTimes = iisTimes;
    // "logs": tail.js's tailLogs (tests pass their own `every` through it).
    this.tail = tail;
    // "trace": dbwin.js's DebugOutput, Windows' only (null elsewhere); made when first wanted.
    this.debugOutput = debugOutput === undefined ? (process.platform === 'win32' ? sharedDebugOutput : null) : () => debugOutput;
    // A .NET Framework web.config's appSettings file, written from the process's settings (appsettings.js).
    this.appSettings = appSettings;
    this.debounce = debounce;
    this.watchImpl = watchImpl;
    // A folder and everything in it watched a folder at a time (treewatch.js), where Node's recursive
    // watch would watch every file: Linux.
    this.treeWatch = treeWatch;
    // A recorder.js Recorder: every line and every change of state goes to it, for /replay.
    this.recorder = recorder;
    // Called with the process when all that changed is its log (lines said, its status and trouble
    // as they were), so App needn't redraw for a log that isn't on screen.
    this.onChange = (linesOf) => {
      this.recordStates();
      onChange(linesOf);
    };
    this.onEvent = onEvent;
    this.spawnImpl = spawnImpl;
    // Starts a tunnel's tool (tunnel.js): its path, its arguments, the options. Tests pass a fake.
    this.tunnelSpawn = tunnelSpawn;
    // "https": `tls(p)` resolves the { key, cert } to serve it with (or null: said already, not served),
    // `httpsProxy` serves it (https.js's startHttpsProxy).
    this.tls = tls;
    this.httpsProxy = httpsProxy;
    this.env = env;
    this.times = restartTimes;
    this.procs = new Map();
    LIVE.add(this);
    this.setCrew(procs);
  }

  /** Stops everything and forgets this supervisor (App unmounting). */
  dispose() {
    this.killAllNow();
    LIVE.delete(this);
  }

  /** Tells the recorder about each process whose state changed since it last heard. */
  recordStates() {
    if (!this.recorder) return;
    for (const p of this.procs.values()) {
      const state = stateOf(p);
      const key = JSON.stringify(state);
      if (key === p.recorded) continue;
      // A process's first state (stopped, as the crew was read) is the session header's.
      if (p.recorded !== undefined || p.status !== 'stopped') this.recorder.state(p.name, state);
      p.recorded = key;
    }
  }

  /** Forgets a restart `p` is waiting for; returns whether there was one. */
  clearRestart(p) {
    if (!p?.restartTimer) return false;
    clearTimeout(p.restartTimer);
    p.restartTimer = null;
    p.restartAt = null;
    return true;
  }

  /** s and /stop while it waits to restart: it won't. Returns whether it was waiting. */
  cancelRestart(name) {
    const p = this.procs.get(name);
    if (!this.clearRestart(p)) return false;
    this.push(p, '── not restarting it');
    this.closeTunnel(name);
    this.onChange();
    return true;
  }

  /** A new crew (bosun.json read again, another profile): what's running keeps running until restarted. */
  setCrew(procs) {
    const next = new Map();
    for (const p of procs) {
      const had = this.procs.get(p.name);
      // What it watches changed: watched afresh (from now if it's running, else from its next start).
      if (had?.watchers && JSON.stringify([had.spec.watch, had.spec.ignore, had.spec.cwd]) !== JSON.stringify([p.watch, p.ignore, p.cwd])) {
        this.unwatch(had);
        had.spec = p;
        if (had.child) this.watch(had);
      }
      // An IIS site without a "port" keeps the one its binding said.
      next.set(p.name, had ? Object.assign(had, { spec: p, port: p.port ?? (p.iis ? had.port : null) }) : { name: p.name, spec: p, status: 'stopped', pid: null, startedAt: null, endedAt: null, code: null, lines: [], trouble: null, port: p.port, portOpen: null, health: null });
    }
    // One no longer in the crew is stopped, and one waiting to restart doesn't.
    for (const [name, had] of this.procs) {
      if (next.has(name)) continue;
      this.clearRestart(had);
      this.unwatch(had);
      if (had.child) this.stop(name);
    }
    const crewChanged = JSON.stringify(crewOf([...this.procs.values()])) !== JSON.stringify(crewOf([...next.values()]));
    this.procs = next;
    if (crewChanged && this.started) this.recorder?.procs([...next.values()]);
    this.started = true;
    this.onChange();
  }

  list() {
    return [...this.procs.values()];
  }

  get(name) {
    return this.procs.get(name);
  }

  push(p, text, err = false) {
    for (const raw of String(text).split(/\r?\n/)) {
      const line = stripAnsi(raw).replace(/\r/g, '');
      if (!line.trim()) continue;
      const entry = { at: Date.now(), text: line, err };
      p.lines.push(entry);
      this.recorder?.line(p.name, entry);
      // Bosun's own lines (── the command, ── stopped) are never the process's trouble.
      if (!p.trouble && !line.startsWith('── ')) p.trouble = troubleText(line);
    }
    if (p.lines.length > KEEP_LINES) p.lines.splice(0, p.lines.length - KEEP_LINES);
  }

  /**
   * Starts `name` (nothing if it's running). Resolves once it's started, not once it's ready. `auto`:
   * a restart after it ended by itself, which keeps counting towards giving up; any other start
   * counts from nothing again.
   */
  start(name, { auto = false } = {}) {
    const p = this.procs.get(name);
    if (!p || p.child || this.closed) return;
    this.clearRestart(p);
    if (!auto) Object.assign(p, { attempt: 0, quick: 0 });
    p.gaveUp = false;
    if (!p.watchers) this.watch(p);
    const { cwd, env, build } = p.spec;
    // An IIS site or a Windows service isn't a command Bosun runs.
    const kind = p.spec.iis ? 'iis' : p.spec.service ? 'service' : 'command';
    // "build" runs first, each start: the process starts only when it passed.
    const run = build && kind === 'command' ? `${build} && ${p.spec.run}` : p.spec.run;
    p.status = 'starting';
    p.code = null;
    p.trouble = null;
    p.tests = null;
    p.startedAt = Date.now();
    p.endedAt = null;
    this.recorder?.started?.(p.name, { env: envHash(p.spec.fileEnv) });
    // The command as bosun.json gives it (what /replay knows a start by), its build said before it.
    if (build && kind === 'command') this.push(p, `── build: ${build}`, false);
    this.push(p, `── ${p.spec.run}`, false);
    // IIS Express and the like read their settings from web.config: its appSettings file gets them.
    if (kind === 'command') this.writeSettings(p, resolve(this.dir, cwd ?? '.'));
    const dumps = p.spec.dump ? this.dumpsFolder(p) : null;
    const child =
      kind === 'iis'
        ? this.iisChild(p)
        : kind === 'service'
          ? this.serviceChild(p)
          : this.spawnImpl(run, {
          cwd: resolve(this.dir, cwd ?? '.'),
          shell: true,
          windowsHide: true,
          detached: !WIN,
          // FORCE_COLOR off: colours would be stripped anyway, and some tools write less without them.
          // The terminal's, then the env files', then bosun.json's own.
          // "dump": a .NET runtime writes its own when it crashes.
          env: { ...this.env, ...p.spec.fileEnv, ...env, ...(dumps ? dumpEnv(dumps, p.name) : {}), FORCE_COLOR: '0' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    p.child = child;
    p.pid = child.pid ?? null;
    if (dumps) this.watchDumps(p, child, dumps);
    if (p.spec.logs?.length) this.tailFor(p, child);
    if (p.spec.trace) this.traceFor(p, child);
    let buffered = { out: '', err: '' };
    const take = (which, err) => (d) => {
      buffered[which] += d;
      const cut = buffered[which].lastIndexOf('\n');
      if (cut < 0) return;
      const { status, trouble } = p;
      this.push(p, buffered[which].slice(0, cut), err);
      buffered[which] = buffered[which].slice(cut + 1);
      if (p.status === 'starting') p.status = 'running';
      this.onChange(p.status === status && p.trouble === trouble ? p : undefined);
    };
    if (httpsPort(p.spec)) this.serveHttps(p, child);
    child.stdout?.setEncoding('utf8').on('data', take('out', false));
    child.stderr?.setEncoding('utf8').on('data', take('err', true));
    child.on('spawn', () => {
      if (p.status === 'starting') p.status = 'running';
      this.onChange();
    });
    child.on('error', (e) => {
      this.push(p, `Couldn't start it: ${e.message}`, true);
      p.trouble ??= e.message;
    });
    child.on('close', (code, signal) => {
      if (buffered.out) this.push(p, buffered.out);
      if (buffered.err) this.push(p, buffered.err, true);
      buffered = { out: '', err: '' };
      const stopping = p.status === 'stopping';
      p.child = null;
      p.pid = null;
      p.tails?.close();
      p.tails = null;
      p.untrace?.();
      p.untrace = null;
      this.unwatchDumps(p);
      p.warmAbort?.abort();
      p.endedAt = Date.now();
      p.code = code;
      p.status = stopping ? 'stopped' : code === 0 ? 'exited' : 'crashed';
      this.push(p, stopping ? '── stopped' : `── exited${code != null ? ` with ${code}` : ''}${signal ? ` (${signal})` : ''}`, !stopping && code !== 0);
      p.portOpen = null;
      p.health = null;
      this.stopHttps(p);
      p.waiters?.forEach((w) => w());
      p.waiters = [];
      if (!stopping && !this.closed) this.ended(p);
      // Its tunnel goes with it, unless it's coming straight back (r, a watched file, its "restart").
      if (p.tunnel && !(stopping ? p.keepTunnel : p.restartTimer)) this.closeTunnel(p.name);
      this.onChange();
    });
    this.onChange();
  }

  /**
   * `p`'s IIS site as its child (iis.js's IisChild): its worker's pid as `p.pid`, and its binding as
   * the port (when bosun.json gives none) and the host its health page is asked for.
   */
  iisChild(p) {
    const child = new IisChild(p.spec, { control: this.iisControl(), dir: this.dir, env: this.env, spawnImpl: this.spawnImpl, settings: (folder) => this.writeSettings(p, folder), ...this.iisTimes });
    this.followPid(p, child);
    // Started: asked for at once, so the first request isn't the one that waits.
    child.once('spawn', () => this.warmUp(p, child, 'started'));
    child.on('site', ({ binding, physicalPath }) => {
      if (p.child !== child) return;
      p.site = binding ? { physicalPath, scheme: binding.scheme, host: binding.host, ip: binding.ip, port: binding.port } : { physicalPath };
      if (binding) p.port ??= binding.port;
      this.onChange();
    });
    return child;
  }

  /**
   * Writes `p`'s settings to the appSettings file the web.config in `folder` names, and says so when
   * they changed (or couldn't be written). Returns whether they changed.
   */
  writeSettings(p, folder) {
    if (!this.appSettings || !folder) return false;
    try {
      const r = this.appSettings(folder, { ...p.spec.fileEnv, ...p.spec.env });
      if (r && (r.changed || !r.written)) this.push(p, appSettingsNote(r), !r.written);
      return Boolean(r?.changed);
    } catch (e) {
      this.push(p, `── appSettings: ${e.message}`, true);
      return false;
    }
  }

  /** Hears what `p`'s process tree (an IIS site's workers) says through OutputDebugString while `child` runs. */
  traceFor(p, child) {
    const output = this.debugOutput?.();
    if (!output) return this.push(p, '── "trace" hears Windows\' debug output: there is none here', true);
    const roots = () => (p.child !== child ? [] : child.seen ? [...child.seen] : [p.pid]);
    p.untrace = output.subscribe({
      wants: (entry) => fromTree(entry, roots()),
      line: (entry) => {
        if (p.child !== child) return;
        const { status, trouble } = p;
        this.push(p, entry.text);
        this.onChange(p.status === status && p.trouble === trouble ? p : undefined);
      },
      problem: (text) => {
        if (p.child !== child) return;
        this.push(p, `── trace: ${text}`, true);
        this.onChange();
      },
    });
  }

  /** IIS through appcmd (iis.js), made when first wanted: /iis's too. */
  iisControl() {
    return (this.iis ??= iisControl({ env: this.env }));
  }

  /** `p`'s Windows service as its child (service.js's ServiceChild): its process as `p.pid`. */
  serviceChild(p) {
    this.services ??= serviceControl();
    const child = new ServiceChild(p.spec.service, { control: this.services, ...this.iisTimes });
    this.followPid(p, child);
    return child;
  }

  /** A child whose process changes (an IIS site's worker, a service's process): `p.pid`, and ProcDump on it for "dump". */
  followPid(p, child) {
    child.on('pid', (pid) => {
      if (p.child !== child) return;
      p.pid = pid;
      if (p.spec.dump) this.attachProcdump(p, pid);
      this.onChange();
    });
  }

  /**
   * Where a process's page is asked for: { url, headers, ip }, its binding's address and host name for
   * an IIS site (one bound to an address answers only there, one bound to a host name only to it).
   */
  pageUrl(p, path) {
    const site = p.site?.port === p.port ? p.site : null;
    const ip = site?.ip ?? '127.0.0.1';
    const host = p.spec.host ?? site?.host ?? null;
    const scheme = site?.scheme === 'https' ? 'https' : 'http';
    const at = ip.includes(':') ? `[${ip}]` : ip;
    return { ip, url: `${scheme}://${at}:${p.port}${path.startsWith('/') ? '' : '/'}${path}`, headers: host ? { host: `${host}:${p.port}` } : {} };
  }

  /**
   * After an IIS site starts or recycles: its health page (or /) asked for until it answers below
   * 500, and how long that took said, with a word when it's well over what it took before.
   */
  async warmUp(p, child, what) {
    if (!p.port) return;
    const { url, headers } = this.pageUrl(p, p.spec.health ?? '/');
    const from = Date.now();
    let status = null;
    // Called off when the site stops, so no request outlives it.
    p.warmAbort?.abort();
    const stop = (p.warmAbort = new AbortController());
    while (p.child === child && !stop.signal.aborted && Date.now() - from < this.warmWait) {
      try {
        status = (await this.fetchImpl(url, { signal: AbortSignal.any([stop.signal, AbortSignal.timeout(Math.max(1000, Math.min(15_000, this.warmWait - (Date.now() - from))))]), headers })).status;
        if (status < 500) break;
      } catch {
        status = null;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (p.child !== child) return;
    const ms = Date.now() - from;
    if (status == null || status >= 500) {
      this.push(p, `── not ready ${seconds(ms)} after it ${what}${status ? `: ${p.spec.health ?? '/'} answers ${status}` : ''}`, true);
      return this.onChange();
    }
    const before = [...(p.warmups ?? [])].sort((a, b) => a - b);
    const usual = before.length ? before[Math.floor(before.length / 2)] : null;
    const slow = usual != null && ms > usual * 1.5 && ms - usual > 1000;
    p.warmups = [...(p.warmups ?? []), ms].slice(-10);
    p.warm = { ms, slow };
    this.push(p, `── ready ${(ms / 1000).toFixed(1)}s after it ${what} (${p.spec.health ?? '/'} ${status})${slow ? `: slower than its usual ${(usual / 1000).toFixed(1)}s` : ''}`, slow);
    this.onChange();
  }

  /** The folder `p`'s dumps go to, made when it isn't there. */
  dumpsFolder(p) {
    try {
      mkdirSync(this.dumpDir, { recursive: true });
      return this.dumpDir;
    } catch (e) {
      this.push(p, `── no dumps: couldn't make ${this.dumpDir}: ${e.message}`, true);
      return null;
    }
  }

  /** Looks for `p`'s new dumps in `folder` while `child` runs (and once more when it ends). */
  watchDumps(p, child, folder) {
    const mine = () => {
      try {
        return readdirSync(folder).filter((f) => isDumpOf(f, p.name));
      } catch {
        return [];
      }
    };
    const seen = new Set(mine());
    const look = () => {
      for (const f of mine()) {
        if (seen.has(f)) continue;
        seen.add(f);
        const path = join(folder, f);
        let size = 0;
        try {
          size = statSync(path).size;
        } catch {}
        p.dumps = [...(p.dumps ?? []), path].slice(-5);
        this.push(p, dumpNote(path, size), true);
        this.onChange();
      }
    };
    p.dumpWatch = { look, timer: setInterval(look, this.dumpEvery), folder };
    p.dumpWatch.timer.unref?.();
  }

  unwatchDumps(p) {
    if (!p.dumpWatch) return;
    clearInterval(p.dumpWatch.timer);
    // A dump written as it crashed: a moment later, it's there.
    const { look } = p.dumpWatch;
    setTimeout(look, 1500).unref?.();
    p.dumpWatch = null;
    this.detachProcdump(p);
  }

  /** ProcDump on `pid` (an IIS worker, a service's process) for `p`'s "dump"; the one on its last process goes. */
  attachProcdump(p, pid) {
    this.detachProcdump(p);
    if (!pid || !p.dumpWatch) return;
    const tool = this.findTool('procdump64') ?? this.findTool('procdump');
    if (!tool) {
      if (!p.procdumpMissing) this.push(p, `── "dump" needs ProcDump on the PATH for ${p.spec.iis ? 'an IIS site' : 'a service'}: ${PROCDUMP_HINT}`, true);
      p.procdumpMissing = true;
      return;
    }
    let child;
    try {
      child = this.procdumpSpawn(tool, procdumpArgs(pid, p.dumpWatch.folder, p.name), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return this.push(p, `── ProcDump couldn't start: ${e.message}`, true);
    }
    p.procdump = child;
    this.push(p, `── ProcDump watches process ${pid}: a crash writes a dump`);
    let rest = '';
    const heard = (d) => {
      const lines = `${rest}${d}`.split(/\r?\n/);
      rest = lines.pop();
      for (const l of lines) if (procdumpSays(l)) this.push(p, `── procdump: ${l.trim()}`);
      this.onChange(p);
    };
    child.stdout?.setEncoding('utf8').on('data', heard);
    child.stderr?.setEncoding('utf8').on('data', heard);
    child.on('error', (e) => this.push(p, `── ProcDump couldn't start: ${e.message}`, true));
    child.on('close', () => {
      if (p.procdump === child) p.procdump = null;
    });
  }

  detachProcdump(p) {
    const child = p.procdump;
    p.procdump = null;
    if (child?.pid) killTreeNow(child.pid);
    else child?.kill?.();
  }

  /** Follows `p`'s "logs" into its log while `child` runs. */
  tailFor(p, child) {
    try {
      p.tails = this.tail(p.spec.logs, {
        cwd: resolve(this.dir, p.spec.cwd ?? '.'),
        env: { ...this.env, ...p.spec.fileEnv, ...p.spec.env },
        onLine: (text) => {
          if (p.child !== child) return;
          const { status, trouble } = p;
          this.push(p, text);
          if (p.status === 'starting') p.status = 'running';
          this.onChange(p.status === status && p.trouble === trouble ? p : undefined);
        },
      });
    } catch (e) {
      this.push(p, `── can't follow its logs: ${e.message}`, true);
    }
  }

  /**
   * Serves `p` with TLS on its "https" port while `child` runs: the certificate from `tls`, then the
   * proxy to its port. What goes wrong is said in its log; the process runs either way.
   */
  async serveHttps(p, child) {
    const port = httpsPort(p.spec);
    if (!this.tls) return;
    let creds;
    try {
      creds = await this.tls(p);
    } catch (e) {
      this.push(p, `── no https: ${e.message}`, true);
      return this.onChange();
    }
    if (!creds || p.child !== child || this.closed) return;
    let server;
    try {
      server = await this.httpsProxy({ port, target: p.port, key: creds.key, cert: creds.cert });
    } catch (e) {
      this.push(p, `── couldn't serve https on port ${port}: ${e.code === 'EADDRINUSE' ? 'something else holds it' : e.message}`, true);
      return this.onChange();
    }
    if (p.child !== child || this.closed) return server.stop();
    p.https = { port, server };
    this.push(p, `── https://localhost:${port} passes on to :${p.port}`);
    this.onChange();
  }

  /** Stops serving `p` with TLS. */
  stopHttps(p) {
    p.https?.server.stop();
    p.https = null;
  }

  /** After `p` ended by itself: started again after a wait when its `restart` says so, or given up on. */
  ended(p) {
    const plan = afterExit({ policy: p.spec.restart, code: p.code, ran: p.endedAt - p.startedAt, state: p }, this.times);
    p.attempt = plan.attempt;
    p.quick = plan.quick;
    if (plan.restart) {
      p.restartAt = Date.now() + plan.delay;
      p.restartTimer = setTimeout(() => {
        p.restartTimer = null;
        p.restartAt = null;
        this.start(p.name, { auto: true });
      }, plan.delay);
      this.push(p, `── restarting in ${seconds(plan.delay)}`);
    } else if (plan.gaveUp) {
      p.gaveUp = true;
      this.closeTunnel(p.name);
      this.push(p, `── gave up: it ended ${plan.quick} times in a row within ${seconds(this.times.quick)} of starting`, true);
    }
    this.onEvent({ type: 'exit', p, plan });
  }

  /**
   * Watches the files `p`'s `watch` names, from its folder: a change restarts it (or starts it, when it
   * ended), once nothing has changed for `debounce` ms. What can't be watched is said in its log.
   */
  watch(p) {
    const patterns = p.spec.watch ?? [];
    if (!patterns.length || this.closed) return;
    const cwd = resolve(this.dir, p.spec.cwd ?? '.');
    const wanted = watchMatcher(patterns, p.spec.ignore ?? []);
    const skip = skipsFolder(p.spec.ignore ?? []);
    p.watchers = [];
    p.changes = new Set();
    for (const { root, deep } of watchRoots(patterns)) {
      const at = resolve(cwd, root);
      let isFile = false;
      try {
        isFile = statSync(at).isFile();
      } catch {
        this.push(p, `── can't watch ${root}: it isn't there`, true);
        continue;
      }
      try {
        const prefix = root === '.' ? '' : `${root}/`;
        const heard = (name) => {
          const file = isFile ? root : name ? tidy(`${prefix}${tidy(name)}`) : null;
          if (file && wanted(file) && !isFolder(resolve(cwd, file))) this.changed(p, file);
        };
        const w =
          deep && !isFile && this.treeWatch
            ? watchTree(at, { skip: (rel) => skip(`${prefix}${rel}`), onChange: heard, watch: (path, listener) => this.watchImpl(path, {}, listener) })
            : this.watchImpl(at, { recursive: deep && !isFile }, (_, name) => heard(name));
        w.on?.('error', () => {});
        p.watchers.push(w);
      } catch (e) {
        this.push(p, `── can't watch ${root}: ${e.message}`, true);
      }
    }
  }

  /** Stops watching `p`'s files. */
  unwatch(p) {
    for (const w of p?.watchers ?? []) w.close();
    if (p) {
      p.watchers = null;
      clearTimeout(p.changeTimer);
      p.changeTimer = null;
    }
  }

  /** A file `p` watches changed: restarted once they stop changing for a moment. */
  changed(p, file) {
    p.changes.add(file);
    clearTimeout(p.changeTimer);
    p.changeTimer = setTimeout(() => {
      p.changeTimer = null;
      const files = [...p.changes];
      p.changes.clear();
      if (this.closed || !p.watchers || p.status === 'stopping') return;
      this.push(p, `── changed: ${files[0]}${files.length > 1 ? ` and ${files.length - 1} more` : ''}`);
      this.onChange();
      if (p.child) this.restart(p.name, { keepWatching: true });
      else this.start(p.name);
    }, this.debounce);
  }

  /** Stops `name` and what it started; resolves once it's gone (it's forced after `grace` ms). */
  stop(name, { grace = 3000, keepWatching = false } = {}) {
    const p = this.procs.get(name);
    if (p) p.gaveUp = false;
    if (p && !keepWatching) this.unwatch(p);
    if (!p?.child) {
      this.cancelRestart(name);
      return Promise.resolve();
    }
    p.status = 'stopping';
    this.onChange();
    const gone = new Promise((r) => (p.waiters ??= []).push(r));
    const pid = p.pid;
    // An IIS site is stopped through IIS: its worker is IIS's, not Bosun's to kill.
    if (p.child.stop) p.child.stop();
    else if (WIN) killTreeNow(pid);
    else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        p.child?.kill('SIGTERM');
      }
      const force = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Gone in time.
        }
      }, grace);
      gone.then(() => clearTimeout(force));
    }
    return gone;
  }

  async restart(name, { keepWatching = true } = {}) {
    const p = this.procs.get(name);
    // An IIS site running is recycled (built again first, with "build"), not stopped and started.
    if (p?.child?.recycle && p.status !== 'stopping') return this.recycle(p);
    if (p) p.keepTunnel = true;
    await this.stop(name, { keepWatching });
    if (p) p.keepTunnel = false;
    this.start(name);
  }

  /** Recycles `p`'s IIS site: a start of its own, as far as the list, its tests and its uptime go. */
  async recycle(p) {
    const child = p.child;
    // bosun.json read again since it started: its build and settings as they are now.
    child.spec = p.spec;
    child.iis = p.spec.iis;
    Object.assign(p, { status: 'starting', startedAt: Date.now(), trouble: null, tests: null, portOpen: null, health: null, warm: null });
    this.push(p, '── recycling');
    this.onChange();
    await child.recycle();
    if (p.child === child && p.status === 'starting') p.status = 'running';
    this.onChange();
    // In the background: r is done when the pool has recycled, not when the site answers.
    this.warmUp(p, child, 'recycled');
  }

  /**
   * Opens a tunnel to `name`'s port through `tool` (tunnel.js's; at `path`): a child of its own,
   * `p.tunnel` { tool, url, startedAt } while it runs. The address, once the tool says it, is in its
   * log and `onEvent` hears { type: 'tunnel', p, url }; { type: 'tunnel-closed', p, tool, url, asked,
   * said } when it ends (`asked`: closed on purpose, `said` its last lines). It closes with the
   * process (a stop, a crash it isn't restarted after) and with Bosun.
   */
  openTunnel(name, { tool, path }) {
    const p = this.procs.get(name);
    if (!p?.port || p.tunnel || this.closed) return false;
    const args = tunnelArgs(tool, p.port);
    let child;
    try {
      child = this.tunnelSpawn(path, args, { cwd: this.dir, windowsHide: true, detached: !WIN, stdio: ['ignore', 'pipe', 'pipe'], env: this.env });
    } catch (e) {
      this.push(p, `── the tunnel couldn't start: ${e.message}`, true);
      this.onChange();
      return false;
    }
    const t = { tool, child, pid: child.pid ?? null, url: null, startedAt: Date.now(), said: [] };
    p.tunnel = t;
    this.push(p, `── tunnel: ${tool} ${args.join(' ')}`);
    const heard = (line) => {
      if (!line.trim()) return;
      t.said = [...t.said, stripAnsi(line).trim()].slice(-8);
      const url = !t.url && tunnelUrl(tool, line);
      if (url) {
        t.url = url;
        this.push(p, `── tunnel open: ${url}`);
        this.onEvent({ type: 'tunnel', p, url });
        this.onChange();
        return;
      }
      const problem = tunnelProblem(tool, line);
      if (problem) {
        this.push(p, `── tunnel: ${problem}`, true);
        this.onChange(p);
      }
    };
    let rest = '';
    const take = (d) => {
      rest += d;
      const lines = rest.split(/\r?\n/);
      rest = lines.pop();
      lines.forEach(heard);
    };
    child.stdout?.setEncoding('utf8').on('data', take);
    child.stderr?.setEncoding('utf8').on('data', take);
    child.on('error', (e) => {
      t.said = [...t.said, e.message];
      this.push(p, `── the tunnel couldn't start: ${e.message}`, true);
    });
    child.on('close', (code) => {
      if (rest) heard(rest);
      if (p.tunnel === t) p.tunnel = null;
      this.push(p, `── tunnel closed${t.asked || code == null ? '' : ` (${tool} exited with ${code})`}`, !t.asked);
      this.onEvent({ type: 'tunnel-closed', p, tool, url: t.url, asked: Boolean(t.asked), said: t.said });
      this.onChange();
    });
    this.onChange();
    return true;
  }

  /** Closes `name`'s tunnel; returns whether it had one. */
  closeTunnel(name) {
    const t = this.procs.get(name)?.tunnel;
    if (!t || t.asked) return false;
    t.asked = true;
    if (t.pid) killTreeNow(t.pid);
    else t.child.kill?.();
    return true;
  }

  /**
   * Starts every process not running, each after the one it waits for (`after`): once that one's port
   * answers, or it has run a moment when it has no port.
   */
  async startAll({ waitMs = 20000, only = null } = {}) {
    const started = new Set();
    const order = [];
    // `only`: these names (a group), each still waiting for the one it starts after when that runs.
    const wanted = (p) => !only || only.includes(p.name);
    const visit = (p, seen = new Set()) => {
      if (started.has(p.name) || seen.has(p.name)) return;
      seen.add(p.name);
      const dep = p.spec.after && this.procs.get(p.spec.after);
      if (dep && wanted(dep)) visit(dep, seen);
      started.add(p.name);
      order.push(p);
    };
    for (const p of this.procs.values()) if (wanted(p)) visit(p);
    for (const p of order) {
      const dep = p.spec.after && this.procs.get(p.spec.after);
      if (dep) await this.ready(dep, waitMs);
      this.start(p.name);
    }
  }

  /** Waits until `p` is ready: its port answers, or it has been running a second and a half. */
  async ready(p, waitMs) {
    const end = Date.now() + waitMs;
    while (Date.now() < end && p.child) {
      if (p.port ? await portOpen(p.port) : Date.now() - p.startedAt > 1500) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  stopAll() {
    return Promise.all([...this.procs.keys()].map((n) => this.stop(n)));
  }

  /** Stops everything at once, without waiting: for when Bosun itself is exiting. Nothing restarts after. */
  killAllNow() {
    this.closed = true;
    this.recorder?.close();
    for (const p of this.procs.values()) {
      this.clearRestart(p);
      this.unwatch(p);
      if (p.child?.stopNow) p.child.stopNow();
      else if (p.pid) killTreeNow(p.pid);
      p.tails?.close();
      p.untrace?.();
      p.untrace = null;
      if (p.dumpWatch) clearInterval(p.dumpWatch.timer);
      this.detachProcdump(p);
      p.warmAbort?.abort();
      if (p.tunnel) this.closeTunnel(p.name);
      this.stopHttps(p);
    }
  }

  /** Checks each running process's port, and its health page when it has one: { open, status } on each. */
  async checkPorts({ fetchImpl = this.fetchImpl } = {}) {
    let changed = false;
    await Promise.all(
      [...this.procs.values()].map(async (p) => {
        if (!p.port || !p.child) return;
        const { ip, url, headers } = this.pageUrl(p, p.spec.health ?? '/');
        const open = await portOpen(p.port, { host: ip });
        let health = null;
        if (open && p.spec.health) {
          try {
            const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000), headers });
            health = res.status;
            // A server error: what its page says goes in the log, once a start and status.
            const key = `${p.startedAt}:${health}`;
            if (health >= 500 && p.errorPageFor !== key) {
              p.errorPageFor = key;
              const page = errorPage(await res.text?.().catch(() => ''));
              if (page) {
                this.push(p, JSON.stringify({ level: 'error', msg: `${p.spec.health} answered ${health}: ${page.headline}`, source: 'health page' }));
                for (const line of page.lines) this.push(p, `    ${line}`);
                changed = true;
              }
            }
          } catch {
            health = 0;
          }
        }
        if (open !== p.portOpen || health !== p.health) changed = true;
        p.portOpen = open;
        p.health = health;
        // Ready (its port answers, its health page is well): once a start, for its "test".
        const well = open && (!p.spec.health || (health >= 200 && health < 400));
        if (well && p.child && p.readyFor !== p.startedAt) {
          p.readyFor = p.startedAt;
          this.onEvent({ type: 'ready', p });
        }
      }),
    );
    if (changed) this.onChange();
  }

  /** c: forgets what `name` has said, and the trouble it noticed in it. */
  clearLog(name) {
    const p = this.procs.get(name);
    if (!p) return;
    p.lines = [];
    p.trouble = null;
    this.onChange();
  }

  /** The port a process's own log says is taken (EADDRINUSE), for /free. */
  takenPort(name) {
    const p = this.procs.get(name);
    for (let i = (p?.lines.length ?? 0) - 1; i >= 0; i--) {
      const port = portInUse(p.lines[i].text);
      if (port) return port;
    }
    return null;
  }
}

/**
 * The processes listening on `port` on this machine, as PIDs: lsof off Windows, netstat on it. Empty
 * when there are none, or the tool isn't there.
 */
export function pidsOnPort(port, { run = spawnSync } = {}) {
  try {
    if (WIN) {
      const out = run('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
      return [...new Set(out.split(/\r?\n/).filter((l) => new RegExp(`:${port}\\s+\\S+\\s+LISTENING`, 'i').test(l)).map((l) => Number(l.trim().split(/\s+/).pop())).filter(Boolean))];
    }
    const out = run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '';
    return [...new Set(out.split(/\s+/).map(Number).filter(Boolean))];
  } catch {
    return [];
  }
}

/** Stops the processes in `pids` (a port's holders, from /free). */
export function killPids(pids) {
  for (const pid of pids) {
    if (SYSTEM_PIDS.has(pid)) continue;
    try {
      if (WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else process.kill(pid, 'SIGTERM');
    } catch {
      // Gone already, or not ours to stop: the next look says.
    }
  }
}
