// Reading a recorded session back (recorder.js wrote it), for the Replay view: the crew as it was at
// any moment, the crashes and trouble to jump between, and the timeline bar. Pure.
import { isTrouble } from './crew.js';

/** A session file's text as { header, events (by time), start, end, cut }; lines that don't read are skipped. */
export function parseSession(text) {
  let header = null;
  const events = [];
  let cut = false;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type === 'session') header ??= e;
    else if (e?.type === 'cut') cut = true;
    else if (e && Number.isFinite(e.t)) events.push(e);
  }
  events.sort((a, b) => a.t - b.t);
  const start = header?.start ?? events[0]?.t ?? 0;
  const end = Math.max(start, events.at(-1)?.t ?? start);
  return { header, events, start, end, cut, project: header?.project ?? null };
}

const RUNNING = new Set(['starting', 'running', 'stopping']);

/**
 * The crew at a moment of a session, worked out forward from the last moment asked for (back in time
 * starts over): `at(t)` returns [{ name, status, code, port, portOpen, health, restartAt, gaveUp,
 * tests, lines, trouble, child }], shaped as the supervisor's processes are so the Crew view's pieces
 * draw them. `keep` lines per process.
 */
export class Replayer {
  constructor(session, { keep = 3000 } = {}) {
    this.session = session;
    this.keep = keep;
    this.reset();
  }

  reset() {
    this.index = 0;
    this.t = -Infinity;
    this.procs = new Map();
    for (const p of this.session.header?.procs ?? []) this.add(p);
  }

  add({ name, port = null, run = '' }) {
    if (!this.procs.has(name)) this.procs.set(name, { name, port, spec: { run, port }, status: 'stopped', code: null, portOpen: null, health: null, restartAt: null, gaveUp: false, tests: null, lines: [], trouble: null, child: null });
    return this.procs.get(name);
  }

  at(t) {
    if (t < this.t) this.reset();
    const { events } = this.session;
    while (this.index < events.length && events[this.index].t <= t) this.apply(events[this.index++]);
    this.t = t;
    return [...this.procs.values()].map((p) => ({ ...p, lines: p.lines }));
  }

  apply(e) {
    if (e.type === 'procs') {
      for (const p of e.procs ?? []) Object.assign(this.add(p), { port: p.port, spec: { run: p.run, port: p.port } });
      return;
    }
    const p = this.add({ name: e.p });
    if (e.type === 'line') {
      const text = String(e.text ?? '');
      p.lines.push({ at: e.t, text, err: Boolean(e.err) });
      if (p.lines.length > this.keep * 1.5) p.lines.splice(0, p.lines.length - this.keep);
      // A start says its command first (`── node api.js`), and forgets the trouble before.
      if (text === `── ${p.spec?.run}`) p.trouble = null;
      if (!p.trouble && !text.startsWith('── ') && isTrouble(text)) p.trouble = text.trim();
    } else if (e.type === 'state') {
      const { t: _t, type: _type, p: _p, failed, tests, ...rest } = e;
      Object.assign(p, rest, { tests: tests ? { state: tests, failed } : null });
      // Something to tell a running one by, for the pieces that ask (`child`).
      p.child = RUNNING.has(p.status) ? true : null;
      if (p.status === 'starting') p.startedAt = e.t;
    }
  }
}

/**
 * The moments worth jumping to: [{ t, kind: 'crash' | 'trouble', p, text }], by time. A crash is a
 * process turning `crashed`; trouble a line that reads as it (Bosun's own ── lines aren't).
 */
export function marksOf(session) {
  const out = [];
  for (const e of session.events) {
    if (e.type === 'state' && e.status === 'crashed') out.push({ t: e.t, kind: 'crash', p: e.p, text: `${e.p} crashed${e.code != null ? ` (${e.code})` : ''}` });
    else if (e.type === 'line' && !String(e.text).startsWith('── ') && isTrouble(String(e.text))) out.push({ t: e.t, kind: 'trouble', p: e.p, text: String(e.text) });
  }
  return out;
}

/** The first mark after `t` (dir 1) or the last before it (dir -1), or null. */
export function nextMark(marks, t, dir) {
  if (dir > 0) return marks.find((m) => m.t > t) ?? null;
  return marks.findLast((m) => m.t < t) ?? null;
}

/** m:ss, or h:mm:ss past an hour, of `ms`. */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const two = (n) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/**
 * The timeline bar, `width` cells from the session's start to its end: each cell ─, or ✗ where a
 * process crashed in it, ! where something said trouble; `cursor` is the cell `t` is in.
 * Returns { cells: [' ' | '─' | '!' | '✗'], cursor }.
 */
export function timeline(session, marks, t, width) {
  const w = Math.max(1, width);
  const span = Math.max(1, session.end - session.start);
  const cellOf = (ms) => Math.min(w - 1, Math.max(0, Math.floor(((ms - session.start) / span) * w)));
  const cells = Array(w).fill('─');
  for (const m of marks) {
    const c = cellOf(m.t);
    if (m.kind === 'crash') cells[c] = '✗';
    else if (cells[c] !== '✗') cells[c] = '!';
  }
  return { cells, cursor: cellOf(t) };
}

/** Speeds `+` and `-` step through. */
export const SPEEDS = [1, 2, 4, 8, 16, 32, 64];
