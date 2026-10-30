import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Read per call so tests can point MOORING_HOME somewhere temporary.
export const configDir = () => process.env.MOORING_HOME || join(homedir(), '.mooring');

/** Where the settings are kept, to show in /settings. */
export const configFile = () => join(configDir(), 'config.json');

const DEFAULTS = { hosts: [], history: [] };

export function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(configFile(), 'utf8')) };
  } catch {
    // Not there (or unreadable): the defaults.
    return { ...DEFAULTS };
  }
}

// The file holds where each host is and which key signs in to it, never a password or a passphrase:
// ssh runs without a terminal (BatchMode), so a key or the agent is all it can use.
export function saveConfig(config) {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configFile(), JSON.stringify(config, null, 2));
  } catch {
    // A read-only home folder shouldn't stop the app; settings just won't stick.
  }
}
