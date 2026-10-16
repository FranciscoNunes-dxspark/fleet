// Work item type colors chosen by Admins from Keel's approved palette, shared
// by everyone (data/type-colors.json). Types without a choice get the palette
// color closest to their Azure DevOps color, worked out in the browser.
import path from 'node:path';
import { config } from './config.js';
import { sharedJson } from './jsonfile.js';

/** The approved palette's keys (the colors themselves live in the stylesheet, per theme). */
export const PALETTE_KEYS = ['blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet', 'red', 'gray'];

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** { "Bug": "red", ... } with only known palette keys and sane type names. */
export function cleanTypeColors(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Send the colors as { "type name": "color" }.');
  const entries = Object.entries(input);
  if (entries.length > 200) throw bad('Too many work item types.');
  const out = {};
  for (const [type, key] of entries) {
    const name = String(type).trim();
    if (!name || name.length > 128) throw bad('Invalid work item type name.');
    if (key == null || key === '') continue; // back to automatic
    if (!PALETTE_KEYS.includes(key)) throw bad(`"${key}" isn't in the approved palette.`);
    out[name] = key;
  }
  return out;
}

export function createTypeColorStore(file = path.join(config.dataDir, config.mock ? 'type-colors.mock.json' : 'type-colors.json')) {
  const store = sharedJson(file, () => ({ colors: {} }));
  return {
    get: () => ({ ...(store.get().colors || {}) }),
    set(colors) {
      const clean = cleanTypeColors(colors);
      store.save({ colors: clean });
      return clean;
    },
  };
}
