// Squawk, Bosun's parrot. One pixel drawing feeds the terminal pet, the SVG logo and the app
// icon. This is slipway's placeholder creature: redraw BASE and MOODS as the real mascot, keep the
// palette letters, and run `node scripts/logo.js` to make assets/ from it.

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Squawk', kind: 'parrot' };

// The accent's family, as Trawl's Glim, Splice's Twig and Keel's Pinch are coloured from theirs: the
// accent for the outline, a darker and a paler shade, a near-black with its tint, and one contrasting colour.
export const PALETTE = {
  G: '#ff6b6b', // outline, the accent
  D: '#8c3b3b', // body
  L: '#ffc4c4', // belly
  E: '#1f0d0d', // eyes
  W: '#ffffff', // eye shine
  T: '#ffb35f', // cheeks, the one warm colour
};

// 16 × 10 pixels; '.' is transparent. A parrot facing right: the beak is the warm colour, the belly
// the pale one; columns 14–15 are room for a wing raised to wave.
const BASE = [
  '..GG.GGGG.......',
  '.GDDGDDDDGG.....',
  '.GDDDDDWEDGGG...',
  'GDDDDDDEEDGTTG..',
  'GDDDDDDDDDGTTTG.',
  'GDDLLLDDDDGGTG..',
  'GDLLLLLDDDG.G...',
  '.GDLLLDDDG......',
  '..GDDDDGG.......',
  '..GTGGTG........',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 2: '.GDDDDDEWDGGG...' }, // glancing the other way, for the busy animation
  sleep: { 2: '.GDDDDDDDDGGG...', 3: 'GDDDDDDEEDGTTG..' },
  happy: { 2: '.GDDDDDEDDGGG...', 3: 'GDDDDDEDEDGTTG..' },
  worried: { 2: '.GDDDDDWWDGGG...', 3: 'GDDDDDDEEDGTTG..' },
  wave: { 5: 'GDDLLLDDDDGGTGGG', 6: 'GDLLLLLDDDGGGDG.', 7: '.GDLLLDDDGDDG...' },
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
  wave: '(•ᴗ•)/',
};

/** How the pet feels right now: about the last result, and whether something is running. */
export function moodFor({ data, busy, lastEntry, now = Date.now() }) {
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (busy) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  if (!data) return 'idle';
  if (data.procs.some((p) => p.status === 'crashed')) return 'worried';
  if (!data.procs.some((p) => p.child)) return 'sleep';
  return 'wave';
}

/** A sentence for the welcome box. */
export function moodLine(mood, data) {
  if (!data) return `${PET.name} is getting things ready.`;
  const crashed = data.procs.filter((p) => p.status === 'crashed').map((p) => p.name);
  if (crashed.length) return `${crashed.join(', ')} crashed: w asks Claude why.`;
  if (mood === 'worried') return 'Something went wrong: the line below says what.';
  const n = data.procs.length;
  if (!n) return 'Nothing to run here yet: /init writes a bosun.json.';
  const up = data.procs.filter((p) => p.child).length;
  return up ? `${up} of ${n} running. r restarts one, R all of them.` : `None of the ${n} running: R starts them.`;
}
