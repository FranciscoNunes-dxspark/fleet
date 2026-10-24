import { theme as kitTheme } from '@fleet/kit/theme.js';

// One palette for the whole terminal app. The accent is Pinch's coral, as Tiller's is Knot's
// green and Trawl's is Glim's blue. It fills the kit's theme object, which the kit's parts draw from too.
export const theme = Object.assign(kitTheme, {
  accent: '#ff8a65',
  border: '#5f5f5f',
  dim: '#8a8a8a',
  selBg: '#3a2219',
  ink: '#121212',
  ok: '#5fd75f',
  del: '#ff5f5f',
  warn: '#ffd75f',
  info: '#5fafd7',
  draft: '#af87ff',
});

// Windows terminals draw ⏺ as a wide emoji, so use the plain circle there (as Claude Code does).
export const BULLET = process.platform === 'win32' ? '●' : '⏺';
