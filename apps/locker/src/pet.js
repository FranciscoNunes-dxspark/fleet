// Hush, Locker's octopus. One pixel drawing feeds the terminal pet, the SVG logo and the app icon: an
// octopus, eight arms to keep things in, one of them holding a key. Run `node scripts/logo.js` to make
// assets/ from it.
import { expiresWithin } from './expiry.js';

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Hush', kind: 'octopus' };

// The accent (brass) for the outline, as the siblings' pets have, a dusky rose inside it, and a steel
// key, the one cold colour so it reads at 16 pixels.
export const PALETTE = {
  G: '#d9a441', // outline, the accent
  P: '#c4688f', // the body
  T: '#93466a', // the arms
  E: '#1a1016', // eyes
  W: '#ffffff', // the light in them
  K: '#b9c4cf', // the key
};

// 16 × 10 pixels; '.' is transparent. A round head, two eyes, arms curling below, the first holding a key.
const BASE = [
  '.....GGGGGG.....',
  '...GGPPPPPPGG...',
  '..GPPPPPPPPPPG..',
  '..GPEEPPPPEEPG..',
  '..GPWEPPPPWEPG..',
  '..GPPPPPPPPPPG..',
  '...GPPPPPPPPG...',
  '..GTTGTTGTTGTTG.',
  'KKT..GT..TG..TG.',
  'KK...G....G...G.',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 3: '..GPPEEPPPPEEG..', 4: '..GPPWEPPPPWEG..' },
  sleep: { 3: '..GPPPPPPPPPPG..', 4: '..GPGGPPPPGGPG..' },
  happy: { 5: '..GPPEPPPPEPPG..', 6: '...GPPEEEEPPG...' },
  worried: { 5: '..GPPPPEEPPPPG..', 6: '...GPPPEEPPPG...' },
  wave: { 7: '..GTTGTTGTTGTTGT', 6: '...GPPPPPPPPG..T' },
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
  idle: '(•ω•)',
  look: '(•ω•)',
  sleep: '(-ω-)',
  happy: '(^ω^)',
  worried: '(°ω°)',
  wave: '(•ω•)/',
};

/**
 * What is wrong with what Locker holds, for the pet and the family: { expiring, broken, drift }, the
 * secrets and certificates within `days` of running out (or gone), the references that don't resolve,
 * and the rows whose values differ.
 */
export function troubles({ vaultData, matrix, days = 30, now = Date.now() } = {}) {
  const items = [...(vaultData?.secrets ?? []), ...(vaultData?.certificates ?? [])];
  return {
    expiring: items.filter((i) => i.enabled !== false && expiresWithin(i, days, now)),
    broken: (matrix?.rows ?? []).filter((r) => r.broken),
    drift: (matrix?.rows ?? []).filter((r) => r.differs),
  };
}

/** How the pet feels right now: about the last result, a command running, and what is wrong. */
export function moodFor({ loaded, busy, lastEntry, trouble, now = Date.now() }) {
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (busy) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  if (!loaded) return 'idle';
  if (trouble?.expiring.length || trouble?.broken.length || trouble?.drift.length) return 'worried';
  return 'wave';
}

const few = (list, name = (x) => x.name ?? x.key) => `${list.slice(0, 2).map(name).join(', ')}${list.length > 2 ? ` and ${list.length - 2} more` : ''}`;

/** A sentence for the welcome box. */
export function moodLine(mood, { loaded, trouble, target, vault } = {}) {
  if (!loaded) return `${PET.name} is counting the keys.`;
  if (trouble?.expiring.length) return `${few(trouble.expiring)} ${trouble.expiring.length === 1 ? 'runs' : 'run'} out soon: 3 lists what expires.`;
  if (trouble?.broken.length) return `${few(trouble.broken, (r) => r.key)} ${trouble.broken.length === 1 ? "doesn't" : "don't"} resolve: d shows only what's wrong.`;
  if (trouble?.drift.length) return `${trouble.drift.length} setting${trouble.drift.length === 1 ? ' differs' : 's differ'} between the sources: ↵ on one says where.`;
  if (mood === 'worried') return 'Something went wrong: the line below says what.';
  if (!target && !vault) return 'Only this folder so far: /app picks an App Service app, /vault a key vault.';
  return 'Everything agrees, and nothing runs out soon.';
}
