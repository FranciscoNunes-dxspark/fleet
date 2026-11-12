// Keel's mark on the web: a K turned round, a chevron and then a bar, so it reads as a command
// prompt and its cursor, on a blue tile. Each is cut across, the chevron near its top and the
// bar near its bottom, the mirror of each other, and the short piece the cut leaves is in a deeper
// tone, like a keel under the waterline. One drawing feeds the web app's logo (ui.jsx Logo), the favicon
// and the app icons (scripts/logo.mjs). Pinch (pinch.js) is the terminal app's pet only.
// Coordinates are on a 64 × 64 square.

export const MARK = {
  size: 64,
  // The tile shades from `top` down to `bottom`, a slight gradient as Switchyard's tile has.
  tile: { radius: 13, top: '#4682ea', bottom: '#2a5fc6' },
  /** How tall each cut is. */
  gap: 3.5,
  /** Each shape's cut starts at `cut`; it takes `colours.above` over it and `colours.below` under it. */
  bar: { x: 40, y: 13, w: 9, h: 38, r: 2, cut: 37, colours: { above: '#ffffff', below: '#a9c7ff' } },
  chevron: {
    points: [[15, 13], [26.5, 13], [37, 32], [26.5, 51], [15, 51], [25.5, 32]],
    cut: 23.5,
    colours: { above: '#a9c7ff', below: '#ffffff' },
  },
};

/**
 * How the logo shows what Keel sees: 'worried' while Azure DevOps answers the live checks with an
 * error, 'look' during a refresh, 'sleep' when nothing needs you, and otherwise 'idle'. (Losing the
 * connection to Keel's own server is the live badge's to show, not a worry.)
 */
export function logoMood({ attention, live, busy } = {}) {
  if (live?.connected && live.ok === false && live.error) return 'worried';
  if (busy) return 'look';
  if (attention && !attention.items?.length) return 'sleep';
  return 'idle';
}
