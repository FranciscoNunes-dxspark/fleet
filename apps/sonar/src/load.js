// Reading a subscription: its apps and their slots, its Application Insights components, and its
// container apps, storage accounts, SQL servers with their databases and Service Bus namespaces.
import { mapLimited } from './tree.js';

/**
 * Everything the views show for subscription `subId` (the provider's current one if none is given):
 * { subscription, subscriptions, apps, slots: { appId: [slot] }, components, containers, storage,
 * sqlServers: [{ ...server, databases }] }. Slots are read a few apps at a time, only for the apps
 * Resource Graph says have some (every app when it can't say); an app whose slots can't be read
 * just shows none. `onProgress(data)`, when given, sees it as it fills in, from its apps on.
 */
export async function loadSubscription(provider, subId, { signal, onProgress, every = 250 } = {}) {
  // The one az has selected is asked for while the list is read, not after it.
  const current = subId == null && provider.currentSubscription ? provider.currentSubscription().catch(() => null) : null;
  const subscriptions = await provider.subscriptions({ signal });
  if (!subscriptions.length) throw new Error('This sign-in has no subscriptions it can see.');
  const wanted = subId ?? (await current)?.id;
  // By id, or by name (sonar --sub "Contoso Production").
  const subscription = subscriptions.find((s) => s.id === wanted || s.name.toLowerCase() === String(wanted ?? '').toLowerCase()) ?? subscriptions[0];
  // The other kinds are a bonus: a subscription without them (or without access to them) shows none.
  const other = (fn) => (provider[fn] ? provider[fn](subscription.id, { signal }).catch(() => []) : []);
  const [apps, withSlots, components, containers, storage, servers, serviceBus] = await Promise.all([
    provider.apps(subscription.id, { signal }),
    // Which apps have slots (Resource Graph), so only theirs are listed; when it can't say, every app's are.
    provider.appsWithSlots ? provider.appsWithSlots(subscription.id, { signal }).catch(() => null) : null,
    provider.components(subscription.id, { signal }).catch(() => []),
    other('containerApps'),
    other('storageAccounts'),
    other('sqlServers'),
    other('serviceBusNamespaces'),
  ]);
  // The apps' slots and the servers' databases, twelve calls at a time between them, so whichever
  // there are more of gets the room. A server's Entra admin is read when the cursor stops on it
  // (App's adminOf), unless the listing carried it.
  const slotted = apps.filter((a) => !withSlots || withSlots.has(a.id.toLowerCase()));
  const slots = Object.fromEntries(apps.map((a) => [a.id, []]));
  const databases = servers.map(() => []);
  const now = () => ({ subscription, subscriptions, apps, slots: { ...slots }, components, containers, storage, serviceBus, sqlServers: servers.map((s, i) => ({ ...s, databases: databases[i] })) });
  // `onProgress` sees the subscription as it fills in: its apps first, then their slots and the
  // databases as they come, at most every `every` ms.
  let said = Date.now();
  const tell = () => {
    if (!onProgress || Date.now() - said < every) return;
    said = Date.now();
    onProgress(now());
  };
  onProgress?.(now());
  const jobs = [
    ...slotted.map((app) => async () => (slots[app.id] = await provider.slots(app, { signal }).catch(() => []))),
    ...servers.map((s, i) => async () => (databases[i] = await provider.sqlDatabases(s, { signal }).catch(() => []))),
  ];
  await mapLimited(jobs, 12, async (job) => (await job(), tell()));
  return now();
}
