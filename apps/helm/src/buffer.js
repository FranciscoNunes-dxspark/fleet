// The script pane's text as a pure value: { lines, row, col }. Every edit returns a new one.
// Tabs are two spaces, a new line keeps the indent of the one above, and a line ending in "{" indents one more.

const INDENT = '  ';

export const create = (text = '') => ({ lines: text.replace(/\r\n?/g, '\n').split('\n'), row: 0, col: 0 });
export const textOf = (b) => b.lines.join('\n');
export const currentLine = (b) => b.lines[b.row];

const clampCol = (b, row, col) => Math.max(0, Math.min(col, b.lines[row].length));

export function insert(b, str) {
  const parts = str.replace(/\r\n?/g, '\n').replace(/\t/g, INDENT).split('\n');
  const line = b.lines[b.row];
  const head = line.slice(0, b.col);
  const tail = line.slice(b.col);
  if (parts.length === 1) {
    const lines = [...b.lines];
    lines[b.row] = head + parts[0] + tail;
    return { lines, row: b.row, col: b.col + parts[0].length };
  }
  const last = parts[parts.length - 1];
  const lines = [...b.lines.slice(0, b.row), head + parts[0], ...parts.slice(1, -1), last + tail, ...b.lines.slice(b.row + 1)];
  return { lines, row: b.row + parts.length - 1, col: last.length };
}

export function newline(b) {
  const line = b.lines[b.row];
  const before = line.slice(0, b.col);
  let indent = /^\s*/.exec(line)[0].slice(0, b.col);
  if (/[{(]\s*$/.test(before)) indent += INDENT;
  const lines = [...b.lines];
  lines.splice(b.row, 1, before, indent + line.slice(b.col));
  return { lines, row: b.row + 1, col: indent.length };
}

export function backspace(b) {
  if (b.col > 0) {
    const line = b.lines[b.row];
    // Over indentation only, a backspace takes one indent step.
    const step = /^ +$/.test(line.slice(0, b.col)) && b.col >= INDENT.length ? INDENT.length : 1;
    const lines = [...b.lines];
    lines[b.row] = line.slice(0, b.col - step) + line.slice(b.col);
    return { lines, row: b.row, col: b.col - step };
  }
  if (b.row === 0) return b;
  const lines = [...b.lines];
  const col = lines[b.row - 1].length;
  lines.splice(b.row - 1, 2, lines[b.row - 1] + lines[b.row]);
  return { lines, row: b.row - 1, col };
}

export function del(b) {
  const line = b.lines[b.row];
  const lines = [...b.lines];
  if (b.col < line.length) {
    lines[b.row] = line.slice(0, b.col) + line.slice(b.col + 1);
    return { ...b, lines };
  }
  if (b.row === lines.length - 1) return b;
  lines.splice(b.row, 2, line + lines[b.row + 1]);
  return { ...b, lines };
}

/** Moves the cursor: left | right | up | down | home | end | top | bottom | pageUp | pageDown (by `page` rows). */
export function move(b, to, page = 10) {
  const last = b.lines.length - 1;
  switch (to) {
    case 'left':
      if (b.col > 0) return { ...b, col: b.col - 1 };
      return b.row > 0 ? { ...b, row: b.row - 1, col: b.lines[b.row - 1].length } : b;
    case 'right':
      if (b.col < b.lines[b.row].length) return { ...b, col: b.col + 1 };
      return b.row < last ? { ...b, row: b.row + 1, col: 0 } : b;
    case 'up':
    case 'down':
    case 'pageUp':
    case 'pageDown': {
      const by = to === 'up' ? -1 : to === 'down' ? 1 : to === 'pageUp' ? -page : page;
      const row = Math.max(0, Math.min(last, b.row + by));
      return { ...b, row, col: clampCol(b, row, b.col) };
    }
    case 'home': {
      // The first press goes to the first character that isn't a space, the next to the very start.
      const first = /^\s*/.exec(b.lines[b.row])[0].length;
      return { ...b, col: b.col === first ? 0 : first };
    }
    case 'end':
      return { ...b, col: b.lines[b.row].length };
    case 'top':
      return { ...b, row: 0, col: 0 };
    case 'bottom':
      return { ...b, row: last, col: b.lines[last].length };
    default:
      return b;
  }
}

/** The first row to draw so the cursor row shows in `height` rows, keeping `top` when it already does. */
export const scrollFor = (row, top, height) => (row < top ? row : row >= top + height ? row - height + 1 : top);
