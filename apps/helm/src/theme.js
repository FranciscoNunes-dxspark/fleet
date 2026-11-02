// Helm's palette, filled into the kit's shared theme object (read while drawing, never copied at import).
import { theme as kitTheme } from '@fleet/kit/theme.js';

export const DARK = {
  accent: '#4fc3f7',
  border: '#5f5f5f',
  dim: '#8a8a8a',
  selBg: '#303030',
  ink: '#121212',
  add: '#5fd75f',
  del: '#ff5f5f',
  info: '#5fafd7',
  warn: '#ffd75f',
  bangMode: '#ff87d7',
  match: '#5f5f00',
  matchHere: '#af8700',
};

export const theme = Object.assign(kitTheme, DARK, { mode: 'dark' });
