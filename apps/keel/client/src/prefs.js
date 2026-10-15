// Preferences that follow your account across devices: theme, notification
// choices and dashboard layout. The browser keeps a local copy (so pages load
// instantly and work offline); the server copy wins when the app starts.
import { api } from './api.js';

export const PREF_KEYS = {
  theme: 'shipdeck.theme.v1',
  notifications: 'shipdeck.notifications.v1',
  dashboard: 'shipdeck.dashboard.v1',
};

/** Copy the account's saved preferences into this browser (called with /meta). */
export function adoptServerPrefs(prefs = {}) {
  let changed = false;
  for (const [name, key] of Object.entries(PREF_KEYS)) {
    if (prefs[name] === undefined) continue;
    try {
      const value = JSON.stringify(prefs[name]);
      if (localStorage.getItem(key) !== value) {
        localStorage.setItem(key, value);
        changed = true;
      }
    } catch {
      // Storage blocked: the in-memory defaults are used.
    }
  }
  return changed;
}

/** First visit on this account: push what this browser already has. */
export function seedServerPrefs(prefs = {}) {
  const missing = {};
  for (const [name, key] of Object.entries(PREF_KEYS)) {
    if (prefs[name] !== undefined) continue;
    try {
      const local = localStorage.getItem(key);
      if (local) missing[name] = JSON.parse(local);
    } catch {
      // ignore
    }
  }
  if (Object.keys(missing).length) api('/prefs', { method: 'PUT', body: missing }).catch(() => {});
}

const pending = {};
let timer = null;

/** Save one preference to the account (batched; a failure keeps the local copy). */
export function pushPref(name, value) {
  pending[name] = value;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const body = { ...pending };
    for (const k of Object.keys(pending)) delete pending[k];
    api('/prefs', { method: 'PUT', body }).catch(() => {});
  }, 600);
}
