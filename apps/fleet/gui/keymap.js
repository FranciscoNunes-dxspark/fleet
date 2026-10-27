// The browser's keys and mouse as the bytes a terminal sends, pure (the window and the tests both load
// it): the apps read their keys as they always do (Ink's input parser, the kit's mouse.js), so the
// window has to type exactly what a terminal would. Keys the window keeps for itself (the prefix's,
// cmd/super combinations) never get here.

const ARROWS = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
const TILDE = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const SS3 = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };
const CTRL_PUNCTUATION = { ' ': '\x00', '@': '\x00', '2': '\x00', '[': '\x1b', '3': '\x1b', '\\': '\x1c', '4': '\x1c', ']': '\x1d', '5': '\x1d', '^': '\x1e', '6': '\x1e', '_': '\x1f', '-': '\x1f', '7': '\x1f', '/': '\x1f', '?': '\x7f', '8': '\x7f' };

/** xterm's modifier parameter: 1 plus shift 1, alt 2, ctrl 4; 1 alone means none. */
const modifier = (e) => 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);

/**
 * A keydown (`{ key, ctrlKey, altKey, shiftKey, metaKey }`) as a terminal's bytes, or null for a key
 * that types nothing (a modifier alone, a dead key, cmd/super combinations, which are the system's).
 */
export function keyBytes(e) {
  const { key } = e;
  if (!key || e.metaKey) return null;
  const mod = modifier(e);
  if (key in ARROWS) return mod > 1 ? `\x1b[1;${mod}${ARROWS[key]}` : `\x1b[${ARROWS[key]}`;
  if (key in TILDE) return mod > 1 ? `\x1b[${TILDE[key]};${mod}~` : `\x1b[${TILDE[key]}~`;
  if (key in SS3) return mod > 1 ? `\x1b[1;${mod}${SS3[key]}` : `\x1bO${SS3[key]}`;
  const alt = e.altKey ? '\x1b' : '';
  switch (key) {
    case 'Enter':
      return `${alt}\r`;
    case 'Tab':
      return e.shiftKey ? '\x1b[Z' : `${alt}\t`;
    case 'Backspace':
      return `${alt}${e.ctrlKey ? '\x08' : '\x7f'}`;
    case 'Escape':
      return '\x1b';
    default:
      break;
  }
  // One character (or one grapheme a keyboard types at once); anything longer is a name like "Shift".
  if ([...key].length !== 1) return null;
  if (e.ctrlKey) {
    const lower = key.toLowerCase();
    if (lower >= 'a' && lower <= 'z') return `${alt}${String.fromCharCode(lower.charCodeAt(0) - 96)}`;
    if (key in CTRL_PUNCTUATION) return `${alt}${CTRL_PUNCTUATION[key]}`;
    return null;
  }
  return `${alt}${key}`;
}

/**
 * A mouse event at cell (`x`, `y`), counted from 0, as an SGR report (1006), which every app reads:
 * `kind` is down, up, move (a drag, with `button` held, or a plain move with none), or wheel (`deltaY`).
 */
export function mouseBytes({ kind, button = 0, x, y, deltaY = 0, shiftKey = false, altKey = false, ctrlKey = false }) {
  let code;
  if (kind === 'wheel') code = deltaY < 0 ? 64 : 65;
  else if (kind === 'move') code = (button == null ? 3 : button) + 32;
  else code = button;
  code += (shiftKey ? 4 : 0) + (altKey ? 8 : 0) + (ctrlKey ? 16 : 0);
  return `\x1b[<${code};${x + 1};${y + 1}${kind === 'up' ? 'm' : 'M'}`;
}
