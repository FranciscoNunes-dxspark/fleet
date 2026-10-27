import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Read per call so tests can point LOCKER_HOME somewhere temporary.
export const configDir = () => process.env.LOCKER_HOME || join(homedir(), '.locker');

/** Where the settings are kept, to show in /settings. */
export const configFile = () => join(configDir(), 'config.json');

// How many days ahead an expiry counts as soon, and how long a copied value stays on the clipboard.
export const EXPIRY_DAYS = 30;
export const CLEAR_AFTER = 30;

const DEFAULTS = { history: [] };

export function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(configFile(), 'utf8')) };
  } catch {
    // Not there (or unreadable): the defaults.
    return { ...DEFAULTS };
  }
}

/** The expiry window in days, from the config's `expiryDays` (30 when unset or not a number). */
export const expiryDays = (config) => (Number(config?.expiryDays) > 0 ? Number(config.expiryDays) : EXPIRY_DAYS);

/** Seconds a copied value stays on the clipboard, from `clearClipboard` (30; 0 leaves it there). */
export const clearAfter = (config) => (config?.clearClipboard != null && Number(config.clearClipboard) >= 0 ? Number(config.clearClipboard) : CLEAR_AFTER);

// The file holds which app and vault Locker looks at, never what is in them.
export function saveConfig(config) {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configFile(), JSON.stringify(config, null, 2));
  } catch {
    // A read-only home folder shouldn't stop the app; settings just won't stick.
  }
}
