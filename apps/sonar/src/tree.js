// The Resources view's rows: each resource group as a heading, its apps under it, each app's slots
// under that. Pure.
import { label } from './azure/arm.js';

/**
 * Rows for `apps` (sorted by resource group, then name) with `slots` (app id → its slots), and the
 * other kinds in `others` ({ containers, storage, sqlServers }, each server with its `databases`):
 * { kind: 'group', text } headings, then per group its apps (each followed by its slots), container
 * apps, SQL servers (each followed by its databases) and storage accounts, as { kind, target } with
 * kind 'app' | 'slot' | 'container' | 'sqlserver' | 'sqldb' | 'storage'. `filter` keeps what has it in
 * its name or resource group (a server stays for a database that has it).
 */
export function resourceRows(apps, slots = {}, filter = '', others = {}) {
  const f = filter.trim().toLowerCase();
  const has = (t) => !f || t.name.toLowerCase().includes(f) || (t.resourceGroup ?? '').toLowerCase().includes(f);
  const groups = new Map();
  const add = (t, rows) => {
    const g = t.resourceGroup ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ order: rows[0].order, name: t.name.toLowerCase(), rows });
  };
  for (const app of apps.filter(has)) add(app, [{ order: 0, kind: 'app', target: app }, ...(slots[app.id] ?? []).map((s) => ({ kind: 'slot', target: s }))]);
  for (const c of (others.containers ?? []).filter(has)) add(c, [{ order: 1, kind: 'container', target: c }]);
  for (const server of others.sqlServers ?? []) {
    const dbs = has(server) ? (server.databases ?? []) : (server.databases ?? []).filter(has);
    if (!has(server) && !dbs.length) continue;
    add(server, [{ order: 2, kind: 'sqlserver', target: server }, ...dbs.map((d) => ({ kind: 'sqldb', target: d }))]);
  }
  for (const a of (others.storage ?? []).filter(has)) add(a, [{ order: 3, kind: 'storage', target: a }]);
  const rows = [];
  // Groups in the order their first app came (apps arrive sorted), then the ones with only other kinds, by name.
  const names = [...groups.keys()].sort((x, y) => {
    const ix = apps.findIndex((a) => a.resourceGroup === x);
    const iy = apps.findIndex((a) => a.resourceGroup === y);
    return (ix < 0 ? Infinity : ix) - (iy < 0 ? Infinity : iy) || x.localeCompare(y);
  });
  for (const g of names) {
    rows.push({ kind: 'group', text: g });
    // Apps keep the order they came in; the other kinds follow, by kind and then name.
    const items = groups.get(g).map((it, i) => ({ ...it, i })).sort((x, y) => x.order - y.order || (x.order === 0 ? x.i - y.i : x.name.localeCompare(y.name)));
    for (const it of items) for (const r of it.rows) rows.push({ kind: r.kind, target: r.target });
  }
  return rows;
}

/** SQL servers by name and databases as "server/database", for /trawl and /firewall to name one. */
export function sqlByLabel(sqlServers = []) {
  const out = {};
  for (const s of sqlServers) {
    out[s.name] = s;
    for (const d of s.databases ?? []) out[label(d)] = d;
  }
  return out;
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

/** The app or slot that serves `url` (a monitor's, say), by its default host or a custom domain; null if none. */
export function targetForUrl(apps, slots = {}, url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = String(url ?? '').toLowerCase();
  }
  const all = apps.flatMap((a) => [a, ...(slots[a.id] ?? [])]);
  return all.find((t) => (t.hostNames ?? [t.host]).some((h) => h?.toLowerCase() === host)) ?? null;
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
