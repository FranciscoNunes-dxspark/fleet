// Reading a subscription: its apps and their slots, its Application Insights components, and its
// container apps, storage accounts and SQL servers with their databases.
import { mapLimited } from './tree.js';

/**
 * Everything the views show for subscription `subId` (the provider's current one if none is given):
 * { subscription, subscriptions, apps, slots: { appId: [slot] }, components, containers, storage,
 * sqlServers: [{ ...server, databases }] }. Slots are read a few apps at a time, only for the apps
 * Resource Graph says have some (every app when it can't say); an app whose slots can't be read
 * just shows none.
 */
export async function loadSubscription(provider, subId, { signal } = {}) {
  const subscriptions = await provider.subscriptions({ signal });
  if (!subscriptions.length) throw new Error('This sign-in has no subscriptions it can see.');
  const wanted = subId ?? (await provider.currentSubscription?.().catch(() => null))?.id;
  // By id, or by name (sonar --sub "Contoso Production").
  const subscription = subscriptions.find((s) => s.id === wanted || s.name.toLowerCase() === String(wanted ?? '').toLowerCase()) ?? subscriptions[0];
  // The other kinds are a bonus: a subscription without them (or without access to them) shows none.
  const other = (fn) => (provider[fn] ? provider[fn](subscription.id, { signal }).catch(() => []) : []);
  const [apps, withSlots, components, containers, storage, servers] = await Promise.all([
    provider.apps(subscription.id, { signal }),
    // Which apps have slots (Resource Graph), so only theirs are listed; when it can't say, every app's are.
    provider.appsWithSlots ? provider.appsWithSlots(subscription.id, { signal }).catch(() => null) : null,
    provider.components(subscription.id, { signal }).catch(() => []),
    other('containerApps'),
    other('storageAccounts'),
    other('sqlServers'),
  ]);
  // The slots and the servers' details at the same time: neither waits on the other.
  const [lists, sqlServers] = await Promise.all([
    mapLimited(apps, 6, (app) => (withSlots && !withSlots.has(app.id.toLowerCase()) ? [] : provider.slots(app, { signal }).catch(() => []))),
    // Each server's databases. Its Entra admin is read when the cursor stops on it (App's adminOf),
    // unless the listing carried it.
    mapLimited(servers, 6, async (s) => ({ ...s, databases: await provider.sqlDatabases(s, { signal }).catch(() => []) })),
  ]);
  const slots = Object.fromEntries(apps.map((a, i) => [a.id, lists[i]]));
  return { subscription, subscriptions, apps, slots, components, containers, storage, sqlServers };
}
