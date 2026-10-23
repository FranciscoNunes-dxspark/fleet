// Azure itself: Azure Resource Manager for the subscriptions, web apps, function apps, their slots and
// settings, and Application Insights' query API for their telemetry. createAzure builds the provider
// the app talks to; src/demo.js has the same interface without Azure. Everything goes through `fetch`
// with a token from `token(resource)`, both passed in, so tests run it against a fake.
import { metricsPath, seriesFrom } from '../metrics.js';

export const ARM = 'https://management.azure.com';
export const INSIGHTS = 'https://api.applicationinsights.io';
export const LOG_ANALYTICS = 'https://api.loganalytics.io';
// Where the machine's public address comes from, for the SQL firewall.
export const IPIFY = 'https://api.ipify.org';
const APPS = '2024-03-01';
const SQL = '2021-11-01';
const STORAGE = '2023-05-01';
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
    // Its App Service plan, which is where an app's cost mostly shows.
    planId: p.serverFarmId ?? null,
    runtime: p.siteConfig?.linuxFxVersion || p.siteConfig?.windowsFxVersion || null,
  };
}

// Kudu's deployment states, by number.
const DEPLOY_STATUS = { 0: 'pending', 1: 'building', 2: 'deploying', 3: 'failed', 4: 'succeeded' };

/** A deployment of an app or slot, as ARM lists it (Kudu's record underneath): who, when, how it went. */
export function deploymentFrom(d) {
  const p = d.properties ?? {};
  return {
    id: d.id,
    name: String(d.name ?? '').split('/').pop(),
    status: DEPLOY_STATUS[p.status] ?? String(p.status ?? 'unknown'),
    author: p.author || p.author_email || '',
    deployer: p.deployer ?? '',
    start: p.start_time ?? p.received_time ?? null,
    end: p.end_time ?? null,
    message: String(p.message ?? '').trim(),
    active: Boolean(p.active),
  };
}

/** A fired alert from Alerts Management, as the Alerts view shows it. */
export function alertFrom(a) {
  const e = a.properties?.essentials ?? {};
  return {
    id: a.id,
    name: a.name,
    severity: e.severity ?? '',
    signal: e.signalType ?? '',
    state: e.alertState ?? '',
    condition: e.monitorCondition ?? '',
    service: e.monitorService ?? '',
    target: e.targetResourceName ?? String(e.targetResource ?? '').split('/').pop(),
    targetId: e.targetResource ?? null,
    targetType: e.targetResourceType ?? '',
    resourceGroup: e.targetResourceGroup ?? '',
    rule: e.alertRule ?? null,
    fired: e.startDateTime ?? null,
    changed: e.lastModifiedDateTime ?? null,
    description: e.description ?? '',
  };
}

/** Alerts Management's timeRange for a span (insights.js TIMESPANS): 1h, 1d, 7d or 30d. */
export const alertRange = (span) => (span.hours <= 1 ? '1h' : span.hours <= 24 ? '1d' : span.hours <= 24 * 7 ? '7d' : '30d');

const groupOf = (id) => /\/resourceGroups\/([^/]+)/i.exec(id ?? '')?.[1] ?? '';

/** A container app (Microsoft.App/containerApps): its state, latest revision, address and environment. */
export function containerAppFrom(c) {
  const p = c.properties ?? {};
  const fqdn = p.configuration?.ingress?.fqdn ?? p.latestRevisionFqdn ?? null;
  return {
    type: 'container',
    id: c.id,
    name: c.name,
    resourceGroup: groupOf(c.id),
    location: c.location,
    state: p.runningStatus ?? p.provisioningState ?? 'Unknown',
    host: fqdn,
    latestRevision: p.latestRevisionName ?? null,
    readyRevision: p.latestReadyRevisionName ?? null,
    environmentId: p.managedEnvironmentId ?? p.environmentId ?? null,
    image: p.template?.containers?.[0]?.image ?? null,
  };
}

/** A storage account: its kind, SKU, access tier and blob endpoint. */
export function storageFrom(a) {
  const p = a.properties ?? {};
  return {
    type: 'storage',
    id: a.id,
    name: a.name,
    resourceGroup: groupOf(a.id),
    location: a.location,
    state: p.provisioningState === 'Succeeded' ? (p.statusOfPrimary === 'available' || !p.statusOfPrimary ? 'Available' : p.statusOfPrimary) : (p.provisioningState ?? 'Unknown'),
    kind: a.kind ?? '',
    sku: a.sku?.name ?? '',
    tier: p.accessTier ?? null,
    host: p.primaryEndpoints?.blob ? p.primaryEndpoints.blob.replace(/^https:\/\//, '').replace(/\/$/, '') : null,
  };
}

/** An Azure SQL server: its address, state, and the Entra admin when the listing carries it. */
export function sqlServerFrom(s) {
  const p = s.properties ?? {};
  const admin = p.administrators?.login ? { login: p.administrators.login, type: p.administrators.principalType ?? p.administrators.administratorType ?? '', only: Boolean(p.administrators.azureADOnlyAuthentication) } : null;
  return {
    type: 'sqlserver',
    id: s.id,
    name: s.name,
    resourceGroup: groupOf(s.id),
    location: s.location,
    state: p.state ?? 'Unknown',
    fqdn: p.fullyQualifiedDomainName ?? `${s.name}.database.windows.net`,
    host: p.fullyQualifiedDomainName ?? `${s.name}.database.windows.net`,
    version: p.version ?? '',
    publicAccess: p.publicNetworkAccess ?? null,
    admin,
    databases: [],
  };
}

/** A database on `server`, with its status and SKU. */
export function sqlDatabaseFrom(d, server) {
  const p = d.properties ?? {};
  return {
    type: 'sqldb',
    id: d.id,
    name: d.name,
    server: server.name,
    serverId: server.id,
    fqdn: server.fqdn,
    host: server.fqdn,
    resourceGroup: server.resourceGroup,
    location: d.location,
    state: p.status ?? 'Unknown',
    sku: d.sku?.name ?? p.currentServiceObjectiveName ?? '',
    tier: d.sku?.tier ?? '',
  };
}

/** An Application Insights component: what its query API needs (AppId) and how apps point at it. */
export function componentFrom(c) {
  const p = c.properties ?? {};
  return { id: c.id, name: c.name, appId: p.AppId, key: p.InstrumentationKey, resourceGroup: /\/resourceGroups\/([^/]+)/i.exec(c.id)?.[1] ?? '' };
}

/**
 * Cost Management's answer (MonthToDate ActualCost grouped by ResourceId) as { currency, byId }, the
 * ids lower-cased (Cost Management writes them so), each with the sum of its rows.
 */
export function costsFrom(body, into = { currency: null, byId: {} }) {
  const p = body?.properties ?? {};
  const at = (name) => (p.columns ?? []).findIndex((c) => String(c.name).toLowerCase() === name);
  const [cost, id, currency] = [at('cost') >= 0 ? at('cost') : at('pretaxcost'), at('resourceid'), at('currency')];
  for (const r of p.rows ?? []) {
    const k = String(r[id] ?? '').toLowerCase();
    if (!k) continue;
    into.byId[k] = (into.byId[k] ?? 0) + Number(r[cost] ?? 0);
    into.currency ??= currency >= 0 ? r[currency] : null;
  }
  return into;
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
      // A Log Analytics workspace (a container app's logs) answers on its own API, with its own token.
      if (component.workspaceId) {
        const body = await call(LOG_ANALYTICS, `${LOG_ANALYTICS}/v1/workspaces/${component.workspaceId}/query`, { method: 'POST', body: { query: kql, timespan }, signal, what: `Querying ${component.name}` });
        return tableFrom(body);
      }
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
    async containerApps(sub, opts) {
      const list = await all(`/subscriptions/${sub}/providers/Microsoft.App/containerApps?api-version=${APPS}`, { ...opts, what: 'Listing the container apps' });
      return list.map(containerAppFrom);
    },
    // A container app restarts by restarting its latest revision.
    restartRevision: (app, opts) =>
      arm(`${app.id}/revisions/${app.latestRevision}/restart?api-version=${APPS}`, { ...opts, method: 'POST', what: `Restarting ${app.name}'s revision ${app.latestRevision}` }),
    /** The Log Analytics workspace a container app's environment sends its logs to, as a component to query. */
    async containerAppWorkspace(app, opts) {
      if (!app.environmentId) throw new Error(`${app.name} has no environment to find its logs through`);
      const env = await arm(`${app.environmentId}?api-version=${APPS}`, { ...opts, what: `Reading ${app.name}'s environment` });
      const id = env?.properties?.appLogsConfiguration?.logAnalyticsConfiguration?.customerId;
      if (!id) throw new Error(`${app.name}'s environment (${env?.name ?? app.environmentId.split('/').pop()}) sends its logs to no Log Analytics workspace`);
      return { id: `workspace:${id}`, workspaceId: id, name: `${env.name} logs`, resourceGroup: groupOf(app.environmentId) };
    },
    async storageAccounts(sub, opts) {
      const list = await all(`/subscriptions/${sub}/providers/Microsoft.Storage/storageAccounts?api-version=${STORAGE}`, { ...opts, what: 'Listing the storage accounts' });
      return list.map(storageFrom);
    },
    async sqlServers(sub, opts) {
      const list = await all(`/subscriptions/${sub}/providers/Microsoft.Sql/servers?api-version=${SQL}`, { ...opts, what: 'Listing the SQL servers' });
      return list.map(sqlServerFrom);
    },
    /** A server's databases, without master. */
    async sqlDatabases(server, opts) {
      const list = await all(`${server.id}/databases?api-version=${SQL}`, { ...opts, what: `Listing ${server.name}'s databases` });
      return list.filter((d) => d.name.toLowerCase() !== 'master').map((d) => sqlDatabaseFrom(d, server));
    },
    /** A server's Entra (Azure AD) admin, or null when none is set. */
    async sqlAdmin(server, opts) {
      const list = await all(`${server.id}/administrators?api-version=${SQL}`, { ...opts, what: `Reading ${server.name}'s Entra admin` });
      const p = list[0]?.properties;
      return p?.login ? { login: p.login, type: p.principalType ?? p.administratorType ?? '', only: Boolean(p.azureADOnlyAuthentication) } : null;
    },
    async firewallRules(server, opts) {
      const list = await all(`${server.id}/firewallRules?api-version=${SQL}`, { ...opts, what: `Reading ${server.name}'s firewall` });
      return list.map((r) => ({ name: r.name, start: r.properties?.startIpAddress, end: r.properties?.endIpAddress }));
    },
    async addFirewallRule(server, { name, start, end }, opts) {
      await arm(`${server.id}/firewallRules/${encodeURIComponent(name)}?api-version=${SQL}`, { ...opts, method: 'PUT', body: { properties: { startIpAddress: start, endIpAddress: end ?? start } }, what: `Adding ${name} to ${server.name}'s firewall` });
    },
    /** An app's or slot's connection strings (not its app settings), { name: value }. */
    async connectionStrings(target, opts) {
      const r = await arm(`${target.id}/config/connectionstrings/list?api-version=${WEB}`, { ...opts, method: 'POST', what: `Reading ${label(target)}'s connection strings` });
      return Object.fromEntries(Object.entries(r?.properties ?? {}).map(([k, v]) => [k, v?.value ?? '']));
    },
    /** This machine's public address, as the internet sees it. */
    async publicIp({ signal } = {}) {
      const res = await fetch(IPIFY, { method: 'GET', signal });
      if (!res.ok) throw new Error(`Couldn't find this machine's public address (${IPIFY} answered ${res.status})`);
      const ip = (await res.text()).trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`Couldn't find this machine's public address (${IPIFY} said "${ip.slice(0, 40)}")`);
      return ip;
    },
    /** The subscription's alerts still firing that began within `span`, the most severe first. */
    async alerts(sub, { span, signal } = {}) {
      const q = new URLSearchParams({ 'api-version': '2019-05-05-preview', monitorCondition: 'Fired', timeRange: alertRange(span) });
      const list = await all(`/subscriptions/${sub}/providers/Microsoft.AlertsManagement/alerts?${q}`, { signal, what: 'Listing the alerts' });
      return list.map(alertFrom).sort((a, b) => a.severity.localeCompare(b.severity) || String(b.fired ?? '').localeCompare(String(a.fired ?? '')));
    },
    /** An app's or slot's deployments, newest first. */
    async deployments(target, opts) {
      const list = await all(`${target.id}/deployments?api-version=${WEB}`, { ...opts, what: `Listing ${label(target)}'s deployments` });
      return list.map(deploymentFrom).sort((a, b) => String(b.start ?? '').localeCompare(String(a.start ?? '')));
    },
    /** One deployment's log: [{ at, message }] in order. */
    async deploymentLog(deployment, opts) {
      const list = await all(`${deployment.id}/log?api-version=${WEB}`, { ...opts, what: `Reading deployment ${deployment.name}'s log` });
      return list.map((l) => ({ at: l.properties?.log_time ?? null, message: String(l.properties?.message ?? '') })).sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    },
    /** Azure Monitor's metrics for an app or slot over `span` (insights.js TIMESPANS): metrics.js's series. */
    async metrics(target, { span, signal } = {}) {
      return seriesFrom(await arm(metricsPath(target, span), { signal, what: `Reading ${label(target)}'s metrics` }));
    },
    /** The subscription's cost this month so far, by resource: costsFrom's { currency, byId }. */
    async costs(sub, { signal } = {}) {
      const body = { type: 'ActualCost', timeframe: 'MonthToDate', dataset: { granularity: 'None', aggregation: { totalCost: { name: 'Cost', function: 'Sum' } }, grouping: [{ type: 'Dimension', name: 'ResourceId' }] } };
      const out = { currency: null, byId: {} };
      // Its pages come from nextLink, asked the same way.
      for (let url = `/subscriptions/${sub}/providers/Microsoft.CostManagement/query?api-version=2023-03-01`; url; ) {
        const page = await arm(url, { method: 'POST', body, signal, what: 'Reading the costs' });
        costsFrom(page, out);
        url = page?.properties?.nextLink ?? null;
      }
      return out;
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

/** "contoso-web" or "contoso-web/staging"; a database is "server/database". */
export const label = (t) => (t.type === 'sqldb' ? `${t.server}/${t.name}` : t.slot ? `${t.name}/${t.slot}` : t.name);
