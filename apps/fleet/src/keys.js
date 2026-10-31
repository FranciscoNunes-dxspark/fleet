// What the host does with the bytes typed into it, pure. Everything goes to the active app as it came
// (keys, pastes, mouse reports) except after the prefix, ctrl+b (0x02) unless host.json's "prefix"
// names another, whose next key is the host's: 1–9 or an app's letter switches, ] or n the next space
// and p the one before, | or \ splits the screen in two (| again, or x, puts it back), tab or an arrow
// left or right goes to the other pane, m asks for a folder to move every app to, r opens the
// runbooks and f follows a request (panels.js), q quits, ? helps, the prefix again sends it to the
// app; any other key cancels the prefix and is dropped. ctrl+] (0x1d), the prefix Fleet had first,
// works too: it's hard to type on many keyboards (AltGr+9 on a Portuguese one), hence ctrl+b. Without
// either, alt+1 to alt+9 (ESC and the digit: ctrl+alt+digit never reaches a terminal program) switch too.
import { SPACES } from './spaces.js';

/** ctrl+]: the prefix Fleet had first, still taken whatever the prefix is. */
export const PREFIX = '\x1d';
/** The prefix unless host.json says otherwise. */
export const DEFAULT_PREFIX = 'ctrl+b';

// The ctrl keys a prefix can't be: ctrl+c (an app's copy, never quit), tab (i), enter (j, m),
// backspace (h), and the terminal's own flow control (q, s) and suspend (z).
const RESERVED = new Set(['c', 'h', 'i', 'j', 'm', 'q', 's', 'z']);
const CTRL_PUNCTUATION = { ']': '\x1d', '\\': '\x1c', '^': '\x1e', '_': '\x1f', '@': '\x00', space: '\x00' };

/** The byte a prefix's name (`ctrl+b`, `ctrl+a`, `ctrl+]`, `ctrl+space`) is, or null for one Fleet can't use. */
export function prefixByte(name) {
  const m = /^\s*(?:ctrl|c)\s*[+-]\s*(.+?)\s*$/i.exec(String(name ?? ''));
  if (!m) return null;
  const k = m[1].toLowerCase();
  if (/^[a-z]$/.test(k)) return RESERVED.has(k) ? null : String.fromCharCode(k.charCodeAt(0) - 96);
  return CTRL_PUNCTUATION[k] ?? null;
}

/** How a prefix byte is written for people: \x02 → ctrl+b. */
export function prefixName(byte) {
  const code = String(byte).charCodeAt(0);
  if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`;
  return { 0: 'ctrl+space', 0x1c: 'ctrl+\\', 0x1d: 'ctrl+]', 0x1e: 'ctrl+^', 0x1f: 'ctrl+_' }[code] ?? 'the prefix';
}

/** The prefixes taken: `byte` (host.json's, else ctrl+b's) and ctrl+]. */
export const prefixesFor = (byte = prefixByte(DEFAULT_PREFIX)) => [...new Set([byte, PREFIX])];

/** How long the key at `i` of `s` is: an escape sequence whole (CSI, SS3, alt+key), else one character. */
export function keyLength(s, i) {
  if (s[i] !== '\x1b') return s.codePointAt(i) > 0xffff ? 2 : 1;
  if (s[i + 1] === '[') {
    let j = i + 2;
    while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++;
    return Math.min(s.length, j + 1) - i;
  }
  if (s[i + 1] === 'O' && i + 2 < s.length) return 3;
  return i + 1 < s.length ? 2 : 1;
}

// Tab, and the arrows left and right (CSI and SS3 forms): the other pane.
const PANE_KEYS = new Set(['\t', '\x1b[C', '\x1b[D', '\x1bOC', '\x1bOD']);

/** The action a key after the prefix (`started`, the byte typed) stands for, or null (it cancels the prefix). */
export function prefixAction(key, spaces = SPACES, started = PREFIX) {
  if (key === started) return { type: 'send', data: started };
  if (/^[1-9]$/.test(key) && spaces[Number(key) - 1]) return { type: 'switch', id: spaces[Number(key) - 1].id };
  const k = key.length === 1 ? key.toLowerCase() : key;
  const space = spaces.find((s) => s.letter === k);
  if (space) return { type: 'switch', id: space.id };
  if (key === ']' || k === 'n') return { type: 'move', by: 1 };
  if (k === 'p') return { type: 'move', by: -1 };
  if (key === '|' || key === '\\') return { type: 'split' };
  if (k === 'x') return { type: 'unsplit' };
  if (PANE_KEYS.has(key)) return { type: 'pane' };
  if (k === 'm') return { type: 'folder' };
  if (k === 'q') return { type: 'quit' };
  if (key === '?') return { type: 'help' };
  if (k === 'r') return { type: 'runbooks' };
  if (k === 'f') return { type: 'trace' };
  return null;
}

/**
 * Reads `input` with the prefix state `state` ({ prefix: false, or the prefix byte typed }): { state,
 * actions }, the actions in order: { type: 'send', data } for what goes to the app, the prefix's ones,
 * and { type: 'prefix', on } when the prefix starts or ends (the bar shows it). `prefixes` are the
 * bytes that start it (prefixesFor's).
 */
export function readKeys(state, input, spaces = SPACES, prefixes = prefixesFor()) {
  const actions = [];
  let prefix = state?.prefix === true ? PREFIX : state?.prefix || false;
  let pending = '';
  const flush = () => {
    if (pending) actions.push({ type: 'send', data: pending });
    pending = '';
  };
  for (let i = 0; i < input.length; ) {
    const n = keyLength(input, i);
    const key = input.slice(i, i + n);
    i += n;
    if (prefix) {
      const started = prefix;
      prefix = false;
      actions.push({ type: 'prefix', on: false });
      const action = prefixAction(key, spaces, started);
      if (action?.type === 'send') pending += action.data;
      else if (action) {
        flush();
        actions.push(action);
      }
    } else if (/^[1-9]$/.test(key) && spaces[Number(key[1]) - 1]) {
      flush();
      actions.push({ type: 'switch', id: spaces[Number(key[1]) - 1].id });
    } else if (prefixes.includes(key)) {
      flush();
      prefix = key;
      actions.push({ type: 'prefix', on: true });
    } else pending += key;
  }
  flush();
  return { state: { prefix }, actions };
}

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/**
 * Takes the mouse reports on screen row `row` (1-based: the bar's) out of `data`: { data, clicks },
 * `clicks` the columns (0-based) where the left button went down there. Reports elsewhere stay, for
 * the app.
 */
export function takeBarClicks(data, row) {
  const clicks = [];
  const rest = data.replace(SGR_MOUSE, (all, b, x, y, end) => {
    if (Number(y) !== row) return all;
    const code = Number(b);
    if (end === 'M' && (code & ~(4 | 8 | 16)) === 0) clicks.push(Number(x) - 1);
    return '';
  });
  return { data: rest, clicks };
}
