// Pinch, Keel's crab. One pixel drawing feeds the logo in the app, the favicon and the app icons
// (scripts/logo.mjs) and the terminal app's pet (cli/), the same way Tiller's otter and Trawl's anglerfish do.
// A crab sees all around it without turning its head, which is roughly what a console does.

export const PALETTE = {
  C: '#ff8a65', // outline, claws and legs, the coral accent
  D: '#d9573b', // shell
  L: '#ffc2a6', // the shell's pale rim
  E: '#1c0e0a', // pupils, mouth
  W: '#ffffff', // eyes
};

/** The dark square the crab sits on. */
export const BG = '#24140f';

// 16 × 10 pixels; '.' is transparent. Claws raised and open at the top corners, eyes on stalks
// between them, a wide shell with a pale rim, and legs underneath.
const BASE = [
  'CC.C.WW..WW.C.CC',
  'CDCC.WE..WE.CCDC',
  'CDDC..C..C..CDDC',
  '.CDCCCCCCCCCCDC.',
  '..CDDDDDDDDDDC..',
  '.CDDDDEDDEDDDDC.',
  '.CDDDDDEEDDDDDC.',
  '..CLLLLLLLLLLC..',
  '.C.CCCCCCCCCC.C.',
  'C..C.C....C.C..C',
];

// Each mood replaces some rows of the base drawing. The icons only use idle.
const MOODS = {
  idle: {},
  look: { 1: 'CDCC.EW..EW.CCDC' }, // glancing the other way, while Azure DevOps answers
  sleep: { 0: 'CC.C........C.CC', 1: 'CDCC.CC..CC.CCDC', 5: '.CDDDDDDDDDDDDC.' }, // eyes shut: nothing needs you
  happy: { 5: '.CDDDEDDDDEDDDC.', 6: '.CDDDDEEEEDDDDC.' },
  worried: { 0: 'CC.C.WE..EW.C.CC', 1: 'CDCC.WW..WW.CCDC', 5: '.CDDDDDEEDDDDDC.', 6: '.CDDDDEDDEDDDDC.' },
};

/** The drawing for a mood, as rows of palette letters. */
export function pinchPixels(mood = 'idle') {
  const over = MOODS[mood] ?? {};
  return BASE.map((row, i) => over[i] ?? row);
}

/**
 * How Pinch looks in the web app: worried while Azure DevOps answers the live checks with an
 * error, glancing about during a refresh, asleep when nothing needs you, and otherwise watching.
 * (Losing the connection to Keel's own server is the live badge's to show, not a worry.)
 */
export function pinchMood({ attention, live, busy } = {}) {
  if (live?.connected && live.ok === false && live.error) return 'worried';
  if (busy) return 'look';
  if (attention && !attention.items?.length) return 'sleep';
  return 'idle';
}
