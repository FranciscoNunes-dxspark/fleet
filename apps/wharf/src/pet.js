// Bark, Wharf's seal. One pixel drawing feeds the terminal pet, the SVG logo and the app icon: a seal
// balancing a container on its head. Run `node scripts/logo.js` to make assets/ from it.

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Bark', kind: 'seal' };

// The accent for the outline, as the siblings' pets have, with a seal's slate-grey coat inside it and
// an orange shipping container, which is the one warm colour so it reads at 16 pixels.
export const PALETTE = {
  G: '#3fb8b0', // outline, the accent
  S: '#7f94a0', // the coat
  L: '#cfdde3', // the pale belly
  F: '#5b6d77', // the flippers
  E: '#0e1a1d', // eye and nose
  N: '#0e1a1d',
  W: '#ffffff', // whiskers
  C: '#f0883e', // the container
  D: '#b45f26', // its ribs
};

// 16 × 10 pixels; '.' is transparent. A seal's face looking out, white whisker pads either side of
// its nose, and the container balanced on its head.
const BASE = [
  '.....CCCCCC.....',
  '.....CDCCDC.....',
  '....GGGGGGGG....',
  '..GGSSSSSSSSGG..',
  '.GSSSSSSSSSSSSG.',
  '.GSSESSSSSSESSG.',
  '.GSSSSSNNSSSSSG.',
  '.GWWSSLLLLSSWWG.',
  '..GGSSLLLLSSGG..',
  '....GGGGGGGG....',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 5: '.GSESSSSSESSSSG.' },
  sleep: { 5: '.GSSGSSSSSSGSSG.' },
  happy: { 0: '......CCCCCC....', 1: '......CDCCDC....' },
  worried: { 0: '....CCCCCC......' },
  wave: { 8: '..GGSSLLLLSSGGFF' },
};

/** The drawing for a mood, as rows of palette letters. */
export function petPixels(mood = 'idle') {
  const over = MOODS[mood] ?? {};
  return BASE.map((row, i) => over[i] ?? row);
}

/**
 * The drawing as terminal rows of segments, two pixels per cell: "▀" with the top pixel as
 * the text colour and the bottom one as the background.
 */
export function petRows(mood = 'idle') {
  const px = petPixels(mood);
  const rows = [];
  for (let y = 0; y < px.length; y += 2) {
    const segs = [];
    for (let x = 0; x < px[y].length; x++) {
      const top = PALETTE[px[y][x]];
      const bottom = PALETTE[px[y + 1]?.[x]];
      if (top && bottom) segs.push({ text: '▀', color: top, bg: bottom });
      else if (top) segs.push({ text: '▀', color: top });
      else if (bottom) segs.push({ text: '▄', color: bottom });
      else segs.push({ text: ' ' });
    }
    rows.push(segs);
  }
  return rows;
}

/** A one-line face for the header. */
export const FACES = {
  idle: '(•ᴥ•)',
  look: '(•ᴥ•)',
  sleep: '(–ᴥ–)',
  happy: '(^ᴥ^)',
  worried: '(◉ᴥ◉)',
  wave: '(•ᴥ•)/',
};

const failed = (c) => c.state === 'exited' && c.exitCode > 0;
const unwell = (c) => c.health === 'unhealthy' || failed(c) || c.state === 'dead';

/** How the pet feels right now: about the last result, and whether something is running. */
export function moodFor({ data, busy, lastEntry, now = Date.now() }) {
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (busy) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  if (!data) return 'idle';
  if (data.containers.some(unwell)) return 'worried';
  if (!data.containers.some((c) => c.state === 'running')) return 'sleep';
  return 'wave';
}

/** A sentence for the welcome box. */
export function moodLine(mood, data) {
  if (!data) return `${PET.name} is looking at the water.`;
  const bad = data.containers.filter(unwell).map((c) => c.name);
  if (bad.length) return `${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ' and more' : ''} ${bad.length === 1 ? 'is' : 'are'} not well: ↵ shows the log.`;
  if (mood === 'worried') return 'Something went wrong: the line below says what.';
  const n = data.containers.length;
  if (!n) return 'No containers here yet: /pull fetches an image.';
  const up = data.containers.filter((c) => c.state === 'running').length;
  return up ? `${up} of ${n} running. ↵ shows a log, r restarts, s stops.` : `None of the ${n} running: s starts one.`;
}
