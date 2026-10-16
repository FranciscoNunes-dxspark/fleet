// Appearance: light/dark/system mode plus an accent color, saved to your account.
// Applied as data attributes on <html>; the colors themselves are CSS tokens.

import { PREF_KEYS, pushPref } from './prefs.js';
import { t } from './i18n.js';

const KEY = PREF_KEYS.theme;

// Labels are getters so they follow the current language.
export const MODES = [
  { id: 'system', get label() { return t('System'); } },
  { id: 'dark', get label() { return t('Dark'); } },
  { id: 'light', get label() { return t('Light'); } },
];

// Swatch colors are for the picker; the real values live in styles.css per mode.
export const ACCENTS = [
  { id: 'green', get label() { return t('Green'); }, swatch: '#3ec486' },
  { id: 'blue', get label() { return t('Blue'); }, swatch: '#5b9cf5' },
  { id: 'violet', get label() { return t('Violet'); }, swatch: '#a78bfa' },
  { id: 'teal', get label() { return t('Teal'); }, swatch: '#2ec4c4' },
  { id: 'magenta', get label() { return t('Magenta'); }, swatch: '#d96bd0' },
];

const DEFAULT = { mode: 'dark', accent: 'green' };

export function loadTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    return {
      mode: MODES.some((m) => m.id === saved?.mode) ? saved.mode : DEFAULT.mode,
      accent: ACCENTS.some((a) => a.id === saved?.accent) ? saved.accent : DEFAULT.accent,
    };
  } catch {
    return { ...DEFAULT };
  }
}

const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;

/** Applies a theme to the page (and the browser-tab icon); returns the resolved mode. */
export function applyTheme(theme = loadTheme()) {
  const mode = theme.mode === 'system' ? (systemDark() ? 'dark' : 'light') : theme.mode;
  const root = document.documentElement;
  root.dataset.mode = mode;
  root.dataset.accent = theme.accent;
  root.style.colorScheme = mode;
  // Tint the favicon with the accent so pinned tabs match.
  const accent = getComputedStyle(root).getPropertyValue('--accent').trim() || '#3ec486';
  const onAccent = getComputedStyle(root).getPropertyValue('--on-accent').trim() || '#0c1a13';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='${accent}'/><path d='M16.6 3.8 23.8 11.4h-7.2z' fill='#ffffff'/><path d='M15.4 5.8 10.6 11.4h4.8z' fill='#ffffff' opacity='.75'/><path d='M4 12.6h24c-.7 2.7-2.6 4.6-5.6 4.9H10.2C7.3 17.2 5.2 15.4 4 12.6z' fill='#ffffff'/><path d='M14.2 17.4h4l-1 5.6h-2.2z' fill='${onAccent}'/><path d='M12.4 24.2c0-.9 1.8-1.6 4-1.6s4 .7 4 1.6-1.8 1.6-4 1.6-4-.7-4-1.6z' fill='${onAccent}'/></svg>`;
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  return mode;
}

export function saveTheme(theme) {
  try {
    localStorage.setItem(KEY, JSON.stringify(theme));
  } catch {
    // Storage blocked: the theme lasts for this visit.
  }
  applyTheme(theme);
  pushPref('theme', theme); // follows your account to other devices
}

/** Re-applies when the OS switches light/dark while "System" is chosen. */
export function watchSystemTheme() {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  const onChange = () => loadTheme().mode === 'system' && applyTheme();
  mq?.addEventListener?.('change', onChange);
  return () => mq?.removeEventListener?.('change', onChange);
}
