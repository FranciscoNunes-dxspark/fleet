// Ping, Sonar's bat. One pixel drawing feeds the terminal pet, the SVG logo and the app icon. Bats
// find their way in the dark by sound, which is what Sonar is for.

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Ping', kind: 'bat' };

// The accent's family, as Trawl's Glim, Splice's Twig and Keel's Pinch are coloured from theirs: the
// accent for the outline, a dark body, the wings a shade lighter, a near-black mouth, and one
// contrasting colour for the eyes.
export const PALETTE = {
  G: '#5fd7d7', // outline, the accent
  D: '#2b4256', // body
  M: '#406680', // wings
  E: '#0b1418', // mouth
  W: '#ffffff', // fangs
  Y: '#ffd75f', // eyes, the one bright colour
};

// 16 × 10 pixels; '.' is transparent. Face on, wings spread: ears up, two bright eyes, a mouth with
// its fangs, the wings' scalloped edges below.
const BASE = [
  '....G......G....',
  '...GDG....GDG...',
  'G..GDDGGGGDDG..G',
  'GG.GDYDDDDYDG.GG',
  'GMGGDDDDDDDDGGMG',
  'GMMGDDDDDDDDGMMG',
  'GMMMGDDEEDDGMMMG',
  '.GMMMGWDDWGMMMG.',
  '..GMG.GDDG.GMG..',
  '...G...GG...G...',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 3: 'GG.GDDYDDDDYG.GG' }, // glancing the other way, for the busy animation
  sleep: { 3: 'GG.GDEDDDDEDG.GG', 6: 'GMMMGDDDDDDGMMMG', 7: '.GMMMGDDDDGMMMG.' },
  happy: { 3: 'GG.GDYDDDDYDG.GG', 6: 'GMMMGDEDDEDGMMMG', 7: '.GMMMGDEEDGMMMG.' },
  worried: { 3: 'GG.GDWDDDDWDG.GG', 6: 'GMMMGDDEEDDGMMMG', 7: '.GMMMGDEEDGMMMG.' },
  // Calling out: mouth open, the call going out.
  wave: { 6: 'GMMMGDEEEEDGMMMG', 7: '.GMMMGWEEWGMMMG.' },
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
