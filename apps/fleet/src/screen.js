// What an app draws, on its way to the real terminal, pure. The host passes the app's output through
// as it came, except for what would break the screen it shares: the alternate screen (the host is on
// it already, and an app leaving it would take the host's screen with it), the title stack, and a full
// reset. It also keeps the modes the app set (the mouse, the cursor, bracketed paste) to set them
// again when the app comes back on screen, and finds where the bar can be drawn again without
// cutting into anything: after a whole frame (just before a synchronized update ends, or at the end of
// what came when nothing is left open), never inside an escape sequence or a saved cursor. The app's
// messages to the host (the kit's hosted.js: an OSC 5379 sequence) are taken out and handed to
// `onMessage`, on screen or not.
import { decodeAppMessage } from '@fleet/kit/hosted.js';

/** The private modes kept per app, and what "off" is for each when none was set. */
export const MOUSE_MODES = [9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016];
const KEPT = new Set([...MOUSE_MODES, 25, 1004, 2004]);
const DROPPED = new Set([47, 1047, 1048, 1049]);

/**
 * The mouse the host keeps on whatever the app does (clicks, as SGR reports), so a click on the bar
 * always arrives: an app that has the mouse off, or has exited, can't take the bar's clicks with it.
 * The host passes mouse reports on only to an app that asked for them (`wantsMouse`).
 */
const HOST_MOUSE_MODES = new Set([1000, 1006]);
export const HOST_MOUSE = '\x1b[?1000h\x1b[?1006h';
const REPORTING = [9, 1000, 1002, 1003];

const ESC = '\x1b';

/** A synchronized update's end (DEC private mode 2026, reset). */
export const SYNC_END = '\x1b[?2026l';

export class OutputFilter {
  constructor({ onMessage = () => {} } = {}) {
    this.onMessage = onMessage;
    this.state = 'ground';
    this.seq = '';
    this.modes = new Map();
    this.sync = false; // inside a synchronized update
    this.saved = false; // between the app's own save cursor (ESC 7) and restore (ESC 8)
  }

  /**
   * Passes `text` through: returns what to write to the terminal, with `bar` (a string: the bar, drawn
   * from a saved cursor) put in at the safe points once something was drawn since it last was, or ''
   * when `active` is false (the app is off screen: only its modes are kept).
   */
  push(text, { active = true, bar = '' } = {}) {
    let out = '';
    let from = 0; // start of the ground text not yet copied out
    let fresh = false; // drawn since the bar was last put in
    const emit = (s) => {
      if (!s) return;
      fresh = true;
      if (active) out += s;
    };
    const emitBar = () => {
      fresh = false;
      if (active) out += bar;
    };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      switch (this.state) {
        case 'ground':
          if (ch === ESC) {
            emit(text.slice(from, i));
            this.state = 'esc';
            this.seq = ch;
          }
          break;
        case 'esc':
          this.seq += ch;
          if (ch === '[') this.state = 'csi';
          else if (ch === ']' || ch === 'P' || ch === '_' || ch === '^' || ch === 'X') this.state = 'string';
          else if (ch >= ' ' && ch <= '/') this.state = 'escInter';
          else this.finish(this.escape(ch), emit, i);
          break;
        case 'escInter':
          this.seq += ch;
          if (!(ch >= ' ' && ch <= '/')) this.finish(this.seq, emit, i);
          break;
        case 'csi':
          this.seq += ch;
          if (ch >= '@' && ch <= '~') {
            const { endsFrame, seq } = this.csi(this.seq);
            // The bar goes into the end of the app's frame, so the terminal shows them together.
            if (endsFrame && bar) emitBar();
            this.finish(seq, emit, i);
            if (endsFrame && bar) fresh = false;
          }
          break;
        case 'string':
          this.seq += ch;
          if (ch === '\x07') this.finish(this.message(this.seq), emit, i);
          else if (ch === ESC) this.state = 'stringEsc';
          break;
        case 'stringEsc':
          this.seq += ch;
          if (ch === '\\') this.finish(this.message(this.seq), emit, i);
          else this.state = ch === ESC ? 'stringEsc' : 'string';
          break;
      }
      if (this.state === 'ground' && this.done) {
        from = i + 1;
        this.done = false;
      }
    }
    if (this.state === 'ground') emit(text.slice(from));
    // A whole frame has come and nothing is left open: the bar again, over whatever the frame cleared.
    if (fresh && this.state === 'ground' && !this.sync && !this.saved && bar) emitBar();
    return out;
  }

  finish(replacement, emit) {
    emit(replacement);
    this.state = 'ground';
    this.seq = '';
    this.done = true;
  }

  // A whole string sequence (OSC and the like): the app's message to the host goes no further.
  message(seq) {
    const message = decodeAppMessage(seq);
    if (!message) return seq;
    this.onMessage(message);
    return '';
  }

  // ESC and one character: save and restore the cursor are tracked, a full reset (ESC c) is dropped.
  escape(ch) {
    if (ch === 'c') return '';
    if (ch === '7') this.saved = true;
    if (ch === '8') this.saved = false;
    return this.seq;
  }

  // A whole CSI sequence: { seq, endsFrame }, `seq` what goes on to the terminal in its place.
  csi(seq) {
    const m = /^\x1b\[\?([\d;]*)([hl])$/.exec(seq);
    if (m) {
      const on = m[2] === 'h';
      const kept = [];
      let endsFrame = false;
      for (const n of m[1].split(';').filter(Boolean).map(Number)) {
        if (DROPPED.has(n)) continue;
        if (n === 2026) {
          endsFrame = !on && this.sync && !this.saved;
          this.sync = on;
        }
        if (KEPT.has(n)) this.modes.set(n, on);
        // The app turning these off turns its reports off (wantsMouse), not the terminal's.
        if (!on && HOST_MOUSE_MODES.has(n)) continue;
        kept.push(n);
      }
      return { endsFrame, seq: kept.length ? `\x1b[?${kept.join(';')}${m[2]}` : '' };
    }
    // The title stack (push 22, pop 23): the host keeps the terminal's title, not each app.
    if (/^\x1b\[2[23](;\d*)*t$/.test(seq)) return { seq: '' };
    return { seq };
  }

  /** Whether the app asked for mouse reports (the host's own mouse is only for the bar). */
  wantsMouse() {
    return REPORTING.some((n) => this.modes.get(n));
  }

  /** What sets the terminal's modes the way this app left them, from whatever another app left, and the host's mouse. */
  restoreModes() {
    let out = MOUSE_MODES.map((n) => `\x1b[?${n}l`).join('') + '\x1b[?1004l\x1b[?2004l';
    for (const [n, on] of this.modes) if (n !== 25 && on) out += `\x1b[?${n}h`;
    out += HOST_MOUSE;
    out += this.modes.get(25) === false ? '\x1b[?25l' : '\x1b[?25h';
    return out;
  }
}
