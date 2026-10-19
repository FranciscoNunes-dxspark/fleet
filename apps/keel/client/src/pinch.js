// Pinch, Keel's crab. One pixel drawing feeds the logo in the app, the favicon and the app icons
// (scripts/logo.mjs), the same way Tiller's otter and Trawl's anglerfish do.
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

/** The drawing as rows of palette letters. */
export function pinchPixels() {
  return [...BASE];
}
