// One palette for the whole UI, dark or light (the Theme setting: "theme": "dark" | "light" | "auto"
// in the config). The accent can be changed too, in /settings ("accent": "#hex"). Everything on
// screen takes its colours from `theme`, read as it draws, so applyTheme repaints the next frame.
export const DARK = {
  accent: '#b48cff', // DEFAULT_ACCENT, below
  border: '#5f5f5f',
  dim: '#8a8a8a',
  selBg: '#303030',
  ink: '#121212',
  add: '#5fd75f',
  del: '#ff5f5f',
  info: '#5fafd7',
  warn: '#ffd75f',
  bangMode: '#ff87d7',
};

// For a white (or pale) background: darker inks, a pale selection, white on the coloured bars.
export const LIGHT = {
  accent: '#7044c4', // LIGHT_ACCENT, below
  border: '#a8a8a8',
  dim: '#6c6c6c',
  selBg: '#e4e4e4',
  ink: '#ffffff',
  add: '#008700',
  del: '#d70000',
  info: '#005f87',
  warn: '#af5f00',
  bangMode: '#d7005f',
};

export const theme = { ...DARK, mode: 'dark' };

// Windows terminals draw ⏺ as a wide emoji, so use the plain circle there (as Claude Code does).
export const BULLET = process.platform === 'win32' ? '●' : '⏺';

export const DEFAULT_ACCENT = '#b48cff';
// The default accent on a light background: the same lavender, darker.
export const LIGHT_ACCENT = '#7044c4';

export const THEMES = ['dark', 'light', 'auto'];

/** Whether `color` is something the accent can be: "#rrggbb". */
export const isColour = (color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);

/** The default accent of the palette in use. */
export const defaultAccent = () => (theme.mode === 'light' ? LIGHT_ACCENT : DEFAULT_ACCENT);

/** Sets the accent; anything that isn't a colour (no setting, say) puts this theme's default back. */
export function setAccent(color) {
  theme.accent = isColour(color) ? color : defaultAccent();
}

/**
 * The terminal's background from COLORFGBG ("15;0", "0;default;15"), which some terminals set: the
 * last number is the background's colour; 7 and 15 (white, bright white) are light. null when it
 * says nothing.
 */
export function backgroundFrom(colorfgbg) {
  const bg = String(colorfgbg ?? '').split(';').at(-1).trim();
  if (!/^\d+$/.test(bg)) return null;
  return bg === '7' || bg === '15' ? 'light' : 'dark';
}

/** The palette a setting asks for: dark, light, or with auto (or none) what COLORFGBG says, else dark. */
export function themeMode(setting, env = process.env) {
  if (setting === 'dark' || setting === 'light') return setting;
  return backgroundFrom(env.COLORFGBG) ?? 'dark';
}

/** Puts the config's theme (dark, light, auto) and accent in place. */
export function applyTheme(config = {}, env = process.env) {
  const mode = themeMode(config.theme, env);
  Object.assign(theme, mode === 'light' ? LIGHT : DARK, { mode });
  setAccent(config.accent);
  return mode;
}
