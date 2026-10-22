// Starting the crew's processes, keeping what they say, and stopping them: each runs through the shell
// in its own process group (taskkill's tree on Windows), so stopping one stops what it started too.
// Nothing here draws: App subscribes and redraws.
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { isTrouble, portInUse, stripAnsi } from './crew.js';

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
 * The crew's processes, by name: each { name, status, pid, startedAt, endedAt, code, lines, trouble,
 * port, portOpen, health }. `status` is stopped, starting, running, crashed (exited with an error),
 * exited (by itself, cleanly) or stopping. `onChange` is called after anything changes.
 */
export class Supervisor {
  constructor(procs, { dir, onChange = () => {}, spawnImpl = spawn, env = process.env } = {}) {
    this.dir = dir;
    this.onChange = onChange;
    this.spawnImpl = spawnImpl;
    this.env = env;
    this.procs = new Map();
    LIVE.add(this);
    this.setCrew(procs);
  }

  /** Stops everything and forgets this supervisor (App unmounting). */
  dispose() {
    this.killAllNow();
    LIVE.delete(this);
  }

  /** A new crew (bosun.json read again, another profile): what's running keeps running until restarted. */
  setCrew(procs) {
    const next = new Map();
    for (const p of procs) {
      const had = this.procs.get(p.name);
      next.set(p.name, had ? Object.assign(had, { spec: p, port: p.port }) : { name: p.name, spec: p, status: 'stopped', pid: null, startedAt: null, endedAt: null, code: null, lines: [], trouble: null, port: p.port, portOpen: null, health: null });
    }
    // One no longer in the crew is stopped.
    for (const [name, had] of this.procs) if (!next.has(name) && had.child) this.stop(name);
    this.procs = next;
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
      p.lines.push({ at: Date.now(), text: line, err });
      if (isTrouble(line) && !p.trouble) p.trouble = line.trim();
    }
    if (p.lines.length > KEEP_LINES) p.lines.splice(0, p.lines.length - KEEP_LINES);
  }

  /** Starts `name` (nothing if it's running). Resolves once it's started, not once it's ready. */
  start(name) {
    const p = this.procs.get(name);
    if (!p || p.child) return;
    const { run, cwd, env } = p.spec;
    p.status = 'starting';
    p.code = null;
    p.trouble = null;
    p.startedAt = Date.now();
    p.endedAt = null;
    this.push(p, `── ${run}`, false);
    const child = this.spawnImpl(run, {
      cwd: resolve(this.dir, cwd ?? '.'),
      shell: true,
      windowsHide: true,
      detached: !WIN,
      // FORCE_COLOR off: colours would be stripped anyway, and some tools write less without them.
      env: { ...this.env, ...env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.child = child;
    p.pid = child.pid ?? null;
    let buffered = { out: '', err: '' };
    const take = (which, err) => (d) => {
      buffered[which] += d;
      const cut = buffered[which].lastIndexOf('\n');
      if (cut < 0) return;
      this.push(p, buffered[which].slice(0, cut), err);
      buffered[which] = buffered[which].slice(cut + 1);
      if (p.status === 'starting') p.status = 'running';
      this.onChange();
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
      this.onChange();
    });
    this.onChange();
  }

  /** Stops `name` and what it started; resolves once it's gone (it's forced after `grace` ms). */
  stop(name, { grace = 3000 } = {}) {
    const p = this.procs.get(name);
    if (!p?.child) return Promise.resolve();
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

  async restart(name) {
    await this.stop(name);
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

  /** Stops everything at once, without waiting: for when Bosun itself is exiting. */
  killAllNow() {
    for (const p of this.procs.values()) if (p.pid) killTreeNow(p.pid);
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
      }),
    );
    if (changed) this.onChange();
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
