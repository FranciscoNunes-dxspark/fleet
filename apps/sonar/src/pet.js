// Ping, Sonar's bat. One pixel drawing feeds the terminal pet, the SVG logo and the app icon. Bats
// find their way in the dark by sound, which is what Sonar is for.

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Ping', kind: 'bat' };

// The accent's family, as Trawl's Glim, Splice's Twig and Keel's Pinch are coloured from theirs: the
// accent for the outline, a dark body, the wings a shade lighter, pale inner ears, and one warm colour
// for the cheeks.
export const PALETTE = {
  G: '#b48cff', // outline, the accent lavender
  D: '#4a3570', // body
  M: '#6b4fa0', // wings
  P: '#e0d0ff', // inner ears
  E: '#120c1c', // eyes, mouth
  W: '#ffffff', // eye shine, teeth
  K: '#ff9ec7', // cheeks, the one warm colour
};

// 16 × 10 pixels; '.' is transparent. Face on and round: big ears, eyes with a shine, pink cheeks, a
// small open mouth, short wings either side and two little feet.
const BASE = [
  '...GG......GG...',
  '..GPDG....GDPG..',
  '..GPDDGGGGDDPG..',
  '.GDDDDDDDDDDDDG.',
  'GMGDDWEDDWEDDGMG',
  'GMMDKDDDDDDKDMMG',
  'GMMGDDDEEDDDGMMG',
  '.GMGDDDWWDDDGMG.',
  '..G.GDDDDDDG.G..',
  '.....GG..GG.....',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 4: 'GMGDDEWDDEWDDGMG' }, // glancing the other way, for the busy animation
  sleep: { 4: 'GMGDDEEDDEEDDGMG', 6: 'GMMGDDDDDDDDGMMG', 7: '.GMGDDDDDDDDGMG.' },
  happy: { 6: 'GMMGDDEDDEDDGMMG', 7: '.GMGDDDEEDDDGMG.' },
  worried: { 4: 'GMGDDWWDDWWDDGMG', 6: 'GMMGDDDEEDDDGMMG', 7: '.GMGDDDDDDDDGMG.' },
  // Calling out, mouth wide: the ping going out.
  wave: { 6: 'GMMGDDEEEEDDGMMG', 7: '.GMGDDEWWEDDGMG.' },
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

/** A one-line bat for the header. */
export const FACES = {
  idle: '/•v•\\',
  look: '/•v•\\',
  sleep: '/-v-\\',
  happy: '/^v^\\',
  worried: '/◉v◉\\',
  wave: '/•o•\\',
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
