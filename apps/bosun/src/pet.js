// Squawk, Bosun's parrot. One pixel drawing feeds the terminal pet, the SVG logo and the app
// icon. This is slipway's placeholder creature: redraw BASE and MOODS as the real mascot, keep the
// palette letters, and run `node scripts/logo.js` to make assets/ from it.

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Squawk', kind: 'parrot' };

// The accent for the outline, as the siblings' pets have, and a scarlet macaw's own colours inside it:
// a parrot needs its white face, its blue and yellow wing and its two-tone beak to read as one.
export const PALETTE = {
  G: '#ff6b6b', // outline, the accent
  D: '#c0392b', // the red feathers
  E: '#1f0d0d', // eye
  W: '#ffffff', // the bare white face
  T: '#ffb35f', // the yellow band on the wing
  U: '#5fafd7', // the blue wing and tail feathers
  B: '#f2e6d0', // the beak's hooked top
  K: '#3a2a22', // its dark lower half, and the feet
  P: '#8a5a3c', // the branch
};

// 16 × 10 pixels; '.' is transparent. A scarlet macaw on a branch, facing right: the bare white face,
// a hooked beak, and the long tail sweeping down to the left.
const BASE = [
  '........GGGG....',
  '.......GDDDDGG..',
  '......GDWWWGBBG.',
  '......GDWEWBBBBG',
  '......GDWWWKKBBG',
  '.....GDDDDGKK.BG',
  '....GDTTDDG...G.',
  '...GDTUUDDG.....',
  '..GDTUUDGPKPKPPP',
  '.GUUGG..........',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 3: '......GDEWWBBBBG' }, // glancing back, for the busy animation
  sleep: { 3: '......GDEEEBBBBG' },
  happy: { 3: '......GDEWEBBBBG', 4: '......GDWWWK.BBG' },
  worried: { 2: '......GDWEWGBBG.' },
  wave: { 5: '..GUGDDDDDGKK.BG', 6: '..GUTGTDDG...G..', 7: '...GDTUUDDG.....' },
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
