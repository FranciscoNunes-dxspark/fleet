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
  { id: 'coral', get label() { return t('Coral'); }, swatch: '#f5826b' },
  { id: 'sand', get label() { return t('Sand'); }, swatch: '#dbab96' },
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

/** Applies a theme to the page; returns the resolved mode. */
export function applyTheme(theme = loadTheme()) {
  const mode = theme.mode === 'system' ? (systemDark() ? 'dark' : 'light') : theme.mode;
  const root = document.documentElement;
  root.dataset.mode = mode;
  root.dataset.accent = theme.accent;
  root.style.colorScheme = mode;
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
