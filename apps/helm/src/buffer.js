// The script pane's text as a pure value: { lines, row, col }. Every edit returns a new one.
// Tabs are two spaces, a new line keeps the indent of the one above, and a line ending in "{" indents one more.

const INDENT = '  ';

export const create = (text = '') => ({ lines: text.replace(/\r\n?/g, '\n').split('\n'), row: 0, col: 0 });
export const textOf = (b) => b.lines.join('\n');
export const currentLine = (b) => b.lines[b.row];

const clampCol = (b, row, col) => Math.max(0, Math.min(col, b.lines[row].length));

export function insert(b, str) {
  if (b.anchor) b = removeSelection(b);
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
  if (b.anchor) b = removeSelection(b);
  const line = b.lines[b.row];
  const before = line.slice(0, b.col);
  let indent = /^\s*/.exec(line)[0].slice(0, b.col);
  if (/[{(]\s*$/.test(before)) indent += INDENT;
  const lines = [...b.lines];
  lines.splice(b.row, 1, before, indent + line.slice(b.col));
  return { lines, row: b.row + 1, col: indent.length };
}

export function backspace(b) {
  if (b.anchor) return removeSelection(b);
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
  if (b.anchor) return removeSelection(b);
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

/** Moves the cursor (and drops the selection): left | right | up | down | home | end | top | bottom | pageUp | pageDown (by `page` rows). */
export function move(b, to, page = 10) {
  return { ...step(b, to, page), anchor: undefined };
}

function step(b, to, page) {
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

// A selection is `anchor` (where it began) to the cursor; no anchor, no selection.
const before = (a, c) => a.row < c.row || (a.row === c.row && a.col < c.col);

/** The selection as { from, to } in text order, or null (an anchor on the cursor selects nothing). */
export function selection(b) {
  if (!b.anchor || (b.anchor.row === b.row && b.anchor.col === b.col)) return null;
  const cur = { row: b.row, col: b.col };
  return before(b.anchor, cur) ? { from: b.anchor, to: cur } : { from: cur, to: b.anchor };
}

/** The cursor moved like `move`, the selection growing from where it was (or began) to the cursor. */
export function extend(b, to, page = 10) {
  const anchor = b.anchor ?? { row: b.row, col: b.col };
  return { ...step(b, to, page), anchor };
}

export const selectAll = (b) => ({ ...b, anchor: { row: 0, col: 0 }, row: b.lines.length - 1, col: b.lines.at(-1).length });

export function selectedText(b) {
  const s = selection(b);
  if (!s) return '';
  const { from, to } = s;
  if (from.row === to.row) return b.lines[from.row].slice(from.col, to.col);
  return [b.lines[from.row].slice(from.col), ...b.lines.slice(from.row + 1, to.row), b.lines[to.row].slice(0, to.col)].join('\n');
}

export function removeSelection(b) {
  const s = selection(b);
  if (!s) return { ...b, anchor: undefined };
  const { from, to } = s;
  const lines = [...b.lines.slice(0, from.row), b.lines[from.row].slice(0, from.col) + b.lines[to.row].slice(to.col), ...b.lines.slice(to.row + 1)];
  return { lines, row: from.row, col: from.col };
}

/** The columns of line `row` the selection covers, [from, to), or null. A selected line break shows as one extra column. */
export function selectedColumns(b, row) {
  const s = selection(b);
  if (!s || row < s.from.row || row > s.to.row) return null;
  const len = b.lines[row].length;
  const from = row === s.from.row ? s.from.col : 0;
  const to = row === s.to.row ? s.to.col : len + 1;
  return from < to ? [from, to] : null;
}

/** The cursor on the next match of `query` after it (wrapping round, case blind), the match selected; null when there is none. */
export function find(b, query) {
  if (!query) return null;
  const q = query.toLowerCase();
  const n = b.lines.length;
  const sel = selection(b);
  const start = sel ? sel.to : { row: b.row, col: b.col };
  for (let k = 0; k <= n; k++) {
    const row = (start.row + k) % n;
    const text = b.lines[row].toLowerCase();
    const from = k === 0 ? start.col : k === n ? 0 : 0;
    const at = text.indexOf(q, from);
    if (at >= 0 && (k < n || at < start.col)) return { ...b, row, col: at + q.length, anchor: { row, col: at } };
  }
  return null;
}

const PAIRS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

/** Where the bracket at the cursor (or just before it) has its partner, { row, col }, or null. Strings and comments count like code. */
export function matchBracket(b) {
  const at = (row, col) => b.lines[row]?.[col];
  for (const col of [b.col, b.col - 1]) {
    const ch = at(b.row, col);
    const open = PAIRS[ch];
    const close = CLOSERS[ch];
    if (!open && !close) continue;
    const dir = open ? 1 : -1;
    const want = open ?? close;
    let depth = 0;
    for (let row = b.row, c = col; row >= 0 && row < b.lines.length; row += dir, c = dir > 0 ? 0 : (b.lines[row]?.length ?? 0) - 1) {
      for (; c >= 0 && c < b.lines[row].length; c += dir) {
        const x = b.lines[row][c];
        if (x === ch) depth++;
        else if (x === want && --depth === 0) return { row, col: c };
      }
    }
    return null;
  }
  return null;
}
