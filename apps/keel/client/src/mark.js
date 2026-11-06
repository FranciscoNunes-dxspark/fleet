// Keel's mark on the web: a K turned round, a chevron and then a bar, so it reads as a command
// prompt and its cursor, on a graphite tile, cut by a waterline with its lower part in deeper
// tones, like a keel under the hull. One drawing feeds the web app's logo (ui.jsx Logo), the favicon
// and the app icons (scripts/logo.mjs). Pinch (pinch.js) is the terminal app's pet only.
// Coordinates are on a 64 × 64 square.

export const MARK = {
  size: 64,
  tile: { radius: 13, fill: '#16181d' },
  /** The waterline's top: above it the K is in its light tones; `gap` below it, in the sunk ones. */
  waterline: 37,
  gap: 3.5,
  bar: { x: 40, y: 13, w: 9, h: 38, r: 2 },
  chevron: [[15, 13], [26.5, 13], [37, 32], [26.5, 51], [15, 51], [25.5, 32]],
  colours: {
    bar: { above: '#ffffff', below: '#bec0c2' },
    chevron: { above: '#4c8dff', below: '#3d6cc0' },
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
