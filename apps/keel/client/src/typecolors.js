// Work item type colors come from Keel's approved palette, never straight from
// Azure DevOps: an Admin's choice wins, otherwise the palette color closest to
// the type's Azure DevOps color, otherwise a default by name. Each palette
// color has a light and a dark step in the stylesheet (--tc-<key>), checked
// for contrast and color-blind separation against Keel's backgrounds.

// The light-mode steps, used only to find the closest color. Labels are English (shown through t()).
export const PALETTE = [
  { key: 'blue', hex: '#2a78d6', label: 'Blue' },
  { key: 'orange', hex: '#eb6834', label: 'Orange' },
  { key: 'aqua', hex: '#1baf7a', label: 'Aqua' },
  { key: 'yellow', hex: '#eda100', label: 'Yellow' },
  { key: 'magenta', hex: '#e87ba4', label: 'Magenta' },
  { key: 'green', hex: '#008300', label: 'Green' },
  { key: 'violet', hex: '#6250d6', label: 'Violet' },
  { key: 'red', hex: '#e34948', label: 'Red' },
  { key: 'gray', hex: '#8a8f98', label: 'Gray' },
];
const KEYS = new Set(PALETTE.map((p) => p.key));
const BY_NAME = { bug: 'red', task: 'yellow', epic: 'orange', feature: 'violet' };

function oklab(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** The palette color closest in hue to an Azure DevOps color; near-grays stay gray. */
export function closestPaletteKey(hex) {
  if (!/^#?[0-9a-f]{6}$/i.test(String(hex || ''))) return null;
  const [, a, b] = oklab(hex);
  if (Math.hypot(a, b) < 0.04) return 'gray';
  // Compare hue and chroma only, so a dark or pale shade still finds its hue.
  let best = null;
  for (const p of PALETTE) {
    if (p.key === 'gray') continue;
    const [, pa, pb] = oklab(p.hex);
    const d = Math.hypot(a - pa, b - pb);
    if (!best || d < best.d) best = { key: p.key, d };
  }
  return best.key;
}

/** What a type gets when no Admin has chosen: closest to its Azure DevOps color, else by name. */
export function autoTypeColor(type, adoHex) {
  return closestPaletteKey(adoHex) || BY_NAME[String(type || '').toLowerCase()] || 'blue';
}

/** The palette key for a type: the Admin's choice, else automatic. */
export function typeColorKey(type, adoHex, chosen = {}) {
  const key = chosen?.[type];
  return KEYS.has(key) ? key : autoTypeColor(type, adoHex);
}

export const paletteVar = (key) => `var(--tc-${KEYS.has(key) ? key : 'blue'})`;
