// Flit, Lantern's moth. One pixel drawing feeds the terminal pet, the SVG logo and the app icon: a moth
// with its wings open, drawn to the light, the way Lantern is drawn to a page. Run `node scripts/logo.js`
// to make assets/ from it.
import { findingsLine } from '@fleet/kit/findings.js';

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Flit', kind: 'moth' };

// The accent for the outline, as the siblings' pets have, with a moth's dusty wings inside it, darker
// eye-spots on them, a brown furry body and black eyes.
export const PALETTE = {
  G: '#ffb74d', // outline, the accent
  W: '#e3d3ae', // the wings
  D: '#9a7b52', // their spots
  B: '#6b5440', // the body
  E: '#16120f', // eyes
};

// 16 × 10 pixels; '.' is transparent. The moth from above, antennae up, its four wings spread.
const BASE = [
  '....G......G....',
  '.....G....G.....',
  '.GGG.GBBBBG.GGG.',
  'GWWWGBEBBEBGWWWG',
  'GWDWGBBBBBBGWDWG',
  'GWWWWGBBBBGWWWWG',
  '.GWWGGBBBBGGWWG.',
  '.GWDWGGBBGGWDWG.',
  '..GWWG.BB.GWWG..',
  '...GG..GG..GG...',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 3: 'GWWWGEBBEBBGWWWG' },
  sleep: { 3: 'GWWWGBGBBGBGWWWG' },
  happy: { 0: '...G........G...', 1: '....G......G....' },
  worried: { 3: 'GWWWGEEBBEEGWWWG' },
  wave: { 0: '....G.......G...', 1: '.....G.....G....' },
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
  idle: '(•ᵕ•)',
  look: '(•ᵕ•)',
  sleep: '(–ᵕ–)',
  happy: '(^ᵕ^)',
  worried: '(◉ᵕ◉)',
  wave: '(•ᵕ•)/',
};

const serious = (c) => c && (c.critical || c.high);

/** How the pet feels right now: about the last result, then what the audit of the page found. */
export function moodFor({ result, busy, lastEntry, now = Date.now() }) {
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (busy) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  if (!result) return 'idle';
  if (serious(result.counts)) return 'worried';
  return 'wave';
}

/** A sentence for the welcome box. */
export function moodLine(mood, { pages, result, chrome }) {
  if (!pages?.length) return 'No pages here: /open <url> audits one, or name them in lantern.json or .fleet/project.json.';
  if (chrome === null) return `${PET.name} found no Chrome, Edge or Chromium: the headers, certificate and domain checks still run (/chrome <path> names one).`;
  if (!result) return `${pages.length} page${pages.length === 1 ? '' : 's'} to audit: ↵ or a audits the one under the cursor in a headless Chrome.`;
  const line = findingsLine(result.counts);
  if (!line) return `${PET.name} found nothing wrong on ${result.url}.`;
  return `${line}: 2 lists them, worst first.`;
}
