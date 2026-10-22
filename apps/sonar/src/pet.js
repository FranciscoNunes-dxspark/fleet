// Ping, Sonar's dolphin. One pixel drawing feeds the terminal pet, the SVG logo and the app icon.
// Dolphins find their way by sound in water they can't see through, which is what Sonar is for.

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Ping', kind: 'dolphin' };

// The accent's family, as Trawl's Glim, Splice's Twig and Keel's Pinch are coloured from theirs: the
// accent for the outline, a darker and a paler shade, a near-black with its tint, and one contrasting colour.
export const PALETTE = {
  G: '#5fd7d7', // outline, the accent
  D: '#347676', // back
  L: '#bfefef', // belly
  E: '#0b1a1a', // eye
  W: '#ffffff', // eye shine
  T: '#ffb35f', // the ping, the one warm colour
};

// 16 × 10 pixels; '.' is transparent. A dolphin facing right, its dorsal fin up top and its beak at
// the right edge; the corner above the beak is room for the sonar's ping.
const BASE = [
  '......GG........',
  '.....GDDG.......',
  '...GGDDDDGGG....',
  '..GDDDDDDDDDGG..',
  '.GDDDDDDDDEWDDG.',
  'GDDDDDDDDDEEDDDG',
  'GDLLLLLLLLLLLLGG',
  '.GLLLLLLLLLLGG..',
  '..GGLLLLLGGG....',
  '....GGGGG.......',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 4: '.GDDDDDDDDWEDDG.' }, // glancing the other way, for the busy animation
  sleep: { 4: '.GDDDDDDDDDDDDG.', 5: 'GDDDDDDDDDEEDDDG' },
  happy: { 4: '.GDDDDDDDDEDDDG.', 5: 'GDDDDDDDDEDEDDDG' },
  worried: { 4: '.GDDDDDDDDWWDDG.' },
  // Pinging: rings going out from its head.
  wave: { 0: '......GG.....T..', 1: '.....GDDG....T.T', 2: '...GGDDDDGGG..T.' },
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
  idle: '(•ᴗ•)',
  look: '(•ᴗ•)',
  sleep: '(–ᴗ–)',
  happy: '(^ᴗ^)',
  worried: '(◉ᴗ◉)',
  wave: '(•ᴗ•))',
};

/** How the pet feels right now: about the last result, and whether something is running. */
export function moodFor({ data, busy, lastEntry, now = Date.now() }) {
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (busy) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  if (!data) return 'idle';
  return 'wave';
}

/** A sentence for the welcome box. */
export function moodLine(mood, data) {
  if (!data) return `${PET.name} is listening for your subscription.`;
  if (mood === 'worried') return 'Something went wrong: the line below says what.';
  const n = data.apps.length;
  return `${n} app${n === 1 ? '' : 's'} in ${data.subscription.name}. ${PET.name} pings them for you.`;
}
