import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Where .env and the data folder are found: the checkout, or for the terminal app's standalone
// executable (scripts/build.js bakes KEEL_VERSION into it), a .keel folder in your home directory.
export const ROOT = process.env.KEEL_VERSION
  ? path.join(os.homedir(), '.keel')
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
