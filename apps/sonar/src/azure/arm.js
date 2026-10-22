// Azure itself: Azure Resource Manager for the subscriptions, web apps, function apps, their slots and
// settings, and Application Insights' query API for their telemetry. createAzure builds the provider
// the app talks to; src/demo.js has the same interface without Azure. Everything goes through `fetch`
// with a token from `token(resource)`, both passed in, so tests run it against a fake.

export const ARM = 'https://management.azure.com';
export const INSIGHTS = 'https://api.applicationinsights.io';
const WEB = '2023-12-01';

/** Azure's error, in words: ARM's { error: { code, message } } or App Insights' { error: { message, innererror } }. */
export function azureError(status, body, what) {
  const e = body?.error ?? body?.Error;
  const inner = e?.innererror?.message ?? e?.innerError?.message;
  const message = [e?.message, inner].filter(Boolean).join(': ') || `Azure answered ${status}`;
  if (status === 401) return `${what}: the sign-in was refused (${message}). Try az login.`;
  if (status === 403) return `${what}: you don't have access (${message})`;
  if (status === 404) return `${what}: not found (${message})`;
  return `${what}: ${message}`;
}

/** The app's kind from ARM's comma list ("functionapp,linux"): 'function' or 'app'. */
export const kindOf = (kind) => (/functionapp/i.test(kind ?? '') ? 'function' : 'app');

/** An ARM site or slot as Sonar shows it. */
export function siteFrom(s, parent = null) {
  const p = s.properties ?? {};
  // A slot's name is "app/slot".
  const slot = parent ? s.name.split('/').pop() : null;
  return {
    id: s.id,
    name: parent ? parent.name : s.name,
    slot,
    kind: kindOf(s.kind),
    resourceGroup: p.resourceGroup ?? /\/resourceGroups\/([^/]+)/i.exec(s.id)?.[1] ?? '',
    location: s.location,
    state: p.state ?? 'Unknown',
    host: p.defaultHostName ?? null,
    // Its custom domains too, so an address (a monitor's, say) finds the app behind it.
    hostNames: p.hostNames ?? (p.defaultHostName ? [p.defaultHostName] : []),
    // Its Kudu site, where the log stream comes from.
    scmHost: p.enabledHostNames?.find((h) => /\.scm\./i.test(h)) ?? p.defaultHostName?.replace(/^([^.]+)\./, '$1.scm.') ?? null,
    modified: p.lastModifiedTimeUtc ?? null,
    plan: p.serverFarmId?.split('/').pop() ?? null,
    runtime: p.siteConfig?.linuxFxVersion || p.siteConfig?.windowsFxVersion || null,
  };
}

/** An Application Insights component: what its query API needs (AppId) and how apps point at it. */
export function componentFrom(c) {
  const p = c.properties ?? {};
  return { id: c.id, name: c.name, appId: p.AppId, key: p.InstrumentationKey, resourceGroup: /\/resourceGroups\/([^/]+)/i.exec(c.id)?.[1] ?? '' };
}

/** A query's first table as { columns: [{ name, type }], rows: [[...]] }. */
export function tableFrom(body) {
  const t = body?.tables?.[0] ?? { columns: [], rows: [] };
  return { columns: t.columns.map((c) => ({ name: c.name, type: c.type })), rows: t.rows };
}

/** The provider over real Azure: `fetch` and `token(resource)` from outside. */
export function createAzure({ fetch = globalThis.fetch, token }) {
  const call = async (resource, url, { method = 'GET', body, signal, what = 'Azure' } = {}) => {
    const res = await fetch(url, {
      method,
      signal,
      headers: { Authorization: `Bearer ${await token(resource)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: the status says enough.
    }
    if (!res.ok) throw new Error(azureError(res.status, json, what));
    return json;
  };
  const arm = (path, opts) => call(`${ARM}/`, path.startsWith('http') ? path : `${ARM}${path}`, opts);
  // ARM pages its lists with nextLink.
  const all = async (path, opts) => {
    const out = [];
    for (let url = path; url; ) {
      const page = await arm(url, opts);
      out.push(...(page?.value ?? []));
      url = page?.nextLink ?? null;
    }
    return out;
  };
  return {
    kind: 'azure',
    async subscriptions(opts) {
      const subs = await all('/subscriptions?api-version=2022-12-01', { ...opts, what: 'Listing subscriptions' });
      return subs.filter((s) => s.state !== 'Disabled').map((s) => ({ id: s.subscriptionId, name: s.displayName }));
    },
    async apps(sub, opts) {
      const sites = await all(`/subscriptions/${sub}/providers/Microsoft.Web/sites?api-version=${WEB}`, { ...opts, what: 'Listing the apps' });
      return sites.map((s) => siteFrom(s)).sort((a, b) => a.resourceGroup.localeCompare(b.resourceGroup) || a.name.localeCompare(b.name));
    },
    async slots(app, opts) {
      const slots = await all(`${app.id}/slots?api-version=${WEB}`, { ...opts, what: `Listing ${app.name}'s slots` });
      return slots.map((s) => siteFrom(s, app));
    },
    async settings(target, opts) {
      const r = await arm(`${target.id}/config/appsettings/list?api-version=${WEB}`, { ...opts, method: 'POST', what: `Reading ${label(target)}'s settings` });
      return r?.properties ?? {};
    },
    // ARM replaces the whole set: what isn't in `settings` is removed.
    async saveSettings(target, settings, opts) {
      await arm(`${target.id}/config/appsettings?api-version=${WEB}`, { ...opts, method: 'PUT', body: { properties: settings }, what: `Saving ${label(target)}'s settings` });
    },
    restart: (target, opts) => arm(`${target.id}/restart?api-version=${WEB}`, { ...opts, method: 'POST', what: `Restarting ${label(target)}` }),
    stop: (target, opts) => arm(`${target.id}/stop?api-version=${WEB}`, { ...opts, method: 'POST', what: `Stopping ${label(target)}` }),
    start: (target, opts) => arm(`${target.id}/start?api-version=${WEB}`, { ...opts, method: 'POST', what: `Starting ${label(target)}` }),
    // Swapping is the slot's call, into production; Azure carries on with it after answering.
    swap: (slot, opts) =>
      arm(`${slot.id}/slotsswap?api-version=${WEB}`, { ...opts, method: 'POST', body: { targetSlot: 'production', preserveVnet: true }, what: `Swapping ${label(slot)} into production` }),
    async components(sub, opts) {
      const list = await all(`/subscriptions/${sub}/providers/Microsoft.Insights/components?api-version=2020-02-02`, { ...opts, what: 'Listing Application Insights' });
      return list.map(componentFrom);
    },
    async query(component, kql, { timespan = 'P1D', signal } = {}) {
      const body = await call(INSIGHTS, `${INSIGHTS}/v1/apps/${component.appId}/query`, { method: 'POST', body: { query: kql, timespan }, signal, what: `Querying ${component.name}` });
      return tableFrom(body);
    },
    /**
     * Streams the app's or slot's log (Kudu's /api/logstream), calling `onLine` with each line, until
     * `signal` aborts or the stream ends. Kudu takes the same Azure CLI token as ARM.
     */
    async logStream(target, { signal, onLine }) {
      if (!target.scmHost) throw new Error(`${label(target)} has no Kudu site to stream its log from`);
      const res = await fetch(`https://${target.scmHost}/api/logstream`, { signal, headers: { Authorization: `Bearer ${await token(`${ARM}/`)}` } });
      if (!res.ok) throw new Error(azureError(res.status, null, `Streaming ${label(target)}'s log`));
      await readLines(res.body, onLine);
    },
    portalUrl: (target) => `https://portal.azure.com/#resource${target.id}`,
  };
}

/** Reads a byte stream as lines, calling `onLine` with each (without its line ending); a last partial line too. */
export async function readLines(body, onLine) {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of body) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split(/\r?\n/);
    rest = lines.pop();
    for (const l of lines) onLine(l);
  }
  rest += decoder.decode();
  if (rest) onLine(rest);
}

/** "contoso-web" or "contoso-web/staging". */
export const label = (t) => (t.slot ? `${t.name}/${t.slot}` : t.name);
