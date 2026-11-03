// Plod, Ballast's tortoise. One pixel drawing feeds the terminal pet, the SVG logo and the app icon: a
// tortoise seen from the side, under the weight of its shell, which is what a heavy bundle feels like
// to a page. Run `node scripts/logo.js` to make assets/ from it.
import { formatBytes } from './sizes.js';

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Plod', kind: 'tortoise' };

// The accent for the outline, as the siblings' pets have, with a dark olive shell and its paler plates,
// and grey-green skin.
export const PALETTE = {
  G: '#d4875a', // outline, the accent
  S: '#6b5a2e', // the shell
  H: '#a08442', // its plates
  K: '#9aa66b', // skin
  E: '#16120f', // eye
};

// 16 × 10 pixels; '.' is transparent. The shell on the left, the head out on the right, four legs.
const BASE = [
  '....GGGGGG......',
  '..GGSHHSSHGG....',
  '.GSHSSHHSSHSG...',
  '.GSSHHSSHHSSGGGG',
  'GSHHSSHHSSHHGKKG',
  'GSSSSSSSSSSSGKEG',
  'GGGGGGGGGGGGGKKG',
  '.GKKG....GKKGGG.',
  '.GKKG....GKKG...',
  '.GGGG....GGGG...',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 5: 'GSSSSSSSSSSSGEKG' },
  sleep: { 5: 'GSSSSSSSSSSSGKGG' },
  happy: { 4: 'GSHHSSHHSSHHGKEG', 5: 'GSSSSSSSSSSSGKKG' },
  // Its head pulled in, an eye peeking out.
  worried: { 3: '.GSSHHSSHHSSG...', 4: 'GSHHSSHHSSHHGG..', 5: 'GSSSSSSSSSSSGEG.', 6: 'GGGGGGGGGGGGGG..', 7: '.GKKG....GKKG...' },
  // A step on: the legs forward.
  wave: { 8: '..GKKG....GKKG..', 9: '..GGGG....GGGG..' },
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

/**
 * How the pet feels right now: about the last result, then the build: worried when a file is over its
 * budget, at ease when everything is within.
 */
export function moodFor({ build, over = 0, busy, lastEntry, now = Date.now() }) {
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (busy) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  if (!build?.chunks?.length) return 'sleep';
  if (over) return 'worried';
  return 'wave';
}

/** A sentence for the welcome box. */
export function moodLine({ build, over = 0, total = null, measure = 'gzip', compared = null }) {
  if (!build) return `${PET.name} is weighing the build.`;
  if (!build.chunks.length) return 'No stats file or output folder here: /build builds it once with stats, or /move to a project.';
  const weight = `${build.chunks.length} file${build.chunks.length === 1 ? '' : 's'}, ${formatBytes(total)} ${measure}`;
  if (over) return `${weight}; ${over} over budget. ↵ on one says what's in it.`;
  if (compared) return `${weight}; ${compared}.`;
  return `${weight}. 2 shows what's inside, 4 what changed.`;
}
