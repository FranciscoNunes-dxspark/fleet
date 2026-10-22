// Reading a subscription: its apps and their slots, and its Application Insights components.
import { mapLimited } from './tree.js';

/**
 * Everything the views show for subscription `subId` (the provider's current one if none is given):
 * { subscription, subscriptions, apps, slots: { appId: [slot] }, components }. Slots are read for
 * every app, a few at a time; an app whose slots can't be read just shows none.
 */
export async function loadSubscription(provider, subId, { signal } = {}) {
  const subscriptions = await provider.subscriptions({ signal });
  if (!subscriptions.length) throw new Error('This sign-in has no subscriptions it can see.');
  const wanted = subId ?? (await provider.currentSubscription?.().catch(() => null))?.id;
  // By id, or by name (sonar --sub "Contoso Production").
  const subscription = subscriptions.find((s) => s.id === wanted || s.name.toLowerCase() === String(wanted ?? '').toLowerCase()) ?? subscriptions[0];
  const [apps, components] = await Promise.all([provider.apps(subscription.id, { signal }), provider.components(subscription.id, { signal }).catch(() => [])]);
  const lists = await mapLimited(apps, 6, (app) => provider.slots(app, { signal }).catch(() => []));
  const slots = Object.fromEntries(apps.map((a, i) => [a.id, lists[i]]));
  return { subscription, subscriptions, apps, slots, components };
}
