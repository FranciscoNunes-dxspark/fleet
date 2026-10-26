// What the host does with the bytes typed into it, pure. Everything goes to the active app as it came
// (keys, pastes, mouse reports) except after the prefix, ctrl+] (0x1d), whose next key is the host's:
// 1–6 or an app's letter switches, ] or n the next space and p the one before, q quits, ? helps,
// ctrl+] again sends a literal 0x1d; any other key cancels the prefix and is dropped. Without it,
// alt+1 to alt+6 (ESC and the digit: ctrl+alt+digit never reaches a terminal program) switch too.
import { SPACES } from './spaces.js';

export const PREFIX = '\x1d';

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

/** The action a key after the prefix stands for, or null (it cancels the prefix). */
export function prefixAction(key, spaces = SPACES) {
  if (key === PREFIX) return { type: 'send', data: PREFIX };
  if (/^[1-9]$/.test(key) && spaces[Number(key) - 1]) return { type: 'switch', id: spaces[Number(key) - 1].id };
  const k = key.length === 1 ? key.toLowerCase() : key;
  const space = spaces.find((s) => s.letter === k);
  if (space) return { type: 'switch', id: space.id };
  if (key === ']' || k === 'n') return { type: 'move', by: 1 };
  if (k === 'p') return { type: 'move', by: -1 };
  if (k === 'q') return { type: 'quit' };
  if (key === '?') return { type: 'help' };
  return null;
}

/**
 * Reads `input` with the prefix state `state` ({ prefix: bool }): { state, actions }, the actions in
 * order: { type: 'send', data } for what goes to the app, the prefix's ones, and { type: 'prefix', on }
 * when the prefix starts or ends (the bar shows it).
 */
export function readKeys(state, input, spaces = SPACES) {
  const actions = [];
  let prefix = Boolean(state?.prefix);
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
      prefix = false;
      actions.push({ type: 'prefix', on: false });
      const action = prefixAction(key, spaces);
      if (action?.type === 'send') pending += action.data;
      else if (action) {
        flush();
        actions.push(action);
      }
    } else if (/^[1-9]$/.test(key) && spaces[Number(key[1]) - 1]) {
      flush();
      actions.push({ type: 'switch', id: spaces[Number(key[1]) - 1].id });
    } else if (key === PREFIX) {
      flush();
      prefix = true;
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
