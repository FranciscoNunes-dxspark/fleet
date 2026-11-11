// Reading a subscription: its apps and their slots, its Application Insights components, and its
// container apps, storage accounts, SQL servers with their databases, Service Bus namespaces, Cosmos DB accounts and Log Analytics workspaces.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const listing = provider.subscriptions({ signal });
  // Awaited below once the current one is known; a failure meanwhile isn't an unhandled one.
  listing.catch(() => {});
  // An id known before the list is (one given, or az's own) has its resources asked for at once,
  // beside the list rather than after it: that list is a round trip of its own, and on a tenant with
  // many subscriptions a slow one. A name has to wait for the list to say which id it is.
  const early = subId != null ? subId : (await current)?.id;
  let started = GUID.test(String(early ?? '')) ? readLists(provider, String(early), signal) : null;
  const subscriptions = await listing;
  if (!subscriptions.length) throw new Error('This sign-in has no subscriptions it can see.');
  const wanted = subId ?? (await current)?.id;
  // By id, or by name (sonar --sub "Contoso Production").
  const subscription = subscriptions.find((s) => s.id === wanted || s.name.toLowerCase() === String(wanted ?? '').toLowerCase()) ?? subscriptions[0];
  // What was started for an id the list doesn't have (or for another one) is left to finish unread.
  if (!started || started.id.toLowerCase() !== subscription.id.toLowerCase()) started = readLists(provider, subscription.id, signal);
  const lists = started.lists;

  // Each list fills in as it comes; the first screen waits only for the apps and their Application
  // Insights (which Logs and Problems look through), not for the slowest of the other kinds (Cosmos
  // DB's or Service Bus's listing can take seconds on its own).
  const got = { components: [], containers: [], storage: [], serviceBus: [], cosmos: [], workspaces: [] };
  let servers = [];
  let databases = [];
  let apps = null;
  const slots = {};
  const now = () => ({ subscription, subscriptions, apps: apps ?? [], slots: { ...slots }, ...got, sqlServers: servers.map((s, i) => ({ ...s, databases: databases[i] ?? [] })) });
  // `onProgress` sees the subscription as it fills in: its apps first, then the rest as they come,
  // at most every `every` ms.
  let said = 0;
  const tell = () => {
    if (!onProgress || !apps || Date.now() - said < every) return;
    said = Date.now();
    onProgress(now());
  };
  const filled = Object.fromEntries(Object.keys(got).map((key) => [key, lists[key].then((v) => ((got[key] = v), tell()))]));
  const others = Object.values(filled);

  [apps] = await Promise.all([lists.apps, filled.components]);
  for (const a of apps) slots[a.id] = [];
  said = Date.now();
  onProgress?.(now());

  // The apps' slots and the servers' databases, twelve calls at a time between them, so whichever
  // there are more of gets the room. A server's Entra admin is read when the cursor stops on it
  // (App's adminOf), unless the listing carried it.
  const slotJobs = lists.withSlots.then((withSlots) => apps.filter((a) => !withSlots || withSlots.has(a.id.toLowerCase())).map((app) => async () => (slots[app.id] = await provider.slots(app, { signal }).catch(() => []))));
  const dbJobs = lists.servers.then((list) => {
    servers = list;
    databases = list.map(() => []);
    tell();
    return list.map((s, i) => async () => (databases[i] = await provider.sqlDatabases(s, { signal }).catch(() => [])));
  });
  // Slots start as soon as Resource Graph has said which apps have them, without waiting on the servers.
  const pool = limiter(12);
  await Promise.all([
    slotJobs.then((jobs) => Promise.all(jobs.map((job) => pool(async () => (await job(), tell()))))),
    dbJobs.then((jobs) => Promise.all(jobs.map((job) => pool(async () => (await job(), tell()))))),
    ...others,
  ]);
  return now();
}

/** Every listing of subscription `id`, each a promise of its own: { id, lists }. Only the apps may fail the load. */
function readLists(provider, id, signal) {
  // The other kinds are a bonus: a subscription without them (or without access to them) shows none.
  const other = (fn) => (provider[fn] ? Promise.resolve(provider[fn](id, { signal })).catch(() => []) : Promise.resolve([]));
  const apps = provider.apps(id, { signal });
  // A load whose apps failed throws from there; until it's awaited, a rejection isn't unhandled.
  apps.catch(() => {});
  return {
    id,
    lists: {
      apps,
      // Which apps have slots (Resource Graph), so only theirs are listed; when it can't say, every app's are.
      withSlots: provider.appsWithSlots ? provider.appsWithSlots(id, { signal }).catch(() => null) : Promise.resolve(null),
      components: Promise.resolve(provider.components(id, { signal })).catch(() => []),
      containers: other('containerApps'),
      storage: other('storageAccounts'),
      servers: other('sqlServers'),
      serviceBus: other('serviceBusNamespaces'),
      cosmos: other('cosmosAccounts'),
      workspaces: other('logWorkspaces'),
    },
  };
}

/** A gate letting `n` jobs run at once, in the order they ask. */
function limiter(n) {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= n || !waiting.length) return;
    running++;
    const { job, resolve, reject } = waiting.shift();
    job().then(resolve, reject).finally(() => (running--, next()));
  };
  return (job) => new Promise((resolve, reject) => (waiting.push({ job, resolve, reject }), next()));
}
