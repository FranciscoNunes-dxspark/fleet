// Nibs, Bilge's rat. One pixel drawing feeds the terminal pet, the SVG logo and the app icon: a bilge
// rat with a bucket, bailing out what shouldn't be aboard. Run `node scripts/logo.js` to make assets/ from it.
import { countLine } from './audit.js';

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Nibs', kind: 'rat' };

// The accent for the outline, as the siblings' pets have, with a rat's brown-grey coat inside it, pink
// ears and nose, and a blue bucket of bilge water, the one cold colour so it reads at 16 pixels.
export const PALETTE = {
  G: '#9ccc65', // outline, the accent
  S: '#8d7f74', // the coat
  P: '#f4a6b7', // ears and nose
  E: '#16120f', // eyes
  N: '#f4a6b7',
  W: '#ffffff', // whiskers
  B: '#4f7fbf', // the bucket
  U: '#a8d0f0', // its water
};

// 16 × 10 pixels; '.' is transparent. A rat's face looking out over the bucket it holds, its round
// ears up, whiskers either side of its nose.
const BASE = [
  '..GGG......GGG..',
  '.GPPPG....GPPPG.',
  '.GPPGGGGGGGGPPG.',
  '..GGSSSSSSSSGG..',
  '...GSSESSESSG...',
  '..WGSSSNNSSSGW..',
  '....GSSSSSSG....',
  '....GBBBBBBG....',
  '....GBUUUUBG....',
  '.....GGGGGG.....',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 4: '...GSESSESSSG...' },
  sleep: { 4: '...GSSGSSGSSG...' },
  happy: { 0: '.GGG........GGG.', 1: 'GPPPG......GPPPG' },
  worried: { 4: '...GSEESEESSG...' },
  wave: { 6: '....GSSSSSSGSS..' },
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
  idle: '(•ㅅ•)',
  look: '(•ㅅ•)',
  sleep: '(–ㅅ–)',
  happy: '(^ㅅ^)',
  worried: '(◉ㅅ◉)',
  wave: '(•ㅅ•)/',
};

const serious = (c) => c && (c.critical || c.high);

/** How the pet feels right now: about the last result, then what the audit found. */
export function moodFor({ data, busy, lastEntry, now = Date.now() }) {
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (busy) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  if (!data?.audit) return data?.packages?.length ? 'idle' : 'sleep';
  if (serious(data.audit.counts)) return 'worried';
  return 'wave';
}

/** A sentence for the welcome box. */
export function moodLine(mood, data) {
  if (!data) return `${PET.name} is looking into the bilge.`;
  if (!data.manifests.length) return 'No package-lock.json, packages.lock.json or .csproj here: /move to a project.';
  if (!data.audit) return `${data.packages.length} packages in ${data.manifests.length} manifest${data.manifests.length === 1 ? '' : 's'}; /audit asks OSV about them.`;
  const line = countLine(data.audit.counts);
  if (!line) return `${PET.name} found nothing known against these ${data.packages.length} packages.`;
  return `${line}: ↵ on one says what it is, f fixes it.`;
}
