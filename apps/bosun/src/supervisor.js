// Starting the crew's processes, keeping what they say, and stopping them: each runs through the shell
// in its own process group (taskkill's tree on Windows), so stopping one stops what it started too.
// Nothing here draws: App subscribes and redraws.
import { spawn, spawnSync } from 'node:child_process';
import { statSync, watch as fsWatch } from 'node:fs';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { portInUse, stripAnsi } from './crew.js';
import { skipsFolder, tidy, watchMatcher, watchRoots } from './watch.js';
import { walksTree, watchTree } from './treewatch.js';
import { crewOf, stateOf } from './recorder.js';
import { troubleText } from './structured.js';

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
  constructor(procs, { dir, onChange = () => {}, onEvent = () => {}, spawnImpl = spawn, env = process.env, restartTimes = RESTART_TIMES, debounce = 300, watchImpl = fsWatch, treeWatch = walksTree(), recorder = null } = {}) {
    this.dir = dir;
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
      next.set(p.name, had ? Object.assign(had, { spec: p, port: p.port }) : { name: p.name, spec: p, status: 'stopped', pid: null, startedAt: null, endedAt: null, code: null, lines: [], trouble: null, port: p.port, portOpen: null, health: null });
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
    const { run, cwd, env } = p.spec;
    p.status = 'starting';
    p.code = null;
    p.trouble = null;
    p.tests = null;
    p.startedAt = Date.now();
    p.endedAt = null;
    this.push(p, `── ${run}`, false);
    const child = this.spawnImpl(run, {
      cwd: resolve(this.dir, cwd ?? '.'),
      shell: true,
      windowsHide: true,
      detached: !WIN,
      // FORCE_COLOR off: colours would be stripped anyway, and some tools write less without them.
      // The terminal's, then the env files', then bosun.json's own.
      env: { ...this.env, ...p.spec.fileEnv, ...env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.child = child;
    p.pid = child.pid ?? null;
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
      p.endedAt = Date.now();
      p.code = code;
      p.status = stopping ? 'stopped' : code === 0 ? 'exited' : 'crashed';
      this.push(p, stopping ? '── stopped' : `── exited${code != null ? ` with ${code}` : ''}${signal ? ` (${signal})` : ''}`, !stopping && code !== 0);
      p.portOpen = null;
      p.health = null;
      p.waiters?.forEach((w) => w());
      p.waiters = [];
      if (!stopping && !this.closed) this.ended(p);
      this.onChange();
    });
    this.onChange();
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
    if (WIN) killTreeNow(pid);
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
    await this.stop(name, { keepWatching });
    this.start(name);
  }

  /**
   * Starts every process not running, each after the one it waits for (`after`): once that one's port
   * answers, or it has run a moment when it has no port.
   */
  async startAll({ waitMs = 20000 } = {}) {
    const started = new Set();
    const order = [];
    const visit = (p, seen = new Set()) => {
      if (started.has(p.name) || seen.has(p.name)) return;
      seen.add(p.name);
      const dep = p.spec.after && this.procs.get(p.spec.after);
      if (dep) visit(dep, seen);
      started.add(p.name);
      order.push(p);
    };
    for (const p of this.procs.values()) visit(p);
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
      if (p.pid) killTreeNow(p.pid);
    }
  }

  /** Checks each running process's port, and its health page when it has one: { open, status } on each. */
  async checkPorts({ fetchImpl = globalThis.fetch } = {}) {
    let changed = false;
    await Promise.all(
      [...this.procs.values()].map(async (p) => {
        if (!p.port || !p.child) return;
        const open = await portOpen(p.port);
        let health = null;
        if (open && p.spec.health) {
          try {
            const res = await fetchImpl(`http://127.0.0.1:${p.port}${p.spec.health.startsWith('/') ? '' : '/'}${p.spec.health}`, { signal: AbortSignal.timeout(2000) });
            health = res.status;
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
    try {
      if (WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else process.kill(pid, 'SIGTERM');
    } catch {
      // Gone already, or not ours to stop: the next look says.
    }
  }
}
