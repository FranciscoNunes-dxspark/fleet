// Recording a run of the crew: every line each process says and every change of its state, with
// when, one JSON object a line in ~/.bosun/sessions/<hash of the project's path>/<start time>.jsonl,
// for /replay (replay.js reads them back). The file is made with the first line a process says, so a
// session where nothing ran leaves nothing; the newest KEEP_SESSIONS are kept per project, and a
// session stops being recorded once its file passes MAX_BYTES.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { configDir } from './config.js';

export const KEEP_SESSIONS = 10;
export const MAX_BYTES = 20 * 1024 * 1024;

/** The project's folder as a short name for its sessions' folder (the same path, whatever its case on Windows). */
export function projectHash(dir, platform = process.platform) {
  const path = resolve(dir);
  return createHash('sha1').update(platform === 'win32' ? path.toLowerCase() : path).digest('hex').slice(0, 16);
}

/** Where `dir`'s sessions are kept. */
export const sessionsDir = (dir, home = configDir()) => join(home, 'sessions', projectHash(dir));

/** A session's file name from when it started: 2026-10-23T09-15-02-123Z.jsonl, which sorts by time. */
export const sessionFile = (ms) => `${new Date(ms).toISOString().replace(/[:.]/g, '-')}.jsonl`;

/** When a session's file says it started, or null for a name that isn't one. */
export function sessionStart(name) {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z\.jsonl$/.exec(name);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : null;
}

/** Of a folder's file `names`, the sessions to delete so the newest `keep` stay. */
export const toPrune = (names, keep = KEEP_SESSIONS) =>
  names
    .filter((n) => sessionStart(n) != null)
    .sort()
    .reverse()
    .slice(keep);

/** What the recorder keeps of a process's state: a change in any of these is an event. */
export const stateOf = (p) => ({ status: p.status, code: p.code ?? null, portOpen: p.portOpen ?? null, health: p.health ?? null, restartAt: p.restartAt ?? null, gaveUp: Boolean(p.gaveUp), tests: p.tests?.state ?? null, failed: p.tests?.failed ?? null });

/**
 * A short hash of the settings a process read from its env files, so a restore can say they changed
 * since: the values themselves are never recorded. Null when it reads none.
 */
export function envHash(fileEnv) {
  const entries = Object.entries(fileEnv ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!entries.length) return null;
  return createHash('sha1').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
}

/** The crew as a session's header and `procs` events list it. */
export const crewOf = (procs) => procs.map((p) => ({ name: p.name, port: p.port ?? p.spec?.port ?? null, run: p.spec?.run ?? p.run ?? '' }));

/**
 * One session's recording. `line`, `state`, `procs`, `started` and `profile` take events; they're
 * written a moment later (`flush`, which `close` does at once). `profile` is the one in use at the
 * start; `readGit` says the checkout's { branch, commit } (githead.js), asked at the start and at each
 * process's start, and recorded when it changed, so a restore can say what was checked out. `fs` is
 * for the tests.
 */
export class Recorder {
  constructor({ dir, project, procs = [], profile = null, readGit = null, now = Date.now(), maxBytes = MAX_BYTES, keep = KEEP_SESSIONS, every = 250, fs = { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } }) {
    Object.assign(this, { dir, project, maxBytes, keep, every, fs, readGit });
    this.start = now;
    this.file = join(dir, sessionFile(now));
    const git = this.git();
    this.gitKey = JSON.stringify(git);
    this.pending = [JSON.stringify({ type: 'session', v: 1, project, start: now, procs: crewOf(procs), profile, ...(git ? { git } : {}) })];
    this.opened = false;
    this.bytes = 0;
    this.cut = false;
    this.closed = false;
  }

  push(event, opens = false) {
    if (this.cut || this.closed) return;
    this.pending.push(JSON.stringify(event));
    if (opens) this.opened = true;
    if (this.opened && !this.timer) {
      this.timer = setTimeout(() => this.flush(), this.every);
      this.timer.unref?.();
    }
  }

  line(name, { at, text, err }) {
    this.push({ t: at, type: 'line', p: name, text, ...(err ? { err: true } : {}) }, true);
  }

  state(name, state, at = Date.now()) {
    this.push({ t: at, type: 'state', p: name, ...state });
  }

  procs(list, at = Date.now()) {
    this.push({ t: at, type: 'procs', procs: crewOf(list) });
  }

  /** A process starting: the hash of what its env files said (`envHash`), and the checkout when it moved. */
  started(name, { env = null } = {}, at = Date.now()) {
    const git = this.git();
    const key = JSON.stringify(git);
    if (key !== this.gitKey) {
      this.gitKey = key;
      if (git) this.push({ t: at, type: 'git', branch: git.branch, commit: git.commit });
    }
    this.push({ t: at, type: 'start', p: name, env });
  }

  /** Another profile picked (null: none). */
  profile(name, at = Date.now()) {
    this.push({ t: at, type: 'profile', profile: name ?? null });
  }

  /** The checkout as `readGit` says it, or null (no git, or reading it failed). */
  git() {
    try {
      const g = this.readGit?.();
      return g?.commit ? { branch: g.branch ?? null, commit: g.commit } : null;
    } catch {
      return null;
    }
  }

  /** Writes what's waiting (once the session has said something), keeping it under maxBytes. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.opened || !this.pending.length || this.cut) return;
    let text = this.pending.map((l) => `${l}\n`).join('');
    this.pending = [];
    try {
      if (!this.made) {
        this.fs.mkdirSync(this.dir, { recursive: true });
        this.made = true;
        const mine = basename(this.file);
        const names = this.fs.readdirSync(this.dir).filter((n) => n !== mine);
        for (const name of toPrune([...names, mine], this.keep).filter((n) => n !== mine)) this.fs.rmSync(join(this.dir, name), { force: true });
      }
      const size = Buffer.byteLength(text);
      if (this.bytes + size > this.maxBytes) {
        this.cut = true;
        text = `${JSON.stringify({ t: Date.now(), type: 'cut' })}\n`;
      }
      this.fs.appendFileSync(this.file, text);
      this.bytes += Buffer.byteLength(text);
    } catch {
      // A full disk or a read-only home: the session isn't recorded, and nothing else minds.
      this.cut = true;
    }
  }

  close() {
    if (this.closed) return;
    this.flush();
    this.closed = true;
  }
}

/** The sessions recorded for the project in `dir`: [{ file, start, bytes, ended }], newest first. */
export function listSessions(dir, { home = configDir(), fs = { readdirSync, statSync } } = {}) {
  const at = sessionsDir(dir, home);
  let names = [];
  try {
    names = fs.readdirSync(at);
  } catch {
    return [];
  }
  return names
    .filter((n) => sessionStart(n) != null)
    .sort()
    .reverse()
    .map((n) => {
      let st = null;
      try {
        st = fs.statSync(join(at, n));
      } catch {}
      return { file: join(at, n), start: sessionStart(n), bytes: st?.size ?? 0, ended: st?.mtimeMs ?? null };
    });
}
