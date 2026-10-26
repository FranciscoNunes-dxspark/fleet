// The host: the family's apps in one terminal, one at a time on screen, like tmux's windows. Each app
// is a process of its own in hosted mode (the kit's hosted.js), drawing into a pipe the host reads;
// the active one's drawing goes on to the terminal (screen.js keeps it off the bar and the host's
// screen modes), the others' is dropped while they keep running. What's typed goes to the active app
// as it came (keys.js), but for the prefix, ctrl+], and its key.
//
// The bar is the screen's last row, the apps get the rows above it. Ink redraws whole frames (an app
// fills its screen, so every frame begins by clearing the terminal, the bar with it), so rather than
// keep the apps off that row (a scroll region wouldn't stop a clear), the bar is drawn again after
// each frame: inside the frame's synchronized update when it has one, from a saved cursor, so the
// terminal never shows a frame without it and the app's cursor and colours are as it left them.
//
// Everything outside is injected: the terminal (`input`, `output` with columns, rows and 'resize'),
// starting an app (`spawn`), timers, so tests drive it with streams and small fake apps.
import { StringDecoder } from 'node:string_decoder';
import { encodeMessage, messageReader } from '@fleet/kit/hosted.js';
import { fit, stringWidth } from '@fleet/kit/text.js';
import { barLayout, renderBar, tabAt } from './bar.js';
import { pasteFor, routeHandoff } from './handoff.js';
import { readKeys, takeBarClicks } from './keys.js';
import { HOST_MOUSE, MOUSE_MODES, OutputFilter } from './screen.js';
import { SPACES } from './spaces.js';

/** What the host writes to take the screen, and to give it back as it found it. */
export const ENTER = `\x1b[?1049h\x1b[22;0t\x1b[2J\x1b[H${HOST_MOUSE}`;
export const LEAVE = `\x1b[?2026l\x1b[0m${MOUSE_MODES.map((n) => `\x1b[?${n}l`).join('')}\x1b[?1004l\x1b[?2004l\x1b[?25h\x1b[?1049l\x1b[23;0t`;

const CLEAR = '\x1b[?2026l\x1b[0m\x1b[2J\x1b[H';
// How long after an app first reads keys a hand-off is typed in (its views are settling), and after a
// switch to one that already runs (its repaint goes first).
const READY_DELAY = 300;
const SWITCH_DELAY = 100;
// How long a stopped app gets to finish before it's killed, with what it started.
const STOP_GRACE = 3000;
const NOTICE_MS = 4000;

export const HELP = [
  ['alt+1-6', 'switch to that space'],
  ['ctrl+] 1-6', 'switch to that space'],
  ['ctrl+] s t o b h k', 'Splice, Trawl, Sonar, Bosun, Hail, Keel'],
  ['ctrl+] ] or n', 'next space'],
  ['ctrl+] p', 'previous space'],
  ['ctrl+] ctrl+]', 'send ctrl+] to the app'],
  ['ctrl+] q', 'quit Fleet and every app'],
  ['ctrl+] ?', 'this help'],
  ['', ''],
  ['a click on a tab', 'switches to it'],
  ['copied "for Trawl"', 'goes to Trawl, typed into its prompt'],
];

export class Host {
  constructor({
    input,
    output,
    spawn,
    spaces = SPACES,
    args = {},
    truecolor = true,
    onSwitch = () => {},
    onUpdate = () => {},
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
  }) {
    Object.assign(this, { input, output, spawnApp: spawn, args, truecolor, onSwitch, onUpdate, setTimer, clearTimer });
    this.spaces = spaces.map((s) => ({ ...s, state: 'idle', code: null, child: null, filter: new OutputFilter(), ready: false, paste: null, stderr: '' }));
    this.active = null;
    this.keys = { prefix: false };
    this.help = false;
    this.confirming = false;
    this.quitting = false;
    this.noticeText = '';
    this.noticeTimer = null;
    this.decoder = new StringDecoder('utf8');
    this.done = new Promise((resolve) => (this.finish = resolve));
    this.onInput = (chunk) => this.handleInput(typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    this.onResize = () => this.resized();
  }

  space(id) {
    return this.spaces.find((s) => s.id === id);
  }

  /** The terminal's size, and the part of it the apps get: every row but the bar's. */
  size() {
    return { columns: this.output.columns || 80, rows: this.output.rows || 24 };
  }

  appSize() {
    const { columns, rows } = this.size();
    return { columns, rows: Math.max(1, rows - 1) };
  }

  /** Takes the screen and opens space `id`. Resolves `done` once the host has quit. */
  start(id = this.spaces[0].id) {
    this.output.write(ENTER);
    this.input.on('data', this.onInput);
    this.output.on?.('resize', this.onResize);
    this.switchTo(id);
    return this.done;
  }

  // ---- the bar ----------------------------------------------------------------------------------

  barText() {
    const { columns } = this.size();
    if (this.confirming) {
      const names = this.spaces.filter((s) => s.child).map((s) => s.title);
      const text = ` Quit Fleet? ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} running and will stop.  y quits · any other key stays `;
      return `\x1b[0m\x1b[48;5;236m\x1b[1m\x1b[38;5;229m${fit(text, columns)}\x1b[0m`;
    }
    this.layout = barLayout({ spaces: this.spaces, active: this.active, width: columns, prefix: this.keys.prefix, notice: this.noticeText });
    return renderBar(this.layout, this.spaces, { truecolor: this.truecolor });
  }

  /** The bar drawn from a saved cursor, so whatever was drawing carries on where it was. */
  barString() {
    return `\x1b7\x1b[${this.size().rows};1H${this.barText()}\x1b8`;
  }

  drawBar() {
    this.output.write(this.barString());
  }

  notice(text) {
    this.noticeText = text;
    if (this.noticeTimer) this.clearTimer(this.noticeTimer);
    this.noticeTimer = this.setTimer(() => {
      this.noticeText = '';
      this.noticeTimer = null;
      this.drawBar();
    }, NOTICE_MS);
    this.drawBar();
  }

  // ---- keys -------------------------------------------------------------------------------------

  handleInput(text) {
    if (!text || this.quitting) return;
    const { state, actions } = readKeys(this.keys, text, this.spaces);
    this.keys = state;
    for (const a of actions) {
      if (a.type === 'prefix') this.drawBar();
      else if (a.type === 'send') this.deliver(a.data);
      else if (this.confirming) this.answerQuit(false);
      else if (a.type === 'switch') this.switchTo(a.id);
      else if (a.type === 'move') this.move(a.by);
      else if (a.type === 'quit') this.askQuit();
      else if (a.type === 'help') this.showHelp();
    }
  }

  deliver(data) {
    if (this.confirming) return this.answerQuit(/^[yY\r]/.test(data));
    const { data: rest, clicks } = takeBarClicks(data, this.size().rows);
    for (const x of clicks) {
      const id = this.layout && tabAt(this.layout, x);
      if (id) return this.switchTo(id);
    }
    if (this.help) {
      // Any key closes it, and goes no further; the wheel and the like don't.
      if (rest && !/^(\x1b\[<[\d;]+[Mm])+$/.test(rest)) this.closeHelp();
      return;
    }
    const space = this.space(this.active);
    // The mouse is on for the bar's sake; an app that didn't ask for it gets no reports.
    const forApp = space.child && !space.filter.wantsMouse() ? rest.replace(/\x1b\[<[\d;]+[Mm]/g, '') : rest;
    if (!forApp) return;
    if (space.child) space.child.stdin.write(forApp);
    else if (/\r/.test(rest)) this.launch(space);
  }

  move(by) {
    const i = this.spaces.findIndex((s) => s.id === this.active);
    this.switchTo(this.spaces[(i + by + this.spaces.length) % this.spaces.length].id);
  }

  // ---- switching and drawing ---------------------------------------------------------------------

  /** Puts space `id` on screen: started if it never was, else drawn again whole. */
  switchTo(id) {
    const space = this.space(id);
    if (!space) return;
    this.help = false;
    this.active = id;
    this.onSwitch(id);
    if (space.state === 'idle') this.launch(space);
    else this.redraw();
  }

  /** Draws the active space again from nothing: its own modes, then the app's whole frame. */
  redraw() {
    const space = this.space(this.active);
    this.output.write(CLEAR + space.filter.restoreModes());
    if (space.child) {
      this.drawBar();
      // The same size again: Ink redraws the whole frame (the kit's hosted.js).
      this.tell(space, { resize: this.appSize() });
    } else if (space.state === 'exited') this.drawExited(space);
    else this.drawBar();
  }

  drawExited(space) {
    const { columns } = this.size();
    const { rows } = this.appSize();
    const said = `${space.title} exited${space.code && space.code !== 0 ? ` with ${space.code}` : ''} — ↵ to start again`;
    const lines = [said, '', 'ctrl+] q quits Fleet · ctrl+] ? shows the keys'];
    const errors = space.stderr.replace(/\x1b\[[\d;?]*[A-Za-z]/g, '').split(/\r?\n/).filter((l) => l.trim());
    const room = Math.max(0, rows - lines.length - 4);
    const tail = errors.slice(-room);
    const top = Math.max(0, Math.floor((rows - lines.length - (tail.length ? tail.length + 1 : 0)) / 2));
    let out = '\x1b[0m\x1b[?25l\x1b[2J';
    lines.forEach((l, i) => {
      const pad = Math.max(0, Math.floor((columns - stringWidth(l)) / 2));
      out += `\x1b[${top + i + 1};${pad + 1}H${i === 0 ? '\x1b[1m' : '\x1b[2m'}${fit(l, columns - pad)}\x1b[0m`;
    });
    tail.forEach((l, i) => {
      out += `\x1b[${top + lines.length + 2 + i};1H\x1b[2m${fit(`  ${l}`, columns)}\x1b[0m`;
    });
    this.output.write(out);
    this.drawBar();
  }

  showHelp() {
    this.help = true;
    const { columns } = this.size();
    const { rows } = this.appSize();
    const keyW = Math.max(...HELP.map(([k]) => stringWidth(k)));
    const inner = Math.min(columns - 4, keyW + 3 + Math.max(...HELP.map(([, d]) => stringWidth(d))));
    const body = [' Fleet: the family in one terminal', '', ...HELP.map(([k, d]) => (k ? ` ${fit(k, keyW)}  ${d}` : '')), '', ' any key closes this'];
    const width = Math.max(10, inner + 2);
    const left = Math.max(0, Math.floor((columns - width - 2) / 2));
    const top = Math.max(0, Math.floor((rows - body.length - 2) / 2));
    let out = '\x1b[0m\x1b[?25l';
    const at = (row, text) => (out += `\x1b[${top + row + 1};${left + 1}H${text}`);
    at(0, `┌${'─'.repeat(width)}┐`);
    body.forEach((l, i) => at(i + 1, `│${i === 0 ? '\x1b[1m' : ''}${fit(l, width)}\x1b[0m│`));
    at(body.length + 1, `└${'─'.repeat(width)}┘`);
    this.output.write(out);
    this.drawBar();
  }

  closeHelp() {
    this.help = false;
    this.redraw();
  }

  resized() {
    const size = this.appSize();
    // The others draw at the new size too, off screen, so they're right when they come back.
    for (const s of this.spaces) if (s.child && s.id !== this.active) this.tell(s, { resize: size });
    if (this.help) this.help = false;
    this.redraw();
  }

  // ---- the apps ---------------------------------------------------------------------------------

  tell(space, message) {
    try {
      space.child?.control.write(encodeMessage(message));
    } catch {
      // It's on its way out; its exit says so.
    }
  }

  /** Starts the app of `space`, at the size of the screen above the bar. */
  launch(space) {
    const decoder = new StringDecoder('utf8');
    let child;
    // The app's messages come in its output, taken out by the filter (hosted.js says why not fd 3).
    const filter = new OutputFilter({ onMessage: (m) => this.message(space, child, m) });
    Object.assign(space, { state: 'running', code: null, filter, ready: false, stderr: '' });
    try {
      child = this.spawnApp(space.id, { ...this.appSize(), args: this.args[space.id] ?? [] });
    } catch (e) {
      space.stderr = e.message;
      return this.exited(space, null, 'error');
    }
    space.child = child;
    child.stdout.on('data', (b) => this.fromApp(space, child, decoder.write(b)));
    child.stderr?.on('data', (b) => {
      space.stderr = (space.stderr + b.toString()).slice(-8000);
    });
    child.control.on('data', messageReader((m) => this.message(space, child, m)));
    child.control.on('error', () => {});
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      space.stderr += `${e.message}\n`;
      this.exited(space, child, 'error');
    });
    child.on('exit', (code, signal) => this.exited(space, child, code ?? signal));
    // A new app starts on a clear screen and draws its first frame from the top by itself.
    if (space.id === this.active) this.output.write(CLEAR + space.filter.restoreModes());
    this.drawBar();
  }

  fromApp(space, child, text) {
    if (space.child !== child || !text) return;
    const active = space.id === this.active && !this.help;
    const out = space.filter.push(text, { active, bar: active ? this.barString() : '' });
    if (out) this.output.write(out);
  }

  message(space, child, m) {
    if (space.child !== child) return;
    if (m.ready) {
      space.ready = true;
      if (space.paste != null) this.setTimer(() => this.typePaste(space), READY_DELAY);
    }
    if (m.handoff) this.handoff(space, m);
    if (m.update) this.onUpdate();
  }

  handoff(from, m) {
    const route = routeHandoff(m, { from: from.id, running: (id) => Boolean(this.space(id)?.child), ids: this.spaces.map((s) => s.id) });
    if (!route.to) return;
    const to = this.space(route.to);
    to.paste = pasteFor(route.line);
    this.switchTo(to.id);
    this.notice(`Handed to ${to.title}: ↵ runs it`);
    if (to.child && to.ready) this.setTimer(() => this.typePaste(to), SWITCH_DELAY);
  }

  typePaste(space) {
    if (space.paste == null || !space.child) return;
    const text = space.paste;
    space.paste = null;
    space.child.stdin.write(text);
  }

  exited(space, child, code) {
    if (child && space.child !== child) return;
    Object.assign(space, { state: 'exited', code, child: null, ready: false, paste: null });
    if (this.quitting) return this.checkQuit();
    if (this.confirming && !this.spaces.some((s) => s.child)) this.confirming = false;
    if (space.id === this.active && !this.help) {
      this.output.write(CLEAR + new OutputFilter().restoreModes());
      this.drawExited(space);
    } else this.drawBar();
  }

  // ---- quitting ---------------------------------------------------------------------------------

  askQuit() {
    if (!this.spaces.some((s) => s.child)) return this.quit();
    this.confirming = true;
    this.drawBar();
  }

  answerQuit(yes) {
    this.confirming = false;
    if (yes) this.quit();
    else this.drawBar();
  }

  /** Stops every app (each gets STOP_GRACE to finish, then is killed), then gives the terminal back. */
  quit() {
    if (this.quitting) return this.done;
    this.quitting = true;
    if (this.noticeTimer) this.clearTimer(this.noticeTimer);
    for (const s of this.spaces) {
      if (!s.child) continue;
      const child = s.child;
      // The end of the control pipe asks it to quit (hosted.js), as its own q would.
      try {
        child.control.end();
      } catch {
        // Gone already.
      }
      this.setTimer(() => {
        if (s.child === child) child.kill(true);
      }, STOP_GRACE);
    }
    this.checkQuit();
    return this.done;
  }

  checkQuit() {
    if (this.spaces.some((s) => s.child)) return;
    this.input.off?.('data', this.onInput);
    this.output.off?.('resize', this.onResize);
    this.output.write(LEAVE);
    this.finish();
  }

  /** Stops every app at once, without waiting: for when the host itself is ending (they get SIGTERM). */
  killAll() {
    for (const s of this.spaces) {
      try {
        s.child?.kill(false);
      } catch {
        // Already gone.
      }
    }
  }
}
