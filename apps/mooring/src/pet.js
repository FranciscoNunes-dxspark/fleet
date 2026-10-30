// Tug, Mooring's sea otter. One pixel drawing feeds the terminal pet, the SVG logo and the app icon: an
// otter holding a mooring line, as sea otters hold paws so they don't drift apart. Run
// `node scripts/logo.js` to make assets/ from it.

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Tug', kind: 'sea otter' };

// The accent (teal) for the outline, as the siblings' pets have, brown fur with a cream muzzle, and a
// rope in the one warm colour that reads at 16 pixels.
export const PALETTE = {
  G: '#3fb8af', // outline, the accent
  B: '#8b5a3c', // the fur
  L: '#e8d3b0', // the muzzle
  N: '#2a1a14', // the nose
  E: '#1a1010', // eyes
  W: '#ffffff', // the light in them
  R: '#d9c28a', // the rope
};

// 16 × 10 pixels; '.' is transparent. Two small ears, a round head with a cream muzzle, a rope held
// across the paws.
const BASE = [
  '...GG......GG...',
  '..GBBGGGGGGBBG..',
  '.GBBBBBBBBBBBBG.',
  '.GBBEEBBBBEEBBG.',
  '.GBBWEBLLBWEBBG.',
  '.GBBBLLNNLLBBBG.',
  '..GBBLLLLLLBBG..',
  '..GGBBBLLBBBGG..',
  '.GBRRRRRRRRRRBG.',
  '..GGGGGGGGGGGG..',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 3: '.GBBBEEBBBBEEBG.', 4: '.GBBBWEBLLBWEBG.' },
  sleep: { 3: '.GBBBBBBBBBBBBG.', 4: '.GBBEEBLLBEEBBG.' },
  happy: { 6: '..GBBLEEEELBBG..' },
  worried: { 3: '.GBBEBBBBBBEBBG.', 6: '..GBBLLEELLBBG..' },
  wave: { 5: '.GBBBLLNNLLBBBGB', 6: '..GBBLLLLLLBBGBG' },
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
  idle: '(·o·)',
  look: '(·o·)',
  sleep: '(-o-)',
  happy: '(^o^)',
  worried: '(°o°)',
  wave: '(·o·)/',
};

/** What is wrong right now, for the pet and the family: the transfers that failed and the connection's problem. */
export function troubles({ transfers = [], conn } = {}) {
  return { failed: transfers.filter((t) => t.status === 'failed'), problem: conn?.problem ?? null };
}

/** How the pet feels right now: about the last result, a command or transfer running, and what is wrong. */
export function moodFor({ loaded, connected, busy, running, lastEntry, trouble, now = Date.now() }) {
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (busy || running) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  if (!loaded) return 'idle';
  if (trouble?.failed.length || trouble?.problem) return 'worried';
  return connected ? 'wave' : 'sleep';
}

const few = (list, name = (x) => x.name) => `${list.slice(0, 2).map(name).join(', ')}${list.length > 2 ? ` and ${list.length - 2} more` : ''}`;

/** A sentence for the welcome box. */
export function moodLine(mood, { loaded, connected, host, trouble, running = 0, hosts = 0 } = {}) {
  if (!loaded) return `${PET.name} is looking around this machine.`;
  if (trouble?.problem) return `The last connection failed: ${String(trouble.problem).split('\n')[0]}`;
  if (trouble?.failed.length) return `${few(trouble.failed)} didn't copy: 2 shows why, r tries again.`;
  if (running) return `${running} transfer${running === 1 ? ' is' : 's are'} moving: 2 shows how far.`;
  if (mood === 'worried') return 'Something went wrong: the line below says what.';
  if (!connected) return hosts ? 'Not connected: 3 lists your hosts, ↵ opens one.' : 'No hosts yet: /add <name> <user@host> saves one.';
  return `Connected to ${host}: space marks, c copies to the other pane, $ runs a command there.`;
}
