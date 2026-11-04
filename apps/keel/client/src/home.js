// Which page Keel opens on: "/" goes there. One of a short list (the pages that make sense as a
// start), kept in this browser and on the account like the theme, so it follows you.
import { PREF_KEYS, pushPref } from './prefs.js';
import { t } from './i18n.js';

/** The pages that can be home: [path, name]. The Line is the default, as it always was. */
export const HOMES = [
  ['/line', () => t('The Line')],
  ['/desk', () => t('Now (the Desk)')],
  ['/inbox', () => t('Inbox')],
  ['/prs', () => t('Pull requests')],
  ['/work', () => t('Work items')],
  ['/board', () => t('Board')],
  ['/pipelines', () => t('Pipelines')],
  ['/control', () => t('Control room')],
  ['/production', () => t('Monitors')],
  ['/summary', () => t('Weekly summary')],
];
export const DEFAULT_HOME = '/line';

export const isHomeable = (path) => HOMES.some(([p]) => p === path);

/** The page "/" opens. */
export function loadHome() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEYS.home) || 'null');
    return isHomeable(saved?.path) ? saved.path : DEFAULT_HOME;
  } catch {
    return DEFAULT_HOME;
  }
}

/** Makes `path` home, here and on the account. */
export function saveHome(path) {
  if (!isHomeable(path)) return;
  try {
    localStorage.setItem(PREF_KEYS.home, JSON.stringify({ path }));
  } catch {
    // Storage blocked: it lasts until the page is reloaded, through the account copy.
  }
  pushPref('home', { path });
}
