// One palette for the whole UI, dark or light (the Theme setting: "theme": "dark" | "light" | "auto"
// in the config), as Splice has them. The accent can be changed too, in /settings ("accent": "#hex").
// Everything on screen takes its colours from `theme`, read as it draws (a module-level table of
// colours is a function or getters, never values copied at import), so applyTheme repaints the next frame.
import { theme as kitTheme } from '@fleet/kit/theme.js';
export const DARK = {
  accent: '#f78fb3', // DEFAULT_ACCENT, below
  border: '#5f5f5f',
  dim: '#8a8a8a',
  selBg: '#303030',
  ink: '#121212',
  add: '#5fd75f',
  del: '#ff5f5f',
  info: '#5fafd7',
  warn: '#ffd75f',
  bangMode: '#ff87d7',
  // Behind search matches in a log, and the one it's on.
  match: '#5f5f00',
  matchHere: '#af8700',
};

// For a white (or pale) background: darker inks, pale backgrounds behind matches, white on the
// coloured bars.
export const LIGHT = {
  accent: '#b8366b', // LIGHT_ACCENT, below
  border: '#a8a8a8',
  dim: '#6c6c6c',
  selBg: '#e4e4e4',
  ink: '#ffffff',
  add: '#008700',
  del: '#d70000',
  info: '#005f87',
  warn: '#af5f00',
  bangMode: '#d7005f',
  match: '#ffff87',
  matchHere: '#ffaf00',
};

// The kit's theme object (the kit's parts draw from it too), filled with this app's palette.
export const theme = Object.assign(kitTheme, DARK, { mode: 'dark' });

// Windows terminals draw ⏺ as a wide emoji, so use the plain circle there (as Claude Code does).
export const BULLET = process.platform === 'win32' ? '●' : '⏺';

export const DEFAULT_ACCENT = '#f78fb3';
// The default accent on a light background: the same teal, darker.
export const LIGHT_ACCENT = '#b8366b';

export const THEMES = ['dark', 'light', 'auto'];

/** Whether `color` is something the accent can be: "#rrggbb". */
export const isColour = (color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);

/** This theme's own accent: the one Mooring comes with, darker on a light background. */
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

/** Puts the config's theme (dark, light, auto) and accent in place; returns the mode. */
export function applyTheme(config = {}, env = process.env) {
  const mode = themeMode(config.theme, env);
  Object.assign(theme, mode === 'light' ? LIGHT : DARK, { mode });
  setAccent(config.accent);
  return mode;
}
