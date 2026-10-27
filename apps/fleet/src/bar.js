// The bar: the host's one line at the bottom of the screen, a tab per space and a hint, pure. A tab
// says the space's key, its name and its state (○ not started, ● running, ✕ and the code once it has
// exited); the active one is drawn in its app's accent. When the line is too narrow, the hint goes
// first, then the names shrink to their letters.
import { fit, stringWidth } from '@fleet/kit/text.js';

const MARK = { idle: '○', running: '●', starting: '●' };

/** A space's state as its tab writes it: "●", "○", "✕1". */
export const stateMark = (space) => (space.state === 'exited' ? `✕${space.code ?? ''}` : (MARK[space.state] ?? '○'));

/** The hint at the right: the prefix's keys while it waits for one, else how to get them. */
export function hintFor({ prefix, notice }) {
  if (prefix) return '1-7 s t o b h k w · n p · q quit · ? help';
  return notice || 'ctrl+] ? help';
}

/**
 * The bar's layout for `spaces` ({ id, title, letter, state, code }) at `width` columns:
 * { segments, tabs }. `segments` are { text, role } in order ('tab', 'active', 'fill', 'hint',
 * 'prefix', 'notice'), together exactly `width` wide; `tabs` are { id, from, to } (columns, `to`
 * exclusive), for clicks.
 */
export function barLayout({ spaces, active, width, prefix = false, notice = '' }) {
  if (width <= 0) return { segments: [], tabs: [] };
  const labels = (short) => spaces.map((s, i) => ` ${i + 1} ${short ? s.letter.toUpperCase() : s.title} ${stateMark(s)} `);
  const hint = ` ${hintFor({ prefix, notice })} `;
  const total = (ls) => ls.reduce((n, l) => n + stringWidth(l), 0);
  let tabs = labels(false);
  let showHint = total(tabs) + stringWidth(hint) <= width;
  if (!showHint && total(tabs) > width) tabs = labels(true);
  // With the prefix waiting, its keys matter more than the names.
  if (prefix && !showHint) {
    tabs = labels(true);
    showHint = total(tabs) + 1 <= width;
  }
  const segments = [];
  const where = [];
  let col = 0;
  for (const [i, s] of spaces.entries()) {
    const left = width - col;
    if (left <= 0) break;
    const text = stringWidth(tabs[i]) <= left ? tabs[i] : fit(tabs[i], left);
    segments.push({ text, role: s.id === active ? 'active' : 'tab', id: s.id, state: s.state });
    where.push({ id: s.id, from: col, to: col + stringWidth(text) });
    col += stringWidth(text);
  }
  if (col < width) {
    const room = width - col;
    const said = hint.trim();
    const h = !showHint ? '' : stringWidth(said) > room - 2 ? fit(said, Math.max(0, room - 2)) : said;
    const gap = Math.max(0, room - stringWidth(h) - (h ? 1 : 0));
    segments.push({ text: ' '.repeat(gap), role: 'fill' });
    if (h) segments.push({ text: `${h} `, role: prefix ? 'prefix' : notice ? 'notice' : 'hint' });
  }
  return { segments, tabs: where };
}

/** The space whose tab is at column `x`, or undefined. */
export const tabAt = (layout, x) => layout.tabs.find((t) => x >= t.from && x < t.to)?.id;

/** "#5fd787" → [95, 215, 135]. */
export const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** The nearest of xterm's 256 colours to `hex` (its 6×6×6 cube). */
export function ansi256(hex) {
  const step = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const [r, g, b] = rgb(hex).map(step);
  return 16 + 36 * r + 6 * g + b;
}

/** The SGR for `hex` as a foreground (or background), in 24-bit colour or the nearest of 256. */
export function colour(hex, { background = false, truecolor = true } = {}) {
  const base = background ? 48 : 38;
  return truecolor ? `\x1b[${base};2;${rgb(hex).join(';')}m` : `\x1b[${base};5;${ansi256(hex)}m`;
}

/** The bar as one line of ANSI text, `width` columns wide, for `spaces` (with their accents). */
export function renderBar(layout, spaces, { truecolor = true } = {}) {
  const BAR = '\x1b[0m\x1b[48;5;236m\x1b[38;5;250m';
  let out = BAR;
  for (const seg of layout.segments) {
    const space = spaces.find((s) => s.id === seg.id);
    if (seg.role === 'active') out += `${colour(space.accent, { background: true, truecolor })}\x1b[38;5;16m\x1b[1m${seg.text}${BAR}`;
    else if (seg.role === 'tab') out += seg.state === 'idle' ? `\x1b[38;5;244m${seg.text}${BAR}` : `${colour(space.accent, { truecolor })}${seg.text}${BAR}`;
    else if (seg.role === 'prefix') out += `\x1b[1m\x1b[38;5;229m${seg.text}${BAR}`;
    else if (seg.role === 'notice') out += `\x1b[38;5;229m${seg.text}${BAR}`;
    else if (seg.role === 'hint') out += `\x1b[38;5;244m${seg.text}${BAR}`;
    else out += seg.text;
  }
  return `${out}\x1b[0m`;
}
