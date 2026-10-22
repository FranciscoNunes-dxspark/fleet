// The Resources view's rows: each resource group as a heading, its apps under it, each app's slots
// under that. Pure.
import { label } from './azure/arm.js';

/**
 * Rows for `apps` (sorted by resource group, then name) with `slots` (app id → its slots):
 * { kind: 'group', text } headings and { kind: 'app' | 'slot', target } rows. `filter` keeps the apps
 * whose name or resource group contains it, and their slots.
 */
export function resourceRows(apps, slots = {}, filter = '') {
  const f = filter.trim().toLowerCase();
  const shown = f ? apps.filter((a) => a.name.toLowerCase().includes(f) || a.resourceGroup.toLowerCase().includes(f)) : apps;
  const rows = [];
  let group = null;
  for (const app of shown) {
    if (app.resourceGroup !== group) {
      group = app.resourceGroup;
      rows.push({ kind: 'group', text: group });
    }
    rows.push({ kind: 'app', target: app });
    for (const slot of slots[app.id] ?? []) rows.push({ kind: 'slot', target: slot });
  }
  return rows;
}

/** Every app and slot by its label ("contoso-web", "contoso-web/staging"), for commands to name one. */
export function targetsByLabel(apps, slots = {}) {
  const out = {};
  for (const a of apps) {
    out[label(a)] = a;
    for (const s of slots[a.id] ?? []) out[label(s)] = s;
  }
  return out;
}

/** Runs `fn` over `items` at most `limit` at a time, resolving with the results in order. */
export async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
