// Plot, Chart's puffin. One pixel drawing feeds the terminal pet, the SVG logo and the app icon: a
// puffin looking out, its striped beak the one warm colour so it reads at 16 pixels. Run
// `node scripts/logo.js` to make assets/ from it.
import { summarize, summaryLine } from './plan.js';

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Plot', kind: 'puffin' };

// The accent for the outline, as the siblings' pets have, with a puffin's black cap, white face and
// orange and red beak.
export const PALETTE = {
  G: '#7986cb', // outline, the accent
  K: '#2a2d36', // the cap and back
  W: '#f2f2f2', // the face
  E: '#111111', // eyes
  O: '#f28c28', // the beak
  R: '#d9473a', // its stripe
  P: '#f28c28', // feet
};

// 16 × 10 pixels; '.' is transparent.
const BASE = [
  '.....GGGGGG.....',
  '....GKKKKKKG....',
  '...GKWWKKWWKG...',
  '...GWEWWWWEWG...',
  '...GWWWOOWWWG...',
  '...GKWORROWKG...',
  '....GKKOOKKG....',
  '....GKWWWWKG....',
  '...PPGWWWWGPP...',
  '.....GGGGGG.....',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 3: '...GEWWWWWEWG...' },
  sleep: { 3: '...GWKWWWWKWG...' },
  happy: { 3: '...GWEWWWWEWG...', 6: '....GKKOOKKG.G..' },
  worried: { 3: '...GEEWWWWEEG...' },
  wave: { 7: '....GKWWWWKGKK..' },
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
  idle: '(•▾•)',
  look: '(•▾•)',
  sleep: '(–▾–)',
  happy: '(^▾^)',
  worried: '(◉▾◉)',
  wave: '(•▾•)/',
};

const losing = (plan) => plan && plan.changes.some((c) => c.action === 'delete' || c.action === 'replace');

/** How the pet feels right now: about the last result, then what the plan does. */
export function moodFor({ data, busy, lastEntry, now = Date.now() }) {
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (busy) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  const plan = data?.plan;
  if (!plan) return 'idle';
  if (losing(plan) || plan.drift.length) return 'worried';
  return plan.changes.every((c) => c.action === 'noop') ? 'sleep' : 'wave';
}

/** A sentence for the welcome box. */
export function moodLine(mood, data) {
  if (!data?.found) return `${PET.name} is looking at the chart.`;
  const f = data.found;
  if (!f.tfDirs.length && !f.bicep.length) return 'No .tf or .bicep files here: /move to an infrastructure folder, or /open a saved plan.';
  const plan = data.plan;
  if (!plan) return f.tfDirs.length ? '/plan asks terraform what it would do; /drift what changed outside it.' : '/whatif <file> --rg <group> asks Azure what a deployment would do.';
  const line = summaryLine(summarize(plan.changes));
  if (plan.drift.length) return `${plan.drift.length} changed outside ${plan.tool === 'terraform' ? 'Terraform' : 'the template'}: 2 shows the drift.`;
  if (!line) return 'Nothing to change: the infrastructure matches.';
  return losing(plan) ? `${line}: something is destroyed, the red rows first.` : `${line}. ↵ on one says what changes.`;
}
