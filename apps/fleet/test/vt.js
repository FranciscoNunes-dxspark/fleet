// A small terminal for the tests: enough of VT100 and xterm to show what the host and the apps draw
// (text, cursor moves, erasing, saving the cursor, wide characters), as rows of text, with the tty's
// \n → \r\n. Colours are read and left out, private modes kept in `modes`; scrolling at the bottom
// moves the rows up.
import { stringWidth } from '@fleet/kit/text.js';

export class Screen {
  constructor(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    this.lines = Array.from({ length: rows }, () => this.blank());
    this.x = 0;
    this.y = 0;
    this.saved = { x: 0, y: 0 };
    this.held = '';
    this.wrapNext = false;
    this.modes = new Map();
  }

  blank() {
    return Array(this.columns).fill(' ');
  }

  resize(columns, rows) {
    this.columns = columns;
    this.rows = rows;
    this.lines = Array.from({ length: rows }, () => this.blank());
    this.x = Math.min(this.x, columns - 1);
    this.y = Math.min(this.y, rows - 1);
  }

  newline() {
    this.wrapNext = false;
    if (this.y === this.rows - 1) {
      this.lines.shift();
      this.lines.push(this.blank());
    } else this.y++;
  }

  put(ch) {
    const w = Math.max(1, stringWidth(ch));
    if (this.wrapNext || this.x + w > this.columns) {
      this.x = 0;
      this.newline();
    }
    this.lines[this.y][this.x] = ch;
    if (w === 2 && this.x + 1 < this.columns) this.lines[this.y][this.x + 1] = '';
    this.x += w;
    if (this.x >= this.columns) {
      this.x = this.columns - 1;
      this.wrapNext = true;
    }
  }

  /** Feeds output to the screen; a sequence cut at the end waits for the rest. */
  write(data) {
    const s = this.held + String(data);
    this.held = '';
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\x1b') {
        const m = /^\x1b(?:\[([?<>=]?)([\d;:]*)([ -\/]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[P_^X][^\x1b]*\x1b\\|[()][\x20-\x7e]|[78cDEMH=>NO])/.exec(s.slice(i));
        if (!m) {
          if (s.length - i < 64) this.held = s.slice(i);
          else i++;
          if (this.held) break;
          continue;
        }
        if (m[4]) this.csi(m[1], m[2], m[4]);
        else if (m[0] === '\x1b7') this.saved = { x: this.x, y: this.y };
        else if (m[0] === '\x1b8') ({ x: this.x, y: this.y } = this.saved);
        else if (m[0] === '\x1bc') this.resize(this.columns, this.rows);
        else if (m[0] === '\x1bM') this.y = Math.max(0, this.y - 1);
        i += m[0].length;
        continue;
      }
      const cp = s.codePointAt(i);
      const char = String.fromCodePoint(cp);
      i += char.length;
      if (ch === '\r') {
        this.x = 0;
        this.wrapNext = false;
      } else if (ch === '\n') {
        // A terminal behind a tty in raw mode still turns \n into \r\n (ONLCR), and Ink counts on it.
        this.newline();
        this.x = 0;
      }
      else if (ch === '\b') this.x = Math.max(0, this.x - 1);
      else if (cp >= 0x20 && cp !== 0x7f) this.put(char);
    }
  }

  csi(priv, params, final) {
    const ps = params.split(';').map((p) => (p === '' ? undefined : Number(p)));
    const n = ps[0] ?? 1;
    this.wrapNext = false;
    if (priv === '?') {
      for (const p of ps) this.modes.set(p, final === 'h');
      return;
    }
    if (priv) return;
    const clampY = (y) => Math.max(0, Math.min(this.rows - 1, y));
    const clampX = (x) => Math.max(0, Math.min(this.columns - 1, x));
    switch (final) {
      case 'A':
        this.y = clampY(this.y - n);
        break;
      case 'B':
        this.y = clampY(this.y + n);
        break;
      case 'C':
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
        this.x = clampX(n - 1);
        break;
      case 'd':
        this.y = clampY(n - 1);
        break;
      case 'H':
      case 'f':
        this.y = clampY((ps[0] ?? 1) - 1);
        this.x = clampX((ps[1] ?? 1) - 1);
        break;
      case 'J': {
        const mode = ps[0] ?? 0;
        if (mode === 2 || mode === 3) {
          if (mode === 2) this.lines = Array.from({ length: this.rows }, () => this.blank());
        } else if (mode === 0) {
          this.lines[this.y].fill(' ', this.x);
          for (let y = this.y + 1; y < this.rows; y++) this.lines[y] = this.blank();
        } else if (mode === 1) {
          this.lines[this.y].fill(' ', 0, this.x + 1);
          for (let y = 0; y < this.y; y++) this.lines[y] = this.blank();
        }
        break;
      }
      case 'K': {
        const mode = ps[0] ?? 0;
        if (mode === 0) this.lines[this.y].fill(' ', this.x);
        else if (mode === 1) this.lines[this.y].fill(' ', 0, this.x + 1);
        else this.lines[this.y] = this.blank();
        break;
      }
      case 'X':
        this.lines[this.y].fill(' ', this.x, Math.min(this.columns, this.x + n));
        break;
      default:
        break;
    }
  }

  /** The screen as text, a line per row, trailing spaces kept off. */
  text() {
    return this.lines.map((l) => l.join('').replace(/\s+$/, '')).join('\n');
  }

  /** Row `y` (0-based; negative counts from the bottom) as text. */
  row(y) {
    return this.lines.at(y).join('').replace(/\s+$/, '');
  }
}
