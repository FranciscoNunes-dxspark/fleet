// Appearance: light/dark/system mode plus an accent color, saved per browser.
// Applied as data attributes on <html>; the colors themselves are CSS tokens.

const KEY = 'shipdeck.theme.v1';

export const MODES = [
  { id: 'system', label: 'System' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
];

// Swatch colors are for the picker; the real values live in styles.css per mode.
export const ACCENTS = [
  { id: 'green', label: 'Green', swatch: '#3ec486' },
  { id: 'blue', label: 'Blue', swatch: '#5b9cf5' },
  { id: 'violet', label: 'Violet', swatch: '#a78bfa' },
  { id: 'teal', label: 'Teal', swatch: '#2ec4c4' },
  { id: 'magenta', label: 'Magenta', swatch: '#d96bd0' },
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
  // Tint the favicon rocket with the accent so pinned tabs match.
  const accent = getComputedStyle(root).getPropertyValue('--accent').trim() || '#3ec486';
  const onAccent = getComputedStyle(root).getPropertyValue('--on-accent').trim() || '#0c1a13';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='${accent}'/><g transform='rotate(45 16 16)'><path d='M14 22.5h4l-.6 3.2L16 28l-1.4-2.3z' fill='#ffd166'/><path d='M12.2 17.5 9 21v2.5l3.2-1.4z' fill='${onAccent}'/><path d='M19.8 17.5 23 21v2.5l-3.2-1.4z' fill='${onAccent}'/><path d='M16 4c2.9 2.3 4.4 5.8 4.4 9.8v8.7h-8.8v-8.7C11.6 9.8 13.1 6.3 16 4z' fill='#ffffff'/><circle cx='16' cy='12.6' r='2' fill='${accent}' stroke='${onAccent}' stroke-width='1'/></g></svg>`;
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
}

/** Re-applies when the OS switches light/dark while "System" is chosen. */
export function watchSystemTheme() {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  const onChange = () => loadTheme().mode === 'system' && applyTheme();
  mq?.addEventListener?.('change', onChange);
  return () => mq?.removeEventListener?.('change', onChange);
}
