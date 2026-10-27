// What Locker reads, and how it becomes the drift view's columns. The reads go through the provider
// (azure/arm.js or demo.js) and the local side (local.js or demo.js); the rest is pure.
import { label } from './azure/arm.js';
import { parseReference, isReference } from './keys.js';

/** Runs `fn` over `items`, `limit` at a time, keeping the order. */
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

/** The subscription to read: the config's when it's still there, else az's current one, else the first. */
export function pickSubscription(subs, { saved, current } = {}) {
  return subs.find((s) => s.id === saved) ?? subs.find((s) => s.id === current?.id) ?? current ?? subs[0] ?? null;
}

/**
 * The subscription read: { subscription, subscriptions, sites (with their slots after them), vaults }.
 * Slots are read six apps at a time; an app whose slots can't be read just has none.
 */
export async function loadSubscription(provider, { saved, signal } = {}) {
  const current = await provider.currentSubscription?.({ signal }).catch(() => null);
  const subscriptions = await provider.subscriptions({ signal }).catch((e) => (current ? [current] : Promise.reject(e)));
  const subscription = pickSubscription(subscriptions, { saved, current });
  if (!subscription) throw new Error('No subscription to read: az account list shows none.');
  const [sites, vaults] = await Promise.all([provider.sites(subscription.id, { signal }), provider.vaults(subscription.id, { signal }).catch(() => [])]);
  const slots = await mapLimited(sites, 6, (s) => provider.slots(s, { signal }).catch(() => []));
  return { subscription, subscriptions, sites: sites.flatMap((s, i) => [s, ...slots[i]]), vaults };
}

/**
 * The app or slot to compare when none was picked before: the one saved (by id), else the only app there
 * is, else the one named as the folder is (shop-api for a folder shop-api); null otherwise.
 */
export function pickTarget(sites, { saved, dir } = {}) {
  const byId = sites.find((s) => s.id === saved?.id);
  if (byId) return byId;
  if (saved?.label) {
    const byLabel = sites.find((s) => label(s).toLowerCase() === saved.label.toLowerCase());
    if (byLabel) return byLabel;
  }
  const apps = sites.filter((s) => !s.slot);
  if (apps.length === 1) return apps[0];
  const base = String(dir ?? '').split(/[\\/]/).filter(Boolean).pop()?.toLowerCase();
  return (base && apps.find((s) => s.name.toLowerCase() === base)) || null;
}

/** An app's or slot's settings, connection strings and what App Service says of its references. */
export async function loadTarget(provider, target, { signal } = {}) {
  const [settings, strings, references] = await Promise.all([
    provider.settings(target, { signal }),
    provider.connectionStrings(target, { signal }).catch(() => ({})),
    provider.references(target, { signal }).catch(() => []),
  ]);
  return { settings, strings, references };
}

/** A vault's secrets and certificates; certificates it may not list are left out rather than failing the whole. */
export async function loadVault(provider, vault, { signal } = {}) {
  const [secrets, certificates] = await Promise.all([provider.secrets(vault, { signal }), provider.certificates(vault, { signal }).catch(() => [])]);
  return { secrets, certificates };
}

/** The vaults an app's references name (lower case), so they can be listed to check them. */
export function referencedVaults(app) {
  const names = new Set();
  for (const v of [...Object.values(app?.settings ?? {}), ...Object.values(app?.strings ?? {}).map((s) => s.value)]) {
    if (!isReference(v)) continue;
    const ref = parseReference(v);
    if (ref?.vault) names.add(ref.vault);
  }
  return [...names];
}

/** An app's settings and connection strings as one column's entries: { key, value, status, connection? }. */
export function appEntries(app) {
  const status = new Map((app?.references ?? []).map((r) => [r.name.toLowerCase(), r.status]));
  return [
    ...Object.entries(app?.settings ?? {}).map(([key, value]) => ({ key, value: String(value ?? ''), status: status.get(key.toLowerCase()) })),
    ...Object.entries(app?.strings ?? {}).map(([name, s]) => ({ key: `ConnectionStrings:${name}`, value: String(s?.value ?? ''), status: status.get(name.toLowerCase()), connection: true })),
  ];
}

/** The local sources shown unless you choose: all but Hail's env files, whose keys name requests' variables rather than settings. */
export const shownByDefault = (source) => source.kind !== 'http';

/** Whether a source is a column now, by the config's `columns` ({ id: true|false }) or the default. */
export const isShown = (source, choices = {}) => (source.id in choices ? Boolean(choices[source.id]) : shownByDefault(source));

/**
 * The drift view's columns, in order: the local sources shown, the app (or slot), and the vault, each
 * { id, label, kind: 'local'|'app'|'vault', entries, source? }.
 */
export function driftColumns({ local = [], choices = {}, target = null, app = null, vault = null, vaultData = null }) {
  const cols = local.filter((s) => isShown(s, choices)).map((s) => ({ id: s.id, label: s.label, kind: 'local', entries: s.entries, source: s, ...(s.example ? { presence: true } : {}) }));
  if (target && app && isShown({ id: 'app', kind: 'app' }, choices)) cols.push({ id: 'app', label: label(target), kind: 'app', entries: appEntries(app), target });
  if (vault && vaultData && isShown({ id: 'vault', kind: 'vault' }, choices)) cols.push({ id: 'vault', label: vault.name, kind: 'vault', vault: vault.name, entries: vaultData.secrets ?? [] });
  return cols;
}

/** Every vault read so far, by name (lower case), to its secrets: what checkReference looks in. */
export const vaultMap = (vaults) => new Map([...vaults].filter(([, d]) => d?.secrets).map(([name, d]) => [name.toLowerCase(), d.secrets]));
