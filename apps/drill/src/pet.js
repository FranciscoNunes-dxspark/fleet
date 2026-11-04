// Peck, Drill's woodpecker. One pixel drawing feeds the terminal pet, the SVG logo and the app icon: a
// woodpecker's head in profile, red crest up, tapping at the code until it finds what's hollow. Run
// `node scripts/logo.js` to make assets/ from it.
import { countLine } from './model.js';

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Peck', kind: 'woodpecker' };

// The accent for the outline, as the siblings' pets have, a woodpecker's black and white face, its red
// crest, and a pale yellow beak pointing right, at the code.
export const PALETTE = {
  G: '#ff8c42', // outline, the accent
  R: '#d83a3a', // the crest
  K: '#262626', // black feathers
  W: '#f2f2f2', // white cheek
  E: '#0b0b0b', // the eye
  Y: '#f0d27a', // the beak
};

// 16 × 10 pixels; '.' is transparent.
const BASE = [
  '....GGGGG.......',
  '...GRRRRRG......',
  '..GRRRRRRKG.....',
  '..GKKKKKKKKG....',
  '..GKWWEWKKKGGGGG',
  '..GKWWWWKKKYYYYG',
  '..GKKWWWKKKGGGGG',
  '...GKKKKKKG.....',
  '....GWWWWG......',
  '.....GGGG.......',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 4: '..GKWWWEKKKGGGGG' },
  sleep: { 4: '..GKWWGWKKKGGGGG' },
  happy: { 0: '...GGGGGGG......', 1: '..GRRRRRRRG.....' },
  worried: { 4: '..GKWEEWKKKGGGGG', 1: '...GRRRRRG......' },
  // Pecking: the beak a pixel further on.
  wave: { 4: '..GKWWEWKKKGGGGG', 5: '..GKWWWWKKKYYYYY', 6: '..GKKWWWKKKGGGGG' },
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
  idle: '(•>',
  look: '(•>',
  sleep: '(->',
  happy: '(^>',
  worried: '(◉>',
  wave: '(•>>',
};

/** How the pet feels right now: about the last result, then what the last run found. */
export function moodFor({ run, busy, lastEntry, now = Date.now() }) {
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (busy) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  if (!run) return 'sleep';
  if (run.counts.failed) return 'worried';
  return 'wave';
}

/** A sentence for the welcome box. */
export function moodLine(mood, { data, run }) {
  if (!data) return `${PET.name} is looking for the tests.`;
  if (!data.suites.length) return 'No tests here (Vitest, Jest, node --test, Playwright, dotnet test): /move to a project.';
  if (!run) return `${data.suites.length} suite${data.suites.length === 1 ? '' : 's'} found; /run runs them.`;
  if (!run.counts.failed) return `${PET.name} found nothing hollow: ${countLine(run.counts)}.`;
  return `${countLine(run.counts)}: ↵ on one shows the frame it broke at.`;
}
