// What the project's environment (the kit's environments.js) says to Sonar: its "sonar" section in
// .fleet/project.json, { subscription, resourceGroup, app, slot, component }, names the app (or slot) and
// the Application Insights to look at when that environment is chosen. Pure: App switches to them.

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/** Whether the environment names anything for Sonar at all. */
export const namesSomething = (env) => Boolean(env && (env.subscription || env.app || env.component));

/**
 * What `env` (environmentFor's: { name, prod, ...the sonar section }) picks in the subscription read
 * (`data`, load.js's): { switchTo } when it's in another subscription (its id), else { target, component,
 * missing: [what couldn't be found, in words] }.
 */
export function environmentPicks(env, data) {
  const missing = [];
  if (env.subscription && !same(env.subscription, data.subscription.id) && !same(env.subscription, data.subscription.name)) {
    const sub = (data.subscriptions ?? []).find((s) => same(s.id, env.subscription) || same(s.name, env.subscription));
    if (sub) return { switchTo: sub.id };
    return { target: null, component: null, missing: [`the subscription ${env.subscription}`] };
  }
  let target = null;
  if (env.app) {
    const app = data.apps.find((a) => same(a.name, env.app) && (!env.resourceGroup || same(a.resourceGroup, env.resourceGroup)));
    if (!app) missing.push(`the app ${env.app}${env.resourceGroup ? ` in ${env.resourceGroup}` : ''}`);
    else if (env.slot && !same(env.slot, 'production')) {
      target = (data.slots[app.id] ?? []).find((s) => same(s.slot, env.slot)) ?? null;
      if (!target) missing.push(`the slot ${env.app}/${env.slot}`);
    } else target = app;
  }
  let component = null;
  if (env.component) {
    component = (data.components ?? []).find((c) => same(c.name, env.component) || same(c.appId, env.component)) ?? null;
    if (!component) missing.push(`the Application Insights ${env.component}`);
  }
  return { target, component, missing };
}
