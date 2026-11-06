// Keel's mark on the web: a K made of a bar and a chevron, on a graphite tile, its lower part
// below a waterline in deeper tones, like a keel under the hull. One drawing feeds the favicon and
// the app icons (scripts/logo.mjs). Pinch (pinch.js) stays the terminal app's pet and the web
// app's empty states.
// Coordinates are on a 64 × 64 square.

export const MARK = {
  size: 64,
  tile: { radius: 13, fill: '#16181d' },
  /** Above this y the K is in its light tones, below it in the sunk ones. */
  waterline: 38,
  bar: { x: 15, y: 13, w: 9, h: 38, r: 2 },
  chevron: [[49, 13], [37.5, 13], [27, 32], [37.5, 51], [49, 51], [38.5, 32]],
  colours: {
    bar: { above: '#ffffff', below: '#9fb3c8' },
    chevron: { above: '#4c8dff', below: '#2c5fb8' },
  },
};
