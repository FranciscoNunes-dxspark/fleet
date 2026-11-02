// PowerShell syntax colouring for one line at a time, as segments ({ text, color }) the kit's Row draws.
// Pure and rough on purpose: it colours what is plainly one thing (a comment, a string, a variable, a
// keyword, a parameter, a Verb-Noun command) and leaves the rest alone. Multi-line strings and
// block comments are coloured line by line, so only their first line is exact.
import { theme } from '@fleet/kit/theme.js';

const KEYWORDS = new Set(
  'begin break catch class continue data do dynamicparam else elseif end enum exit filter finally for foreach from function if in param process return switch throw trap try until using var while workflow'.split(' '),
);

const TOKEN = /(#.*$)|("(?:[^"`]|`.)*"?|'(?:[^']|'')*'?)|(\$(?:\{[^}]*\}|[\w:?]+))|(-[A-Za-z][\w]*)|([A-Za-z][\w]*-[A-Za-z][\w]*)|([A-Za-z_][\w]*)|(\d+(?:\.\d+)?)/g;

export function highlight(line) {
  const out = [];
  let at = 0;
  for (const m of line.matchAll(TOKEN)) {
    if (m.index > at) out.push({ text: line.slice(at, m.index) });
    const [text, comment, string, variable, param, command, word, number] = m;
    let color;
    if (comment) color = theme.dim;
    else if (string) color = theme.warn;
    else if (variable) color = theme.add;
    else if (param) color = theme.bangMode;
    else if (command) color = theme.info;
    else if (word) color = KEYWORDS.has(word.toLowerCase()) ? theme.accent : undefined;
    else if (number) color = theme.info;
    out.push(color ? { text, color, dim: comment ? true : undefined } : { text });
    at = m.index + text.length;
  }
  if (at < line.length) out.push({ text: line.slice(at) });
  return out;
}

/** Marks the character at `col` (a space past the end of the line) as the cursor, splitting the segment it is in. */
export function withCursor(segments, col) {
  const out = [];
  let at = 0;
  let placed = false;
  for (const seg of segments) {
    const end = at + seg.text.length;
    if (!placed && col >= at && col < end) {
      const i = col - at;
      if (i > 0) out.push({ ...seg, text: seg.text.slice(0, i) });
      out.push({ ...seg, text: seg.text[i], inverse: true });
      if (i + 1 < seg.text.length) out.push({ ...seg, text: seg.text.slice(i + 1) });
      placed = true;
    } else out.push(seg);
    at = end;
  }
  if (!placed) out.push({ text: ' ', inverse: true });
  return out;
}

/** The segments cut to the columns from `left` on (the pane scrolled sideways). */
export function fromColumn(segments, left) {
  if (!left) return segments;
  const out = [];
  let at = 0;
  for (const seg of segments) {
    const end = at + seg.text.length;
    if (end > left) out.push(at >= left ? seg : { ...seg, text: seg.text.slice(left - at) });
    at = end;
  }
  return out;
}
