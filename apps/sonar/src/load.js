// Reading a subscription: its apps and their slots, its Application Insights components, and its
// container apps, storage accounts and SQL servers with their databases.
import { mapLimited } from './tree.js';

/**
 * Everything the views show for subscription `subId` (the provider's current one if none is given):
 * { subscription, subscriptions, apps, slots: { appId: [slot] }, components, containers, storage,
 * sqlServers: [{ ...server, databases, admin }] }. Slots are read for
 * every app, a few at a time; an app whose slots can't be read just shows none.
 */
export async function loadSubscription(provider, subId, { signal } = {}) {
  const subscriptions = await provider.subscriptions({ signal });
  if (!subscriptions.length) throw new Error('This sign-in has no subscriptions it can see.');
  const wanted = subId ?? (await provider.currentSubscription?.().catch(() => null))?.id;
  // By id, or by name (sonar --sub "Contoso Production").
  const subscription = subscriptions.find((s) => s.id === wanted || s.name.toLowerCase() === String(wanted ?? '').toLowerCase()) ?? subscriptions[0];
  // The other kinds are a bonus: a subscription without them (or without access to them) shows none.
  const other = (fn) => (provider[fn] ? provider[fn](subscription.id, { signal }).catch(() => []) : []);
  const [apps, components, containers, storage, servers] = await Promise.all([
    provider.apps(subscription.id, { signal }),
    provider.components(subscription.id, { signal }).catch(() => []),
    other('containerApps'),
    other('storageAccounts'),
    other('sqlServers'),
  ]);
  const lists = await mapLimited(apps, 6, (app) => provider.slots(app, { signal }).catch(() => []));
  const slots = Object.fromEntries(apps.map((a, i) => [a.id, lists[i]]));
  // Each server's databases and Entra admin (the listing doesn't always carry the admin).
  const sqlServers = await mapLimited(servers, 6, async (s) => {
    const [databases, admin] = await Promise.all([provider.sqlDatabases(s, { signal }).catch(() => []), s.admin ? s.admin : provider.sqlAdmin(s, { signal }).catch(() => null)]);
    return { ...s, databases, admin };
  });
  return { subscription, subscriptions, apps, slots, components, containers, storage, sqlServers };
}
