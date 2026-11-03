// Peep, Lookout's meerkat. One pixel drawing feeds the terminal pet, the SVG logo and the app icon: a
// meerkat standing up on its hind legs, keeping watch over everything that passes. Run
// `node scripts/logo.js` to make assets/ from it.

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Peep', kind: 'meerkat' };

// The accent for the outline, as the siblings' pets have, a meerkat's sand coat and paler belly
// inside it, and the dark patches round its eyes that make it a meerkat at 16 pixels.
export const PALETTE = {
  G: '#f4a259', // outline, the accent
  S: '#d8b98a', // the coat
  B: '#f1e1c0', // the belly
  D: '#5a3e2b', // eye patches
  E: '#120d09', // eyes
  N: '#3a2a20', // nose
  P: '#8a6a4a', // paws
};

// 16 × 10 pixels; '.' is transparent. Standing up, looking out, paws held in front of its belly.
const BASE = [
  '.....GGGGGG.....',
  '....GSSSSSSG....',
  '...GSDESSEDSG...',
  '...GSSSSSSSSG...',
  '....GSSNNSSG....',
  '.....GSSSSG.....',
  '....GSBBBBSG....',
  '...GSPBBBBPSG...',
  '....GSBBBBSG....',
  '....GGG..GGG....',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 2: '...GSEDSSDESG...' },
  sleep: { 2: '...GSDDSSDDSG...' },
  happy: { 6: '..P.GSBBBBSG.P..', 7: '...GSSBBBBSSG...' },
  worried: { 2: '...GDEEDDEEDG...' },
  wave: { 7: '...GSPBBBBSG.P..' },
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
  look: '(◔ᴥ◔)',
  sleep: '(–ᴥ–)',
  happy: '(^ᴥ^)',
  worried: '(◉ᴥ◉)',
  wave: '(•ᴥ•)/',
};

/**
 * How the pet feels right now: about the last result, then what it sees. `state` is { listening,
 * open, refused, serious } (requests in flight, refused handshakes, high findings).
 */
export function moodFor({ state = {}, lastEntry, now = Date.now() }) {
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (!state.listening) return 'sleep';
  if (state.open) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  if (state.serious || state.refused) return 'worried';
  return state.count ? 'wave' : 'idle';
}

/** A sentence for the welcome box. */
export function moodLine(mood, state = {}) {
  if (!state.listening) return `${PET.name} is curled up: nothing is listening. /start listens on a port.`;
  if (!state.count) return `${PET.name} is keeping watch on ${state.address}. Point a client at it: the Setup view (4) says how.`;
  if (state.serious) return `${state.count} captured; the Security view (3) has what ${PET.name} didn't like.`;
  return `${state.count} captured. ↵ on one shows it, h opens it in Hail.`;
}
