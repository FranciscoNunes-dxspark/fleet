// The fleet without a terminal of its own: what `fleet gui` runs behind its window. Each app is
// started as the host starts it (launch.js: pipes, hosted mode), but nothing of its output reaches a
// real terminal. It draws into a virtual terminal of its own (vt.js), at the size its pane in the
// window has, and the window is sent the rows that changed (`frame` events), as runs of text and
// style. Keys, pastes and mouse reports come back from the window as the bytes a terminal would have
// sent (keymap.js turns the browser's events into them), so the apps can't tell the difference.
//
// It keeps what the terminal host keeps: whether each app runs or exited (and its stderr's end), the
// hand-offs between them (switching the window to the app and typing the line into its prompt), the
// badges from the family's moods and activity, the folder the fleet runs in, and the app messages
// (`ready`, `handoff`, `update`, `move`). Everything outside is injected (`spawn`, timers, the clock, the
// family's folder), so the tests drive it with small fake apps and no window.
import { StringDecoder } from 'node:string_decoder';
import { familyDir } from '@fleet/kit/family.js';
import { remember } from '@fleet/kit/folders.js';
import { DEFAULT_PREFIX } from '../keys.js';
import { encodeMessage, messageReader } from '@fleet/kit/hosted.js';
import { badgeFor, badgeText, familyReader } from '../attention.js';
import { pasteFor, routeHandoff } from '../handoff.js';
import { OutputFilter } from '../screen.js';
import { SPACES } from '../spaces.js';
import { requestIdOfLine } from '../trace.js';
import { VirtualTerminal } from '../vt.js';
import { rowRuns } from './frames.js';

const READY_DELAY = 300;
const SWITCH_DELAY = 100;
const ATTENTION_MS = 3000;
// The window is sent what changed at most this often: Ink draws a frame in several writes.
const FRAME_MS = 16;
const STOP_GRACE_MS = 3000;

export class GuiSession {
  constructor({
    spawn,
    spaces = SPACES,
    args = {},
    cwd = process.cwd(),
    size = { columns: 100, rows: 30 },
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
    now = () => Date.now(),
    familyHome = familyDir(),
    attentionEvery = ATTENTION_MS,
    onUpdate = () => {},
    // The prefix as it's named (keys.js prefixName: host.json's, else ctrl+b), for the window's keys.
    prefix = DEFAULT_PREFIX,
    // The folders moved to lately (host.json's "folders"), newest first, and keeping them.
    folders = [],
    onFolders = () => {},
  }) {
    Object.assign(this, { spawnApp: spawn, args, cwd, setTimer, clearTimer, now, attentionEvery, onUpdate, prefix, folders, onFolders });
    this.spaces = spaces.map((s) => ({
      ...s,
      state: 'idle',
      code: null,
      child: null,
      ready: false,
      paste: null,
      stderr: '',
      badge: null,
      size: { ...size },
      vt: new VirtualTerminal(size.columns, size.rows),
      filter: new OutputFilter(),
      sent: [],
      // The native views the app asked for (the kit's ui/GuiView.jsx), by key.
      views: new Map(),
    }));
    this.listeners = new Set();
    this.family = familyReader(familyHome);
    const started = now();
    this.seen = Object.fromEntries(this.spaces.map((s) => [s.id, started]));
    // The spaces the window shows (one, or two side by side): those never get a badge.
    this.shown = [];
    this.active = null;
    this.lastRequestId = null;
    this.frameTimer = null;
    this.attentionTimer = null;
    this.stopped = false;
  }

  /** Starts watching the family's folder for badges. */
  start() {
    const tick = () => {
      this.attentionTimer = this.setTimer(tick, this.attentionEvery);
      this.checkAttention();
    };
    this.attentionTimer = this.setTimer(tick, this.attentionEvery);
  }

  space(id) {
    return this.spaces.find((s) => s.id === id);
  }

  /** `fn(event)` for everything the window needs to know; returns how to stop listening. */
  listen(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // One window gone wrong doesn't stop the others.
      }
    }
  }

  /** What a space is, for the window: no screen, no process. */
  describe(s) {
    return { id: s.id, title: s.title, letter: s.letter, accent: s.accent, state: s.state, code: s.code, badge: s.badge, stderr: s.state === 'exited' ? s.stderr.slice(-2000) : '', mouse: s.filter.wantsMouse() };
  }

  /** Everything a window that has just opened needs: the spaces, the folder, and every screen whole. */
  snapshot() {
    return {
      type: 'hello',
      cwd: this.cwd,
      prefix: this.prefix,
      active: this.active,
      shown: this.shown,
      spaces: this.spaces.map((s) => this.describe(s)),
      frames: this.spaces.filter((s) => s.state !== 'idle').map((s) => this.frameOf(s, { whole: true })),
      views: Object.fromEntries(this.spaces.map((s) => [s.id, Object.fromEntries(s.views)])),
    };
  }

  spacesChanged() {
    this.emit({ type: 'spaces', active: this.active, shown: this.shown, cwd: this.cwd, spaces: this.spaces.map((s) => this.describe(s)) });
  }

  notice(text) {
    this.emit({ type: 'notice', text });
  }

  // ---- what the window shows -------------------------------------------------------------------

  /**
   * The window shows `ids` (one space, or two side by side), the first with the keys. One not started
   * yet starts now. What was on screen until now counts as seen.
   */
  show(ids) {
    const list = [].concat(ids).filter((id) => this.space(id)).slice(0, 2);
    if (!list.length) return;
    for (const id of new Set([...this.shown, ...list])) this.looked(id);
    this.shown = list;
    this.active = list[0];
    for (const id of list) {
      const s = this.space(id);
      if (s.state === 'idle') this.launch(s);
    }
    this.spacesChanged();
  }

  /** The size of a space's pane in the window, in cells: the app is told, and draws at it. */
  resize(id, columns, rows) {
    const s = this.space(id);
    if (!s || !(columns > 0) || !(rows > 0)) return;
    columns = Math.min(500, Math.floor(columns));
    rows = Math.min(200, Math.floor(rows));
    const same = s.size.columns === columns && s.size.rows === rows;
    s.size = { columns, rows };
    if (!same) {
      s.vt.resize(columns, rows);
      s.sent = [];
    }
    // The same size again is a repaint (hosted.js), which a window that has just opened wants too.
    this.tell(s, { resize: s.size });
    this.queueFrame(s, { whole: true });
  }

  /** What was typed in the window, for space `id`: keys, a paste or mouse reports, as a terminal sends them. */
  input(id, data) {
    const s = this.space(id);
    if (!s || typeof data !== 'string' || !data) return;
    if (!s.child) {
      // An exited app's pane says "↵ to start again".
      if (s.state === 'exited' && /\r/.test(data)) this.launch(s);
      return;
    }
    // Mouse reports only reach an app that asked for them, as in the terminal host.
    const forApp = s.filter.wantsMouse() ? data : data.replace(/\x1b\[<[\d;]+[Mm]/g, '');
    if (forApp) s.child.stdin.write(forApp);
  }

  /** Starts an app again (or for the first time): an exited one, or one stopped by hand. */
  restart(id) {
    const s = this.space(id);
    if (!s) return;
    if (s.child) {
      s.restarting = true;
      return this.stopSpace(s);
    }
    this.launch(s);
  }

  // ---- the apps --------------------------------------------------------------------------------

  launch(s) {
    if (this.stopped) return;
    const decoder = new StringDecoder('utf8');
    let child;
    const filter = new OutputFilter({ onMessage: (m) => this.message(s, child, m) });
    Object.assign(s, { state: 'running', code: null, filter, ready: false, stderr: '', restarting: false, moving: false });
    // A fresh screen: the app's alternate screen, which would clear it, is the host's to drop.
    s.vt.reset();
    this.dropViews(s);
    s.sent = [];
    try {
      child = this.spawnApp(s.id, { ...s.size, args: this.args[s.id] ?? [], cwd: this.cwd });
    } catch (e) {
      s.stderr = e.message;
      return this.exited(s, null, 'error');
    }
    s.child = child;
    child.stdout.on('data', (b) => this.fromApp(s, child, decoder.write(b)));
    child.stderr?.on('data', (b) => {
      s.stderr = (s.stderr + b.toString()).slice(-8000);
    });
    child.control.on('data', messageReader((m) => this.message(s, child, m)));
    child.control.on('error', () => {});
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      s.stderr += `${e.message}\n`;
      this.exited(s, child, 'error');
    });
    child.on('exit', (code, signal) => this.exited(s, child, code ?? signal));
    this.spacesChanged();
    this.queueFrame(s, { whole: true });
  }

  fromApp(s, child, text) {
    if (s.child !== child || !text) return;
    const out = s.filter.push(text, { active: true });
    if (!out) return;
    const said = s.vt.write(out);
    if (said) this.terminalSaid(s, said);
    this.queueFrame(s);
  }

  /**
   * What an app said to the terminal rather than drew: the bell, the clipboard (OSC 52), a
   * notification (OSC 9 and 777) or a title. The window acts on them.
   */
  terminalSaid(s, said) {
    for (const m of said.matchAll(/\x07|\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
      if (m[0] === '\x07') {
        this.emit({ type: 'bell', id: s.id });
        continue;
      }
      const [, code, body] = m;
      if (code === '52') {
        const b64 = body.slice(body.indexOf(';') + 1);
        if (b64 === '?') continue;
        let text = '';
        try {
          text = Buffer.from(b64, 'base64').toString('utf8');
        } catch {
          continue;
        }
        this.emit({ type: 'copy', id: s.id, text });
      } else if (code === '9') this.emit({ type: 'notify', id: s.id, title: s.title, body });
      else if (code === '777') {
        const [, title = s.title, text = ''] = body.split(';');
        this.emit({ type: 'notify', id: s.id, title, body: text });
      } else this.emit({ type: 'title', id: s.id, title: body });
    }
  }

  message(s, child, m) {
    if (s.child !== child) return;
    if (m.ready) {
      s.ready = true;
      if (s.paste != null) this.setTimer(() => this.typePaste(s), READY_DELAY);
      this.spacesChanged();
    }
    if (m.handoff) this.handoff(s, m);
    if (m.update) this.onUpdate();
    if (typeof m.move === 'string' && m.move.trim()) this.emit({ type: 'ask-move', from: s.title, folder: m.move });
    if (m.view && typeof m.view.key === 'string') this.view(s, m.view);
  }

  /** A native view shown, moved or taken away (the kit's GuiView): kept for windows that open later. */
  view(s, v) {
    if (v.gone) {
      if (!s.views.delete(v.key)) return;
      return this.emit({ type: 'view', id: s.id, key: v.key, view: null });
    }
    const r = v.rect ?? {};
    const rect = { x: Number(r.x) || 0, y: Number(r.y) || 0, width: Number(r.width) || 0, height: Number(r.height) || 0 };
    const view = { kind: String(v.kind ?? ''), data: v.data ?? null, rect };
    s.views.set(v.key, view);
    this.emit({ type: 'view', id: s.id, key: v.key, view });
  }

  /** An app's views all gone (it started again, or exited). */
  dropViews(s) {
    if (!s.views.size) return;
    s.views.clear();
    this.emit({ type: 'views', id: s.id, views: {} });
  }

  handoff(from, m) {
    // The request a hand-off names is what following a request offers.
    this.lastRequestId = requestIdOfLine(m.line) ?? this.lastRequestId;
    const route = routeHandoff(m, { from: from.id, running: (id) => Boolean(this.space(id)?.child), ids: this.spaces.map((s) => s.id) });
    if (!route.to) return;
    // Side by side, the app it goes to takes the other pane, so the one it came from stays in sight.
    if (this.shown.length === 2 && this.shown.includes(from.id) && !this.shown.includes(route.to)) this.show([route.to, from.id]);
    this.sendLine(route.to, route.line, { from: from.title });
  }

  /** Hands `line` to app `id`: shown in the window, started if need be, and typed into its prompt once it reads keys. */
  sendLine(id, line, { from } = {}) {
    const to = this.space(id);
    if (!to) return;
    to.paste = pasteFor(line);
    if (!this.shown.includes(to.id)) this.show(this.shown.length === 2 ? [to.id, this.shown.find((x) => x !== this.active) ?? this.shown[1]] : [to.id]);
    else this.show([to.id, ...this.shown.filter((x) => x !== to.id)]);
    this.emit({ type: 'focus', id: to.id });
    this.notice(`${from ? `${from} → ` : ''}${to.title}: ↵ runs it`);
    if (to.child && to.ready) this.setTimer(() => this.typePaste(to), SWITCH_DELAY);
  }

  /** Types `line` into app `id`'s prompt without showing it (now when it reads keys, else once it does). */
  typeInto(id, line) {
    const s = this.space(id);
    if (!s?.child) return false;
    s.paste = pasteFor(line);
    if (s.ready) this.typePaste(s);
    return true;
  }

  typePaste(s) {
    if (s.paste == null || !s.child) return;
    const text = s.paste;
    s.paste = null;
    s.child.stdin.write(text);
  }

  tell(s, message) {
    try {
      s.child?.control.write(encodeMessage(message));
    } catch {
      // It's on its way out; its exit says so.
    }
  }

  exited(s, child, code) {
    if (child && s.child !== child) return;
    Object.assign(s, { state: 'exited', code, child: null, ready: false, paste: null });
    this.dropViews(s);
    if (this.stopped) return;
    if (s.restarting || s.moving) return this.launch(s);
    this.spacesChanged();
  }

  /** Ends an app's control pipe, which makes it quit by itself; kills what's left after a while. */
  stopSpace(s) {
    const child = s.child;
    if (!child) return;
    try {
      child.control.end();
    } catch {
      // Gone already.
    }
    this.setTimer(() => {
      if (s.child === child) child.kill(true);
    }, STOP_GRACE_MS);
  }

  /** Every app started again in `dir`; those not started yet will start there. */
  moveTo(dir) {
    this.cwd = dir;
    this.folders = remember(this.folders, dir);
    this.onFolders(this.folders);
    for (const s of this.spaces) {
      if (!s.child) continue;
      s.moving = true;
      this.stopSpace(s);
    }
    this.notice(`The fleet is in ${dir} now`);
    this.spacesChanged();
  }

  /** Stops everything: every app's control pipe ended, and what's left killed after a while. */
  stop() {
    this.stopped = true;
    this.clearTimer(this.attentionTimer);
    this.clearTimer(this.frameTimer);
    for (const s of this.spaces) this.stopSpace(s);
  }

  // ---- frames ----------------------------------------------------------------------------------

  queueFrame(s, { whole = false } = {}) {
    if (whole) s.vt.dirty.fill(true);
    s.frameQueued = true;
    if (this.frameTimer) return;
    this.frameTimer = this.setTimer(() => {
      this.frameTimer = null;
      for (const sp of this.spaces) {
        if (!sp.frameQueued) continue;
        // Halfway through the app's own synchronized update, the rest of the frame is on its way.
        if (sp.vt.sync) {
          this.queueFrame(sp);
          continue;
        }
        sp.frameQueued = false;
        const frame = this.frameOf(sp);
        if (frame.rows.length || frame.cursorMoved) this.emit(frame);
      }
    }, FRAME_MS);
  }

  /** What changed on a space's screen since it was last sent ({ whole } sends every row). */
  frameOf(s, { whole = false } = {}) {
    const { vt } = s;
    const rows = [];
    const ys = whole ? Array.from({ length: vt.rows }, (_, y) => y) : vt.takeDirty();
    if (whole) vt.takeDirty();
    for (const y of ys) {
      const runs = rowRuns(vt.chars[y], vt.styles[y]);
      const key = JSON.stringify(runs);
      if (!whole && s.sent[y] === key) continue;
      s.sent[y] = key;
      rows.push([y, runs]);
    }
    const cursor = { x: vt.x, y: vt.y, shown: vt.cursorShown() };
    const cursorMoved = JSON.stringify(cursor) !== s.sentCursor;
    s.sentCursor = JSON.stringify(cursor);
    return { type: 'frame', id: s.id, columns: vt.columns, rows: rows, height: vt.rows, cursor, cursorMoved, whole };
  }

  // ---- badges ----------------------------------------------------------------------------------

  looked(id) {
    this.seen[id] = this.now();
    const s = this.space(id);
    if (s?.badge) {
      s.badge = null;
      this.spacesChanged();
    }
  }

  checkAttention() {
    if (this.stopped) return;
    const { moods, activity } = this.family.read(this.spaces.map((s) => s.id));
    const now = this.now();
    let changed = false;
    let news = null;
    for (const s of this.spaces) {
      if (this.shown.includes(s.id)) {
        this.seen[s.id] = now;
        changed ||= Boolean(s.badge);
        s.badge = null;
        continue;
      }
      const badge = badgeFor(s.id, { mood: moods[s.id], activity, seen: this.seen[s.id] });
      if (badge && !s.badge) news ??= { space: s, badge };
      changed ||= badgeText(badge) !== badgeText(s.badge);
      s.badge = badge;
    }
    if (changed || news) this.spacesChanged();
    if (news) this.emit({ type: 'attention', id: news.space.id, title: news.space.title, reason: news.badge.reason || `${news.space.title} needs you` });
  }
}
