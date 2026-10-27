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
// A space off screen whose app needs you gets a badge in its tab (attention.js), from the family's
// moods and activity, read every few seconds; the bell rings when one appears.
//
// Everything outside is injected: the terminal (`input`, `output` with columns, rows and 'resize'),
// starting an app (`spawn`), timers, the clock and the family's folder, so tests drive it with
// streams and small fake apps.
import { StringDecoder } from 'node:string_decoder';
import { familyDir } from '@fleet/kit/family.js';
import { encodeMessage, messageReader } from '@fleet/kit/hosted.js';
import { fit, stringWidth } from '@fleet/kit/text.js';
import { badgeFor, badgeText, familyReader } from './attention.js';
import { barLayout, colour, renderBar, tabAt } from './bar.js';
import { pasteFor, routeHandoff } from './handoff.js';
import { readKeys, takeBarClicks } from './keys.js';
import { HOST_MOUSE, MOUSE_MODES, OutputFilter } from './screen.js';
import { SPACES } from './spaces.js';
import { MIN_SPLIT_COLUMNS, splitLayout, takePaneMouse } from './split.js';
import { VirtualTerminal } from './vt.js';

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
// How often the family's moods and activity are read for the badges.
const ATTENTION_MS = 3000;

export const HELP = [
  ['alt+1-7', 'switch to that space'],
  ['ctrl+] 1-7', 'switch to that space'],
  ['ctrl+] s t o b h k w', 'Splice, Trawl, Sonar, Bosun, Hail, Keel, Wharf'],
  ['ctrl+] ] or n', 'next space'],
  ['ctrl+] p', 'previous space'],
  ['ctrl+] ctrl+]', 'send ctrl+] to the app'],
  ['ctrl+] q', 'quit Fleet and every app'],
  ['ctrl+] ?', 'this help'],
  ['ctrl+] | or \\', 'split: this app and the previous side by side'],
  ['ctrl+] tab ← →', 'the other pane'],
  ['ctrl+] x or |', 'one app on screen again'],
  ['', ''],
  ['a click on a tab', 'switches to it'],
  ['! or 2 in a tab', 'that app needs you (worried, alerts)'],
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
    now = () => Date.now(),
    familyHome = familyDir(),
    attentionEvery = ATTENTION_MS,
    bell = true,
  }) {
    Object.assign(this, { input, output, spawnApp: spawn, args, truecolor, onSwitch, onUpdate, setTimer, clearTimer, now, attentionEvery, bell });
    this.spaces = spaces.map((s) => ({ ...s, state: 'idle', code: null, child: null, filter: new OutputFilter(), ready: false, paste: null, stderr: '', badge: null }));
    this.family = familyReader(familyHome);
    // When each space was last on screen: what an app said before that is old news. Fleet starting
    // counts as a look at every space, so moods from before it never badge.
    const started = now();
    this.seen = Object.fromEntries(this.spaces.map((s) => [s.id, started]));
    this.attentionTimer = null;
    this.active = null;
    // The space on screen before the active one: what a split shows beside it.
    this.previous = null;
    // The split view (null when the screen is whole): { panes: [{ id, x, width, vt, drawn }], focus, modes }.
    this.split = null;
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
    this.watchAttention();
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
    const shown = this.split?.panes.find((p) => p.id !== this.active)?.id ?? null;
    this.layout = barLayout({ spaces: this.spaces, active: this.active, shown, width: columns, prefix: this.keys.prefix, notice: this.noticeText });
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

  // ---- attention --------------------------------------------------------------------------------

  /** The spaces on screen now, which never carry a badge. */
  onScreen() {
    return this.split ? this.split.panes.map((p) => p.id) : [this.active];
  }

  watchAttention() {
    if (!this.attentionEvery || this.quitting) return;
    this.attentionTimer = this.setTimer(() => {
      this.attentionTimer = null;
      this.checkAttention();
      this.watchAttention();
    }, this.attentionEvery);
  }

  /** Reads the family's folder and gives each space off screen its badge; the bell and a notice for a new one. */
  checkAttention() {
    if (this.quitting) return;
    const { moods, activity } = this.family.read(this.spaces.map((s) => s.id));
    const now = this.now();
    const shown = new Set(this.onScreen());
    let changed = false;
    let news = null;
    for (const s of this.spaces) {
      if (shown.has(s.id)) {
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
    if (!news) return changed && this.drawBar();
    // Once as it appears: the badge stays until you look, the bell doesn't.
    if (this.bell) this.output.write('\x07');
    this.notice(`${news.space.title}${news.badge.reason ? `: ${news.badge.reason}` : ' needs you'}`);
  }

  /** You looked at space `id`: its badge goes, and what it said so far is old news. */
  looked(id) {
    const space = this.space(id);
    this.seen[id] = this.now();
    if (space) space.badge = null;
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
      else if (a.type === 'split') this.toggleSplit();
      else if (a.type === 'unsplit') this.unsplit();
      else if (a.type === 'pane') this.otherPane();
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
    if (this.split) return this.deliverSplit(rest);
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
    // Whatever the one going off screen said so far, you saw.
    for (const shown of this.onScreen()) if (shown) this.looked(shown);
    if (this.active && this.active !== id) this.previous = this.active;
    if (this.split) return this.showInPane(space);
    this.active = id;
    this.looked(id);
    this.onSwitch(id);
    if (space.state === 'idle') this.launch(space);
    else this.redraw();
  }

  /** Draws the active space again from nothing: its own modes, then the app's whole frame. */
  redraw() {
    if (this.split) return this.redrawSplit();
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
    const { columns, rows } = this.appSize();
    this.output.write(this.exitedScreen(space, columns, rows));
    this.drawBar();
  }

  /** What an exited app's space shows, `columns`×`rows` from the top left corner: that it exited, and the end of its stderr. */
  exitedScreen(space, columns, rows) {
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
    return out;
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
    if (this.help) this.help = false;
    if (this.split) return this.resizedSplit();
    const size = this.appSize();
    // The others draw at the new size too, off screen, so they're right when they come back.
    for (const s of this.spaces) if (s.child && s.id !== this.active) this.tell(s, { resize: size });
    this.redraw();
  }

  // ---- the split view ---------------------------------------------------------------------------
  //
  // Split, two apps are on screen side by side, the focused one's (`active`) keys going to it. Neither
  // writes to the terminal: each draws into its pane's virtual terminal (vt.js), at its pane's size,
  // and the host copies the rows that changed into the pane's columns, then puts the cursor where the
  // focused app has it. Unsplit, the app on screen draws straight to the terminal again.

  paneOf(id) {
    return this.split?.panes.find((p) => p.id === id);
  }

  /** The size `space`'s app draws at: its pane's, else the whole screen above the bar. */
  sizeFor(space) {
    const pane = this.paneOf(space.id);
    return pane ? { columns: pane.width, rows: this.appSize().rows } : this.appSize();
  }

  toggleSplit() {
    if (this.split) this.unsplit();
    else this.splitScreen();
  }

  /** Splits the screen: the app on screen on the left, focused, and the previous one (else the next) on the right. */
  splitScreen() {
    const { columns, rows } = this.appSize();
    if (columns < MIN_SPLIT_COLUMNS) return this.notice(`Too narrow to split: ${columns} columns, at least ${MIN_SPLIT_COLUMNS}`);
    const i = this.spaces.findIndex((s) => s.id === this.active);
    const other = this.previous && this.previous !== this.active && this.space(this.previous) ? this.previous : this.spaces[(i + 1) % this.spaces.length].id;
    if (other === this.active) return this.notice('There is only one app to show');
    this.help = false;
    this.split = { panes: splitLayout(columns).map((p, k) => ({ ...p, id: k ? other : this.active, vt: new VirtualTerminal(p.width, rows), drawn: [] })), focus: 0, modes: '' };
    this.looked(other);
    for (const pane of this.split.panes) this.fillPane(pane);
    this.redrawSplit();
  }

  /** Puts the screen back whole, for the focused app; the other goes off screen at the whole size. */
  unsplit() {
    if (!this.split) return;
    const panes = this.split.panes;
    this.split = null;
    this.help = false;
    for (const p of panes) if (p.id !== this.active) this.tell(this.space(p.id), { resize: this.appSize() });
    const space = this.space(this.active);
    // A new size: the app draws its whole frame at it by itself, and redraw's repaint is one too many.
    this.output.write(CLEAR + this.modesOf(space));
    if (space.child) this.tell(space, { resize: this.appSize() });
    else if (space.state === 'exited') return this.drawExited(space);
    this.drawBar();
  }

  /** Focuses the other pane. */
  otherPane() {
    if (!this.split) return this.notice('ctrl+] | splits the screen');
    this.focusPane(1 - this.split.focus);
  }

  focusPane(index) {
    const pane = this.split.panes[index];
    if (!pane || index === this.split.focus) return;
    this.split.focus = index;
    if (this.active !== pane.id) this.previous = this.active;
    this.active = pane.id;
    this.looked(pane.id);
    this.onSwitch(pane.id);
    this.redrawSplit();
  }

  /** Puts `space` on screen while split: focuses its pane when it has one, else it takes the focused pane's place. */
  showInPane(space) {
    const index = this.split.panes.findIndex((p) => p.id === space.id);
    if (index >= 0) {
      this.split.focus = index;
    } else {
      const pane = this.split.panes[this.split.focus];
      const gone = this.space(pane.id);
      pane.id = space.id;
      // The app leaving the screen draws at the whole size again, ready for when it comes back.
      if (gone?.child) this.tell(gone, { resize: this.appSize() });
      pane.vt = new VirtualTerminal(pane.width, this.appSize().rows);
      pane.drawn = [];
      this.fillPane(pane);
    }
    this.active = space.id;
    this.looked(space.id);
    this.onSwitch(space.id);
    this.redrawSplit();
  }

  /** Has the app of a pane draw into it from nothing: started, asked for its frame at the pane's size, or its exit said. */
  fillPane(pane) {
    const space = this.space(pane.id);
    if (space.state === 'idle') this.launch(space);
    else if (space.child) this.tell(space, { resize: this.sizeFor(space) });
    else if (space.state === 'exited') this.exitedInPane(space, pane);
  }

  exitedInPane(space, pane) {
    pane.vt.reset();
    pane.vt.write(this.exitedScreen(space, pane.width, this.appSize().rows));
  }

  /** The terminal's modes for `space`: its own while it runs, none of its mouse once it has exited. */
  modesOf(space) {
    return space.child ? space.filter.restoreModes() : new OutputFilter().restoreModes();
  }

  resizedSplit() {
    const { columns, rows } = this.appSize();
    if (columns < MIN_SPLIT_COLUMNS) {
      this.unsplit();
      return this.notice(`Too narrow to stay split: ${columns} columns, at least ${MIN_SPLIT_COLUMNS}`);
    }
    const layout = splitLayout(columns);
    this.split.panes.forEach((pane, k) => Object.assign(pane, layout[k], { vt: new VirtualTerminal(layout[k].width, rows), drawn: [] }));
    const shown = new Set(this.onScreen());
    for (const s of this.spaces) if (s.child && !shown.has(s.id)) this.tell(s, { resize: this.appSize() });
    for (const pane of this.split.panes) this.fillPane(pane);
    this.redrawSplit();
  }

  /** Draws the split screen again from the panes' virtual terminals: the divider, every row, the bar. */
  redrawSplit() {
    const space = this.space(this.active);
    this.split.modes = this.modesOf(space);
    this.output.write(CLEAR + this.split.modes);
    for (const pane of this.split.panes) {
      pane.drawn = [];
      pane.vt.dirty.fill(true);
    }
    this.drawDivider();
    for (const pane of this.split.panes) this.flushPane(pane, { force: true });
    this.drawBar();
  }

  drawDivider() {
    const { panes, focus } = this.split;
    const accent = colour(this.space(panes[focus].id).accent, { truecolor: this.truecolor });
    const x = panes[0].width + 1;
    let out = `\x1b[0m${accent}`;
    for (let y = 1; y <= this.appSize().rows; y++) out += `\x1b[${y};${x}H│`;
    this.output.write(`${out}\x1b[0m`);
  }

  /** Copies the rows of `pane` that changed to the screen, in one synchronized update, and puts the focused app's cursor back. */
  flushPane(pane, { force = false } = {}) {
    if (this.help || (pane.vt.sync && !force)) return;
    let out = '';
    for (const y of pane.vt.takeDirty()) {
      const row = pane.vt.rowAnsi(y);
      if (row === pane.drawn[y]) continue;
      pane.drawn[y] = row;
      out += `\x1b[${y + 1};${pane.x + 1}H${row}`;
    }
    if (!out) return;
    const focused = this.split.panes[this.split.focus];
    const { vt } = focused;
    const cursor = `\x1b[${vt.y + 1};${focused.x + vt.x + 1}H${vt.cursorShown() ? '\x1b[?25h' : '\x1b[?25l'}`;
    this.output.write(`\x1b[?2026h\x1b[?25l${out}${cursor}\x1b[?2026l`);
  }

  /** What an app in a pane drew: into its virtual terminal, and the rows it changed to the screen. */
  fromPane(space, pane, text) {
    const out = space.filter.push(text, { active: true });
    if (!out) return;
    // The bell, the clipboard and notifications are the terminal's, whichever pane they came from.
    const said = pane.vt.write(out);
    if (said) this.output.write(said);
    if (pane.id === this.active) {
      // The focused app turned its mouse or bracketed paste on or off.
      const modes = space.filter.restoreModes();
      if (modes !== this.split.modes) {
        this.split.modes = modes;
        if (!this.help) this.output.write(modes);
      }
    }
    this.flushPane(pane);
  }

  /** Keys to the focused app; mouse reports to the app under the pointer (if it asked for them), a click there focusing it. */
  deliverSplit(data) {
    const { data: keys, reports } = takePaneMouse(data, this.split.panes);
    for (const r of reports) {
      if (r.press && r.pane !== this.split.focus) this.focusPane(r.pane);
      const space = this.space(this.split.panes[r.pane].id);
      if (space.child && space.filter.wantsMouse()) space.child.stdin.write(r.data);
    }
    if (!keys) return;
    const space = this.space(this.active);
    if (space.child) space.child.stdin.write(keys);
    else if (/\r/.test(keys)) this.launch(space);
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
    const pane = this.paneOf(space.id);
    // Started again in a pane, it draws on a blank one: its alternate screen, which would clear it, never reaches it.
    if (pane) {
      pane.vt.reset();
      this.flushPane(pane);
    }
    try {
      child = this.spawnApp(space.id, { ...this.sizeFor(space), args: this.args[space.id] ?? [] });
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
    if (space.id === this.active && !this.split) this.output.write(CLEAR + space.filter.restoreModes());
    else if (space.id === this.active && !this.help) this.output.write((this.split.modes = space.filter.restoreModes()));
    this.drawBar();
  }

  fromApp(space, child, text) {
    if (space.child !== child || !text) return;
    const pane = this.paneOf(space.id);
    if (pane) return this.fromPane(space, pane, text);
    const active = space.id === this.active && !this.help && !this.split;
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
    // Split, the app it goes to takes the other pane, so the one it came from stays in sight.
    const origin = this.split?.panes.findIndex((p) => p.id === from.id) ?? -1;
    if (origin >= 0 && !this.paneOf(to.id)) this.split.focus = 1 - origin;
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
    const pane = this.paneOf(space.id);
    if (pane) {
      this.exitedInPane(space, pane);
      if (space.id === this.active && !this.help) this.output.write((this.split.modes = this.modesOf(space)));
      this.flushPane(pane);
      this.drawBar();
    } else if (space.id === this.active && !this.help) {
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
    if (this.attentionTimer) this.clearTimer(this.attentionTimer);
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
    // Nothing is looked at any more either.
    if (this.attentionTimer) this.clearTimer(this.attentionTimer);
    this.attentionEvery = 0;
    for (const s of this.spaces) {
      try {
        s.child?.kill(false);
      } catch {
        // Already gone.
      }
    }
  }
}
