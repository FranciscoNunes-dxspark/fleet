// A virtual terminal, for the split view: there two apps share the screen, side by side, and neither
// can write to it as it does alone (each draws as if its pane were the whole screen, from the top left
// corner), so each pane's app draws into one of these instead and the host copies its rows to their
// columns (host.js). It keeps what's on the screen as cells, a character and its style each, from
// what Ink and the apps write: text (wide characters and graphemes measured as the kit's text.js
// does), the tty's \n → \r\n, cursor movement, erasing, inserting and deleting, scrolling and its
// region, saving the cursor, SGR colours (16, 256 and 24-bit) and attributes, private modes (the cursor
// and synchronized updates are what the host reads). What isn't drawing but the terminal's to act on
// (the bell, the clipboard's OSC 52, notifications, titles) comes back from `write` for the host to
// pass on; what only makes sense on a whole screen (hyperlinks, colour queries, DCS) is dropped.
import { stringWidth } from '@fleet/kit/text.js';

const segmenter = new Intl.Segmenter();

// The OSC sequences passed on: titles (0, 1, 2), notifications (9, 777) and the clipboard (52).
const PASSED_OSC = new Set(['0', '1', '2', '9', '52', '777']);

// A sequence that never ends (a cut or broken one) is given up after this many characters.
const MAX_SEQUENCE = 4096;

const plain = () => ({ bold: false, dim: false, italic: false, underline: false, blink: false, inverse: false, hidden: false, strike: false, fg: '', bg: '' });

/** The SGR parameters of a style, '' for none: what a cell keeps, and what drawing it sets. */
function styleKey(a) {
  let k = '';
  const add = (p) => (k = k ? `${k};${p}` : p);
  if (a.bold) add('1');
  if (a.dim) add('2');
  if (a.italic) add('3');
  if (a.underline) add('4');
  if (a.blink) add('5');
  if (a.inverse) add('7');
  if (a.hidden) add('8');
  if (a.strike) add('9');
  if (a.fg) add(a.fg);
  if (a.bg) add(a.bg);
  return k;
}

// Whether a cell's character takes two columns (only ever one outside ASCII).
const wide = (ch) => ch.length > 1 || ch.charCodeAt(0) > 0x7e ? stringWidth(ch) === 2 : false;

export class VirtualTerminal {
  constructor(columns, rows) {
    this.state = 'ground';
    this.seq = '';
    this.resize(columns, rows);
  }

  /** A new screen of `columns`×`rows`, blank, the cursor home and the modes kept. */
  resize(columns, rows) {
    this.columns = Math.max(1, columns);
    this.rows = Math.max(1, rows);
    this.chars = Array.from({ length: this.rows }, () => Array(this.columns).fill(' '));
    this.styles = Array.from({ length: this.rows }, () => Array(this.columns).fill(''));
    this.dirty = Array(this.rows).fill(true);
    this.x = 0;
    this.y = 0;
    this.wrapNext = false;
    this.attrs = plain();
    this.style = '';
    this.top = 0;
    this.bottom = this.rows - 1;
    this.saved = null;
    this.modes ??= new Map();
    this.sync = false;
  }

  /** Back to how it started: a blank screen, every mode off. */
  reset() {
    this.modes = new Map();
    this.resize(this.columns, this.rows);
  }

  /** Takes `data` as a terminal would; returns what the real terminal should still get (the bell, the clipboard…). */
  write(data) {
    const s = String(data);
    let out = '';
    let i = 0;
    while (i < s.length) {
      if (this.state === 'ground') {
        let j = i;
        while (j < s.length) {
          const c = s.charCodeAt(j);
          if (c < 0x20 || c === 0x7f) break;
          j++;
        }
        if (j > i) {
          this.print(s.slice(i, j));
          i = j;
          continue;
        }
        const c = s[i++];
        if (c === '\x1b') {
          this.state = 'esc';
          this.seq = '';
        } else if (c === '\r') {
          this.x = 0;
          this.wrapNext = false;
        } else if (c === '\n' || c === '\v' || c === '\f') {
          // A terminal behind a tty still turns \n into \r\n (ONLCR), and Ink counts on it.
          this.lineFeed();
          this.x = 0;
        } else if (c === '\b') {
          this.x = Math.max(0, this.x - 1);
          this.wrapNext = false;
        } else if (c === '\t') this.x = Math.min(this.columns - 1, (Math.floor(this.x / 8) + 1) * 8);
        else if (c === '\x07') out += c;
        continue;
      }
      const c = s[i++];
      if (this.seq.length > MAX_SEQUENCE) this.state = 'ground';
      switch (this.state) {
        case 'esc':
          if (c === '[') {
            this.state = 'csi';
            this.seq = '';
          } else if (c === ']') {
            this.state = 'osc';
            this.seq = '';
          } else if (c === 'P' || c === '_' || c === '^' || c === 'X') this.state = 'skip';
          else if (c === '\x1b') this.state = 'esc';
          else if (c >= ' ' && c <= '/') this.state = 'escInter';
          else {
            this.state = 'ground';
            this.escape(c);
          }
          break;
        case 'escInter':
          if (!(c >= ' ' && c <= '/')) this.state = 'ground';
          break;
        case 'csi':
          if (c >= '@' && c <= '~') {
            this.state = 'ground';
            this.csi(this.seq, c);
          } else if (c === '\x1b') {
            // A sequence cut short by another.
            this.state = 'esc';
            this.seq = '';
          } else this.seq += c;
          break;
        case 'osc':
          if (c === '\x07') {
            this.state = 'ground';
            out += this.osc(this.seq, c);
          } else if (c === '\x1b') this.state = 'oscEsc';
          else this.seq += c;
          break;
        case 'oscEsc':
          this.state = 'ground';
          out += this.osc(this.seq, '\x1b\\');
          // ESC and anything but \ ends the string and starts a sequence of its own.
          if (c !== '\\') {
            this.state = 'esc';
            i--;
          }
          break;
        case 'skip':
          if (c === '\x1b') this.state = 'skipEsc';
          break;
        case 'skipEsc':
          this.state = c === '\\' ? 'ground' : 'skip';
          break;
      }
    }
    return out;
  }

  osc(body, end) {
    const code = body.slice(0, body.indexOf(';') >>> 0);
    return PASSED_OSC.has(code) ? `\x1b]${body}${end}` : '';
  }

  // ---- text -------------------------------------------------------------------------------------

  print(text) {
    if (/^[\x20-\x7e]*$/.test(text)) {
      for (let k = 0; k < text.length; k++) this.put(text[k], 1);
      return;
    }
    for (const { segment } of segmenter.segment(text)) {
      const w = stringWidth(segment);
      if (w === 0) {
        // A mark that joins the character before it.
        const x = this.wrapNext ? this.x : this.x - 1;
        if (x >= 0 && this.chars[this.y][x]) this.chars[this.y][x] += segment;
        continue;
      }
      this.put(segment, Math.min(2, w));
    }
  }

  put(ch, w) {
    if (w > this.columns) return;
    if (this.wrapNext || this.x + w > this.columns) {
      if (this.x + w > this.columns && !this.wrapNext) this.setCell(this.y, this.x, ' ', this.style);
      this.x = 0;
      this.wrapNext = false;
      this.lineFeed();
    }
    const { x, y } = this;
    this.unwide(y, x);
    if (w === 2) this.unwide(y, x + 1);
    this.chars[y][x] = ch;
    this.styles[y][x] = this.style;
    if (w === 2) {
      this.chars[y][x + 1] = '';
      this.styles[y][x + 1] = this.style;
    }
    this.dirty[y] = true;
    this.x += w;
    if (this.x >= this.columns) {
      this.x = this.columns - 1;
      this.wrapNext = true;
    }
  }

  setCell(y, x, ch, style) {
    if (x < 0 || x >= this.columns) return;
    this.chars[y][x] = ch;
    this.styles[y][x] = style;
    this.dirty[y] = true;
  }

  // Writing over half of a wide character leaves its other half blank.
  unwide(y, x) {
    if (x >= this.columns) return;
    const row = this.chars[y];
    if (row[x] === '' && x > 0) row[x - 1] = ' ';
    if (x + 1 < this.columns && row[x + 1] === '') row[x + 1] = ' ';
  }

  // ---- lines and scrolling ----------------------------------------------------------------------

  lineFeed() {
    this.wrapNext = false;
    if (this.y === this.bottom) this.scrollUp(1);
    else if (this.y < this.rows - 1) this.y++;
  }

  blankRow() {
    return [Array(this.columns).fill(' '), Array(this.columns).fill(this.eraseStyle())];
  }

  // Erasing paints the background colour in use, as terminals do (bce).
  eraseStyle() {
    return this.attrs.bg;
  }

  /** Moves the rows of the scroll region (or from `top`) up `n`, blank rows coming in at its bottom. */
  scrollUp(n, top = this.top) {
    const bottom = this.bottom;
    if (top > bottom) return;
    n = Math.min(n, bottom - top + 1);
    for (let k = 0; k < n; k++) {
      this.chars.splice(top, 1);
      this.styles.splice(top, 1);
      const [c, s] = this.blankRow();
      this.chars.splice(bottom, 0, c);
      this.styles.splice(bottom, 0, s);
    }
    for (let y = top; y <= bottom; y++) this.dirty[y] = true;
  }

  scrollDown(n, top = this.top) {
    const bottom = this.bottom;
    if (top > bottom) return;
    n = Math.min(n, bottom - top + 1);
    for (let k = 0; k < n; k++) {
      this.chars.splice(bottom, 1);
      this.styles.splice(bottom, 1);
      const [c, s] = this.blankRow();
      this.chars.splice(top, 0, c);
      this.styles.splice(top, 0, s);
    }
    for (let y = top; y <= bottom; y++) this.dirty[y] = true;
  }

  erase(y, from, to) {
    const style = this.eraseStyle();
    from = Math.max(0, from);
    to = Math.min(this.columns, to);
    if (from >= to) return;
    if (from > 0 && this.chars[y][from] === '') this.chars[y][from - 1] = ' ';
    if (to < this.columns && this.chars[y][to] === '') this.chars[y][to] = ' ';
    this.chars[y].fill(' ', from, to);
    this.styles[y].fill(style, from, to);
    this.dirty[y] = true;
  }

  // ---- escape sequences -------------------------------------------------------------------------

  escape(c) {
    if (c === '7') this.saved = { x: this.x, y: this.y, attrs: { ...this.attrs }, wrapNext: this.wrapNext };
    else if (c === '8') this.restoreCursor();
    else if (c === 'c') this.reset();
    else if (c === 'D') this.lineFeed();
    else if (c === 'E') {
      this.lineFeed();
      this.x = 0;
    } else if (c === 'M') {
      this.wrapNext = false;
      if (this.y === this.top) this.scrollDown(1);
      else if (this.y > 0) this.y--;
    }
  }

  restoreCursor() {
    if (!this.saved) {
      this.x = 0;
      this.y = 0;
      return;
    }
    this.x = Math.min(this.saved.x, this.columns - 1);
    this.y = Math.min(this.saved.y, this.rows - 1);
    this.attrs = { ...this.saved.attrs };
    this.style = styleKey(this.attrs);
    this.wrapNext = this.saved.wrapNext;
  }

  csi(params, final) {
    const priv = /^[?<>=]/.test(params) ? params[0] : '';
    const body = priv ? params.slice(1) : params;
    if (final === 'm' && !priv) return this.sgr(body);
    const ps = body.split(';').map((p) => (p === '' ? undefined : parseInt(p, 10)));
    if (priv === '?') {
      if (final !== 'h' && final !== 'l') return;
      const on = final === 'h';
      for (const p of ps) {
        if (p === undefined || Number.isNaN(p)) continue;
        this.modes.set(p, on);
        if (p === 2026) this.sync = on;
      }
      return;
    }
    if (priv || /[ -/]/.test(body)) return;
    const n = Math.max(1, ps[0] || 1);
    const clampY = (y) => Math.max(0, Math.min(this.rows - 1, y));
    const clampX = (x) => Math.max(0, Math.min(this.columns - 1, x));
    this.wrapNext = false;
    switch (final) {
      case 'A':
        this.y = clampY(this.y - n);
        break;
      case 'B':
      case 'e':
        this.y = clampY(this.y + n);
        break;
      case 'C':
      case 'a':
        this.x = clampX(this.x + n);
        break;
      case 'D':
        this.x = clampX(this.x - n);
        break;
      case 'E':
        this.y = clampY(this.y + n);
        this.x = 0;
        break;
      case 'F':
        this.y = clampY(this.y - n);
        this.x = 0;
        break;
      case 'G':
      case '`':
        this.x = clampX(n - 1);
        break;
      case 'd':
        this.y = clampY(n - 1);
        break;
      case 'H':
      case 'f':
        this.y = clampY((ps[0] || 1) - 1);
        this.x = clampX((ps[1] || 1) - 1);
        break;
      case 'J': {
        const mode = ps[0] ?? 0;
        if (mode === 0) {
          this.erase(this.y, this.x, this.columns);
          for (let y = this.y + 1; y < this.rows; y++) this.erase(y, 0, this.columns);
        } else if (mode === 1) {
          this.erase(this.y, 0, this.x + 1);
          for (let y = 0; y < this.y; y++) this.erase(y, 0, this.columns);
        } else if (mode === 2) for (let y = 0; y < this.rows; y++) this.erase(y, 0, this.columns);
        // 3 is the scrollback, which a pane hasn't got.
        break;
      }
      case 'K': {
        const mode = ps[0] ?? 0;
        if (mode === 0) this.erase(this.y, this.x, this.columns);
        else if (mode === 1) this.erase(this.y, 0, this.x + 1);
        else if (mode === 2) this.erase(this.y, 0, this.columns);
        break;
      }
      case 'X':
        this.erase(this.y, this.x, this.x + n);
        break;
      case '@': {
        const row = this.chars[this.y];
        const st = this.styles[this.y];
        const k = Math.min(n, this.columns - this.x);
        row.splice(this.x, 0, ...Array(k).fill(' '));
        st.splice(this.x, 0, ...Array(k).fill(this.eraseStyle()));
        row.length = st.length = this.columns;
        this.dirty[this.y] = true;
        break;
      }
      case 'P': {
        const row = this.chars[this.y];
        const st = this.styles[this.y];
        const k = Math.min(n, this.columns - this.x);
        row.splice(this.x, k);
        st.splice(this.x, k);
        row.push(...Array(k).fill(' '));
        st.push(...Array(k).fill(this.eraseStyle()));
        this.dirty[this.y] = true;
        break;
      }
      case 'L':
        if (this.y >= this.top && this.y <= this.bottom) this.scrollDown(n, this.y);
        this.x = 0;
        break;
      case 'M':
        if (this.y >= this.top && this.y <= this.bottom) this.scrollUp(n, this.y);
        this.x = 0;
        break;
      case 'S':
        this.scrollUp(n);
        break;
      case 'T':
        this.scrollDown(n);
        break;
      case 'r': {
        const top = (ps[0] || 1) - 1;
        const bottom = (ps[1] || this.rows) - 1;
        if (top < bottom && bottom < this.rows) {
          this.top = top;
          this.bottom = bottom;
          this.x = 0;
          this.y = 0;
        }
        break;
      }
      case 's':
        this.escape('7');
        break;
      case 'u':
        this.restoreCursor();
        break;
      default:
        break;
    }
  }

  sgr(body) {
    const a = this.attrs;
    const parts = body === '' ? ['0'] : body.split(';');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.includes(':')) {
        // The colon form: 38:2::r:g:b (or 38:2:r:g:b), 38:5:n, 4:3 (an underline style).
        const sub = part.split(':');
        const code = Number(sub[0]);
        if (code === 4) a.underline = sub[1] !== '0';
        else if (code === 38 || code === 48) {
          const colour = sub[1] === '5' ? `${code};5;${Number(sub[2]) || 0}` : sub[1] === '2' ? `${code};2;${sub.slice(-3).map((v) => Number(v) || 0).join(';')}` : '';
          if (colour) a[code === 38 ? 'fg' : 'bg'] = colour;
        }
        continue;
      }
      const code = part === '' ? 0 : Number(part);
      if (code === 38 || code === 48 || code === 58) {
        let colour = '';
        if (parts[i + 1] === '5') {
          colour = `${code};5;${Number(parts[i + 2]) || 0}`;
          i += 2;
        } else if (parts[i + 1] === '2') {
          colour = `${code};2;${[parts[i + 2], parts[i + 3], parts[i + 4]].map((v) => Number(v) || 0).join(';')}`;
          i += 4;
        }
        if (colour && code !== 58) a[code === 38 ? 'fg' : 'bg'] = colour;
        continue;
      }
      if (code === 0) Object.assign(a, plain());
      else if (code === 1) a.bold = true;
      else if (code === 2) a.dim = true;
      else if (code === 3) a.italic = true;
      else if (code === 4 || code === 21) a.underline = true;
      else if (code === 5 || code === 6) a.blink = true;
      else if (code === 7) a.inverse = true;
      else if (code === 8) a.hidden = true;
      else if (code === 9) a.strike = true;
      else if (code === 22) a.bold = a.dim = false;
      else if (code === 23) a.italic = false;
      else if (code === 24) a.underline = false;
      else if (code === 25) a.blink = false;
      else if (code === 27) a.inverse = false;
      else if (code === 28) a.hidden = false;
      else if (code === 29) a.strike = false;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) a.fg = String(code);
      else if (code === 39) a.fg = '';
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) a.bg = String(code);
      else if (code === 49) a.bg = '';
    }
    this.style = styleKey(a);
  }

  // ---- reading it -------------------------------------------------------------------------------

  /** Row `y` as ANSI text from its first column, every cell of it, ending with the style reset. */
  rowAnsi(y) {
    const chars = this.chars[y];
    const styles = this.styles[y];
    let out = '\x1b[0m';
    let style = '';
    let carried = false; // the cell before was a wide character's first half
    for (let x = 0; x < this.columns; x++) {
      let ch = chars[x];
      if (ch === '') {
        if (carried) {
          carried = false;
          continue;
        }
        ch = ' ';
      } else if (wide(ch)) {
        // A wide character with its second half gone (or no room for it) draws as a blank.
        if (x + 1 < this.columns && chars[x + 1] === '') carried = true;
        else ch = ' ';
      } else carried = false;
      if (styles[x] !== style) {
        style = styles[x];
        out += style ? `\x1b[0;${style}m` : '\x1b[0m';
      }
      out += ch;
    }
    return `${out}\x1b[0m`;
  }

  /** Row `y` as plain text, trailing blanks off (for tests). */
  rowText(y) {
    return this.chars[y].join('').replace(/\s+$/, '');
  }

  /** The rows drawn on since the last call, and none after it. */
  takeDirty() {
    const out = [];
    for (let y = 0; y < this.rows; y++) {
      if (!this.dirty[y]) continue;
      out.push(y);
      this.dirty[y] = false;
    }
    return out;
  }

  /** Whether the app's cursor is showing (it hid it with ?25l). */
  cursorShown() {
    return this.modes.get(25) !== false;
  }
}
