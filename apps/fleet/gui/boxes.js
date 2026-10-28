// The box-drawing and block characters the apps draw their panels and mascots with, drawn by the
// window itself rather than the font (pure: which class draws each). A font draws them a little short
// of the line's height, which leaves gaps in a panel's sides and stripes through the pixel-art
// mascots; drawn with CSS they meet, and a panel's rounded corners are really round.

export const BOX_CLASSES = {
  '─': 'h', '━': 'h b', '│': 'v', '┃': 'v b',
  '╭': 'tl r', '╮': 'tr r', '╰': 'bl r', '╯': 'br r',
  '┌': 'tl', '┐': 'tr', '└': 'bl', '┘': 'br',
  '├': 'v vr', '┤': 'v vl', '┬': 'h hd', '┴': 'h hu', '┼': 'h v x',
  '╴': 'hl', '╶': 'hr', '╵': 'vu', '╷': 'vd',
  '▀': 'ut', '▄': 'lh', '█': 'fb', '▌': 'lf', '▐': 'rf',
};

/** Whether the window draws `ch` itself. */
export const isBox = (ch) => Object.hasOwn(BOX_CLASSES, ch);

/**
 * A run's text split where the window draws characters itself: [[text, boxClass | null], …], each
 * box character a part of its own, the text between them kept whole.
 */
export function splitBoxes(text) {
  const parts = [];
  let plain = '';
  for (const ch of text) {
    if (isBox(ch)) {
      if (plain) parts.push([plain, null]);
      plain = '';
      parts.push([ch, BOX_CLASSES[ch]]);
    } else plain += ch;
  }
  if (plain) parts.push([plain, null]);
  return parts;
}
