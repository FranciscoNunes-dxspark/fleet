// Sites that publish platform endpoints (schema "platform/v1" by default; set
// KEEL_PLATFORM_SCHEMA for a site that names its own): GET /health (no auth)
// and GET /totals (X-Totals-Key). Both answer the same envelope: { schema,
// kind, product, site, version, status, generatedAt, durationMs,
// checks: [{ name, status, durationMs, message }], data }.
// The names and order of the figures come from data/platform-labels.json.

import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA = process.env.KEEL_PLATFORM_SCHEMA?.trim() || 'platform/v1';
export const TOTALS_TIMEOUT_MS = 300_000; // the stored procedure can take up to 5 minutes
export const TOTALS_EVERY_HOURS = [1, 6, 12, 24];
export const TOTALS_SEASONS = ['current', 'all'];

const STATUSES = ['ok', 'degraded', 'down'];

/** The envelope, or null when the body isn't one (an App Service error page, another app). */
export function asEnvelope(body) {
  if (!body || typeof body !== 'object' || body.schema !== SCHEMA) return null;
  if (!STATUSES.includes(body.status)) return null;
  return body;
}

/** What a health check keeps from the envelope (never the raw body). */
export function platformInfo(env) {
  const failing = (Array.isArray(env.checks) ? env.checks : [])
    .filter((c) => c && c.status !== 'ok')
    .map((c) => ({ name: String(c.name || ''), status: STATUSES.includes(c.status) ? c.status : 'down', message: c.message ? String(c.message).slice(0, 300) : null }));
  return {
    status: env.status,
    product: env.product ? String(env.product) : null,
    site: env.site ? String(env.site) : null,
    version: env.version ? String(env.version) : null,
    failing,
  };
}

/** One line for a dashboard: the first failing check's message, or a fallback. */
export function failingText(info, fallback) {
  const c = info.failing.find((x) => x.status === info.status) || info.failing[0];
  return c?.message || (c ? `${c.name}: ${c.status}` : fallback);
}

const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);

/**
 * A /totals answer turned into a snapshot to store, or an error to show.
 * status: the HTTP status; body: parsed JSON or null.
 */
export function readTotals(status, body, at = new Date().toISOString()) {
  if (status === 404) return { error: 'The site answered 404 to /totals: check the totals key, or that the site has one configured.' };
  const env = asEnvelope(body);
  if (!env) return { error: `The site did not answer with platform totals (HTTP ${status}).` };
  if (env.kind !== 'totals') return { error: `The site answered a "${env.kind}" response instead of totals.` };
  if (env.status === 'down' || !env.data) {
    const info = platformInfo(env);
    return { error: failingText(info, `The site could not calculate the totals (HTTP ${status}).`) };
  }
  const info = platformInfo(env);
  const season = env.data.season || {};
  const totals = (Array.isArray(env.data.totals) ? env.data.totals : [])
    .filter((x) => x && typeof x.type === 'string' && x.type)
    .map((x) => ({
      type: x.type,
      typeId: Number.isFinite(Number(x.typeId)) ? Number(x.typeId) : null,
      areas: Array.isArray(x.areas) ? x.areas.map(String) : [],
      total: int(x.total),
      months: x.monthly && Array.isArray(x.months)
        ? x.months.filter((mo) => mo && mo.month >= 1 && mo.month <= 12).map((mo) => ({ month: int(mo.month), count: int(mo.count) }))
        : null,
    }));
  return {
    snapshot: {
      at,
      generatedAt: env.generatedAt || null,
      durationMs: int(env.durationMs),
      status: env.status,
      product: info.product,
      site: info.site,
      version: info.version,
      failing: info.failing,
      season: { scope: season.scope === 'all' ? 'all' : 'season', id: season.id || null, name: season.name || null },
      totals,
    },
  };
}

/** The compact form kept in history: one number per figure. */
export const historyPoint = (snap) => ({
  at: snap.at,
  seasonId: snap.season.scope === 'all' ? 'all' : snap.season.id,
  values: Object.fromEntries(snap.totals.map((x) => [x.type, x.total])),
});

// ------------------------------------------------------------ demo data
const DEMO_SITES = {
  'platform-a': { product: 'Storefront', site: 'shop-eu', scale: 1.4 },
  'platform-b': { product: 'Storefront', site: 'shop-qa', scale: 0.35 },
  'platform-c': { product: 'Marketplace', site: 'market-us', scale: 1.1 },
};
export const isDemoPlatform = (demo) => !!DEMO_SITES[demo];

const DEMO_TYPES = [
  [1, 'customers', ['accounts'], 520, true], [2, 'usersAll', ['accounts'], 1210, false], [3, 'staffUsers', ['accounts'], 640, false],
  [4, 'orders', ['sales'], 2400, true], [5, 'invoices', ['sales'], 2300, true], [6, 'refunds', ['sales'], 140, true],
  [7, 'products', ['catalogue'], 310, false], [8, 'categories', ['catalogue'], 24, false], [9, 'reviews', ['catalogue'], 860, true],
  [10, 'shipments', ['logistics'], 2100, true], [11, 'warehouses', ['logistics'], 6, false],
  [12, 'webLogins', ['accounts'], 5400, true], [13, 'appLogins', ['accounts'], 8800, true],
];

/** A demo /health envelope (the second site's database is slow now and then). */
export function demoHealth(demo, at = Date.now()) {
  const s = DEMO_SITES[demo];
  const down = demo === 'platform-b' && Math.floor(at / (7 * 60_000)) % 5 === 0;
  return {
    schema: SCHEMA, kind: 'health', product: s.product, site: s.site, version: '1.0.0.0', status: down ? 'down' : 'ok',
    generatedAt: new Date(at).toISOString(), durationMs: down ? 3004 : 18,
    checks: [{ name: 'database', status: down ? 'down' : 'ok', durationMs: down ? 3001 : 14, message: down ? 'The database did not answer in time.' : null }],
    data: null,
  };
}

/** A demo /totals envelope that grows over time, so history and deltas show something. */
export function demoTotals(demo, at = Date.now()) {
  const s = DEMO_SITES[demo];
  const seasonStart = Date.UTC(2026, 6, 1); // July
  const progress = Math.min(1, Math.max(0.05, (at - seasonStart) / (365 * 86_400_000)));
  const appLoginsDown = demo === 'platform-c';
  const totals = DEMO_TYPES
    .filter(([, type]) => !(appLoginsDown && type === 'appLogins'))
    .map(([typeId, type, areas, base, monthly]) => {
      const total = Math.round(base * s.scale * (monthly ? progress * 4 : 0.9 + progress * 0.2));
      let months = null;
      if (monthly) {
        // Spread over the months from July to now.
        const now = new Date(at);
        const list = [];
        for (let d = new Date(Date.UTC(2026, 6, 1)); d <= now; d.setUTCMonth(d.getUTCMonth() + 1)) list.push(d.getUTCMonth() + 1);
        const weights = list.map((_, i) => 1 + ((i * 7 + typeId) % 5) / 4);
        const sum = weights.reduce((a, b) => a + b, 0);
        let left = total;
        months = list.map((month, i) => {
          const count = i === list.length - 1 ? left : Math.round((total * weights[i]) / sum);
          left -= count;
          return { month, count: Math.max(0, count) };
        });
      }
      return { typeId, type, areas, total, monthly, months };
    });
  return {
    schema: SCHEMA, kind: 'totals', product: s.product, site: s.site, version: '1.0.0.0', status: appLoginsDown ? 'degraded' : 'ok',
    generatedAt: new Date(at).toISOString(), durationMs: 3900,
    checks: [
      { name: 'platformTotals', status: 'ok', durationMs: 3700, message: null },
      { name: 'appLogins', status: appLoginsDown ? 'degraded' : 'ok', durationMs: 0, message: appLoginsDown ? 'This figure could not be read from the audit log.' : null },
    ],
    data: { season: { scope: 'season', id: `demo-season-2026-${demo}`, name: '2026/2027' }, totals },
  };
}

// ------------------------------------------------------------ labels
const EMPTY_CATALOGUE = { types: {}, areas: {}, areaOrder: [], keyFigures: [] };
const strings = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([, v]) => typeof v === 'string'));

/**
 * The names and order of the figures, from <data>/platform-labels.json:
 * { types: { id: "Label" }, areas: { id: "Label" }, areaOrder: [id], keyFigures: [id] }.
 * Missing or unreadable, figures read as words made from their ids.
 */
export function readCatalogue(dataDir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dataDir, 'platform-labels.json'), 'utf8'));
    const list = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
    return { types: strings(c.types), areas: strings(c.areas), areaOrder: list(c.areaOrder), keyFigures: list(c.keyFigures) };
  } catch {
    return EMPTY_CATALOGUE;
  }
}
