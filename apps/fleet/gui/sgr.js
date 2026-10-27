// A cell's style (the SGR parameters the server's vt.js keeps, like "1;38;2;95;215;135") as CSS, pure.
// Colours by number come from the window's palette, close to the terminals the apps were made in
// (Windows Terminal's and the macOS defaults sit near these).

export const PALETTE = [
  '#1b1d23', '#e06c75', '#7fbf6a', '#d7b25b', '#61a6ef', '#c27ad8', '#4fb7c3', '#c8ccd4',
  '#5c6370', '#ff7a85', '#98d982', '#f0cb74', '#7ab8ff', '#d695ea', '#66d2dd', '#f2f4f8',
];

/** Colour `n` of the 256: the 16 above, a 6×6×6 cube, then 24 greys. */
export function colour256(n) {
  if (n < 16) return PALETTE[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const step = (c) => (c ? 55 + c * 40 : 0);
  return `rgb(${step(Math.floor(i / 36))},${step(Math.floor(i / 6) % 6)},${step(i % 6)})`;
}

/** A style's parts: { fg, bg, bold, dim, italic, underline, strike, inverse, hidden }, colours as CSS ('' for the default). */
export function parseStyle(style) {
  const out = { fg: '', bg: '', bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false, hidden: false };
  if (!style) return out;
  const p = style.split(';');
  for (let i = 0; i < p.length; i++) {
    const n = Number(p[i]);
    if (n === 38 || n === 48) {
      let c = '';
      if (p[i + 1] === '5') {
        c = colour256(Number(p[i + 2]) || 0);
        i += 2;
      } else if (p[i + 1] === '2') {
        c = `rgb(${Number(p[i + 2]) || 0},${Number(p[i + 3]) || 0},${Number(p[i + 4]) || 0})`;
        i += 4;
      }
      out[n === 38 ? 'fg' : 'bg'] = c;
    } else if (n >= 30 && n <= 37) out.fg = PALETTE[n - 30];
    else if (n >= 90 && n <= 97) out.fg = PALETTE[n - 90 + 8];
    else if (n >= 40 && n <= 47) out.bg = PALETTE[n - 40];
    else if (n >= 100 && n <= 107) out.bg = PALETTE[n - 100 + 8];
    else if (n === 1) out.bold = true;
    else if (n === 2) out.dim = true;
    else if (n === 3) out.italic = true;
    else if (n === 4) out.underline = true;
    else if (n === 7) out.inverse = true;
    else if (n === 8) out.hidden = true;
    else if (n === 9) out.strike = true;
  }
  return out;
}

const cache = new Map();

/** The inline CSS for a style, given the screen's own colours (`fg`, `bg`) for inverse video. */
export function styleCss(style, { fg = 'var(--screen-fg)', bg = 'var(--screen-bg)' } = {}) {
  const key = `${style}|${fg}|${bg}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const s = parseStyle(style);
  let color = s.fg || '';
  let background = s.bg || '';
  if (s.inverse) {
    color = s.bg || bg;
    background = s.fg || fg;
  }
  let css = '';
  if (color) css += `color:${color};`;
  if (background) css += `background:${background};`;
  if (s.bold) css += 'font-weight:700;';
  if (s.dim) css += 'opacity:.6;';
  if (s.italic) css += 'font-style:italic;';
  const lines = [s.underline && 'underline', s.strike && 'line-through'].filter(Boolean);
  if (lines.length) css += `text-decoration:${lines.join(' ')};`;
  if (s.hidden) css += 'visibility:hidden;';
  if (cache.size > 5000) cache.clear();
  cache.set(key, css);
  return css;
}
