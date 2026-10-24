// Azure itself: Azure Resource Manager for the subscriptions, web apps, function apps, their slots and
// settings, and Application Insights' query API for their telemetry. createAzure builds the provider
// the app talks to; src/demo.js has the same interface without Azure. Everything goes through `fetch`
// with a token from `token(resource)`, both passed in, so tests run it against a fake.
import { metricsPath, seriesFrom } from '../metrics.js';
import { callSignal } from '../run.js';
import { functionFrom, functionUrl, invocation, isHttp } from '../functions.js';
import { autoscaleFrom, planFrom } from '../scale.js';
import { rampUpRules, routingFrom } from '../routing.js';
import { STORAGE_VERSION, VIEW_MAX, blobUrl, parseBlobs, parseContainers, storageRoleNeeded } from '../blobs.js';
import { containerFrom, cosmosFrom, throughputFrom } from '../cosmos.js';
import { busRoleNeeded, deadLetterPath, entityFrom, messageFrom, namespaceFrom, resendHeaders, resubmitPath } from '../servicebus.js';

export const ARM = 'https://management.azure.com';
export const INSIGHTS = 'https://api.applicationinsights.io';
export const LOG_ANALYTICS = 'https://api.loganalytics.io';
// Blob Storage's own API, with a token of its own.
export const BLOB_STORAGE = 'https://storage.azure.com/';
// Service Bus's own API (messages), with a token of its own.
export const SERVICE_BUS = 'https://servicebus.azure.net';
// Where the machine's public address comes from, for the SQL firewall.
export const IPIFY = 'https://api.ipify.org';
const APPS = '2024-03-01';
const GRAPH = '2021-03-01';
const SQL = '2021-11-01';
const STORAGE = '2023-05-01';
const WEB = '2023-12-01';
const BUS = '2021-11-01';
const COSMOS = '2024-05-15';

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

/** An error in Storage's XML (<Error><Code>…</Code><Message>…</Message></Error>) as ARM's shape, for azureError. */
export function xmlError(text) {
  const code = /<Code>([^<]*)<\/Code>/.exec(String(text ?? ''))?.[1];
  const message = /<(?:Message|Detail)>([^<]*)<\/(?:Message|Detail)>/.exec(String(text ?? ''))?.[1]?.split('\n')[0];
  return code || message ? { error: { message: [code, message].filter(Boolean).join(': ') } } : null;
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

/** A Key Vault reference's state, from ARM's configreferences: the setting, how it went, which vault and secret. */
export function referenceFrom(r) {
  const p = r.properties ?? {};
  return {
    name: String(r.name ?? r.id ?? '').split('/').pop(),
    status: p.status ?? 'Unknown',
    details: p.details ?? '',
    vault: p.vaultName ?? '',
    secret: p.secretName ?? '',
    identity: p.identityType ?? '',
    reference: p.reference ?? '',
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

/** How long to wait before trying a throttled call again (ms): Azure's Retry-After, else 1, 2, 4 s; at most 30 s. */
export function retryAfter(res, tries = 0) {
  const said = Number(res.headers?.get?.('retry-after'));
  return Math.min(30_000, Number.isFinite(said) && said >= 0 ? said * 1000 : 1000 * 2 ** tries);
}

const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const stop = () => (clearTimeout(t), reject(Object.assign(new Error('Cancelled'), { cancelled: true })));
    const t = setTimeout(() => (signal?.removeEventListener('abort', stop), resolve()), ms);
    signal?.addEventListener('abort', stop, { once: true });
  });

/** A query's first table as { columns: [{ name, type }], rows: [[...]] }. */
export function tableFrom(body) {
  const t = body?.tables?.[0] ?? { columns: [], rows: [] };
  return { columns: t.columns.map((c) => ({ name: c.name, type: c.type })), rows: t.rows };
}

/** The provider over real Azure: `fetch` and `token(resource)` from outside. */
export function createAzure({ fetch = globalThis.fetch, token }) {
  // `raw` answers { status, headers, text } rather than JSON (Storage's XML, a Service Bus message);
  // `text` is a body sent as it is (with `headers` saying its type); `auth: false` sends no token (a
  // function's own key goes in `headers` instead). Throttled calls are tried again, failures thrown in
  // words with the status on the error.
  const call = async (resource, url, { method = 'GET', body, text: sent, headers = {}, raw = false, auth = true, anyStatus = false, signal, what = 'Azure' } = {}, tries = 0) => {
    // A signal of its own, so a load's hundreds of calls leave no listeners on the load's.
    const own = callSignal(signal);
    let res;
    let text;
    try {
      res = await fetch(url, {
        method,
        signal: own.signal,
        headers: { ...(auth ? { Authorization: `Bearer ${await token(resource)}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : sent,
      });
      // Too many calls at once (a big subscription's slots, say): Azure says when to try again.
      if (res.status === 429 && tries < 3 && !signal?.aborted) {
        own.done();
        await pause(retryAfter(res, tries), signal);
        return call(resource, url, { method, body, text: sent, headers, raw, auth, anyStatus, signal, what }, tries + 1);
      }
      text = await res.text();
    } finally {
      own.done();
    }
    let json = null;
    try {
      json = text && !raw ? JSON.parse(text) : null;
    } catch {
      // Not JSON: the status says enough.
    }
    // `anyStatus`: whatever it answered is the answer (a function's 500 is what you wanted to see).
    if (!res.ok && !(raw && anyStatus)) {
      if (raw) {
        try {
          json = JSON.parse(text);
        } catch {
          json = xmlError(text);
        }
      }
      throw Object.assign(new Error(azureError(res.status, json, what)), { status: res.status });
    }
    return raw ? { status: res.status, headers: res.headers, text } : json;
  };
  const arm = (path, opts) => call(`${ARM}/`, path.startsWith('http') ? path : `${ARM}${path}`, opts);
  // Service Bus's REST API for one namespace: a path in it, or a lock's whole address. A 401 or 403
  // there is about its data roles, which ARM's don't give, so it says which.
  const bus = (ns, where, opts) =>
    call(SERVICE_BUS, /^https:/.test(where) ? where : `https://${ns.host}/${where}`, { raw: true, ...opts }).catch((e) => {
      throw e.status === 401 || e.status === 403 ? Object.assign(new Error(busRoleNeeded(ns, opts.what)), { status: e.status }) : e;
    });
  // Blob Storage's API for one account; a 403 there is about its data roles.
  const blob = (account, url, opts) =>
    call(BLOB_STORAGE, url, { raw: true, ...opts, headers: { 'x-ms-version': STORAGE_VERSION, ...(opts.headers ?? {}) } }).catch((e) => {
      throw e.status === 403 ? Object.assign(new Error(storageRoleNeeded(account, opts.what)), { status: 403 }) : e;
    });
  // Peek-locks the next dead letter of `entity` (null when there's none left).
  const lockNext = async (ns, entity, signal, what) => {
    const res = await bus(ns, `${deadLetterPath(entity)}/messages/head?timeout=1`, { method: 'POST', signal, what });
    return res.status === 204 || !res.headers?.get?.('brokerproperties') ? null : messageFrom(res);
  };
  const unlock = (ns, held) => Promise.all(held.map((m) => (m.lock ? bus(ns, m.lock, { method: 'PUT', what: 'Letting go of a dead letter' }).catch(() => {}) : null)));
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
    /**
     * The ids (lower-case) of the subscription's apps that have slots, from one Azure Resource Graph
     * query, so the slots are listed only for those; ARM has no listing of every slot at once.
     */
    async appsWithSlots(sub, { signal } = {}) {
      const ids = new Set();
      let skip = null;
      do {
        const body = { subscriptions: [sub], query: "resources | where type =~ 'microsoft.web/sites/slots' | project id", options: { $top: 1000, resultFormat: 'objectArray', ...(skip ? { $skipToken: skip } : {}) } };
        const page = await arm(`/providers/Microsoft.ResourceGraph/resources?api-version=${GRAPH}`, { method: 'POST', body, signal, what: 'Finding the apps with slots' });
        for (const row of page?.data ?? []) ids.add(String(row.id).replace(/\/slots\/[^/]+$/i, '').toLowerCase());
        skip = page?.$skipToken ?? null;
      } while (skip);
      return ids;
    },
    async slots(app, opts) {
      const slots = await all(`${app.id}/slots?api-version=${WEB}`, { ...opts, what: `Listing ${app.name}'s slots` });
      return slots.map((s) => siteFrom(s, app));
    },
    async settings(target, opts) {
      const r = await arm(`${target.id}/config/appsettings/list?api-version=${WEB}`, { ...opts, method: 'POST', what: `Reading ${label(target)}'s settings` });
      return r?.properties ?? {};
    },
    /** A function app's (or slot's) functions: functions.js functionFrom's. */
    async functions(target, opts) {
      const list = await all(`${target.id}/functions?api-version=${WEB}`, { ...opts, what: `Listing ${label(target)}'s functions` });
      return list.map(functionFrom).sort((a, b) => a.name.localeCompare(b.name));
    },
    /**
     * Invokes `fn` with what was typed (`input`): an HTTP function at its address with its own key, any
     * other through the admin endpoint with the master key. The key is read for this call and goes no
     * further than its header: never in the address, the answer or an error. Resolves { status, type, body, url, method }.
     */
    async invokeFunction(target, fn, { input = '', signal } = {}) {
      const send = invocation(fn, input);
      const anonymous = isHttp(fn) && /^anonymous$/i.test(fn.authLevel ?? '');
      let key = null;
      if (!anonymous) {
        const hostKeys = () => arm(`${target.id}/host/default/listkeys?api-version=${WEB}`, { method: 'POST', signal, what: `Reading ${label(target)}'s keys` });
        if (send.admin || /^admin$/i.test(fn.authLevel ?? '')) key = (await hostKeys())?.masterKey;
        else {
          const own = await arm(`${target.id}/functions/${encodeURIComponent(fn.name)}/listkeys?api-version=${WEB}`, { method: 'POST', signal, what: `Reading ${fn.name}'s keys` }).catch(() => null);
          key = keyIn(own?.properties ?? own) ?? keyIn((await hostKeys())?.functionKeys);
        }
        if (!key) throw new Error(`${label(target)} gave no key to invoke ${fn.name} with`);
      }
      const url = send.admin ? `https://${target.host}/admin/functions/${encodeURIComponent(fn.name)}` : functionUrl(fn, target.host);
      const headers = { ...(key ? { 'x-functions-key': key } : {}), ...(send.body != null ? { 'Content-Type': send.admin ? 'application/json' : 'text/plain' } : {}) };
      const res = await call(null, url, { method: send.method, text: send.body, headers, raw: true, auth: false, anyStatus: true, signal, what: `Invoking ${fn.name}` });
      return { status: res.status, type: res.headers?.get?.('content-type') ?? '', body: res.text, url, method: send.method };
    },
    async cosmosAccounts(sub, opts) {
      const list = await all(`/subscriptions/${sub}/providers/Microsoft.DocumentDB/databaseAccounts?api-version=${COSMOS}`, { ...opts, what: 'Listing the Cosmos DB accounts' });
      return list.map(cosmosFrom);
    },
    /**
     * An account's databases, each with its shared throughput (null when its containers have their own,
     * or it's serverless) and its containers with their partition keys and throughput: NoSQL's
     * sqlDatabases and containers, MongoDB's mongodbDatabases and collections. Other APIs list nothing.
     */
    async cosmosTree(account, { signal } = {}) {
      const kinds = { NoSQL: ['sqlDatabases', 'containers'], MongoDB: ['mongodbDatabases', 'collections'] }[account.api];
      if (!kinds) return [];
      const [dbs, children] = kinds;
      const throughput = (id) => arm(`${id}/throughputSettings/default?api-version=${COSMOS}`, { signal, what: 'Reading throughput' }).then(throughputFrom, () => null);
      const list = await all(`${account.id}/${dbs}?api-version=${COSMOS}`, { signal, what: `Listing ${account.name}'s databases` });
      return Promise.all(
        list.map(async (d) => {
          const id = `${account.id}/${dbs}/${encodeURIComponent(d.name)}`;
          const [shared, containers] = await Promise.all([throughput(id), all(`${id}/${children}?api-version=${COSMOS}`, { signal, what: `Listing ${d.name}'s containers` })]);
          const each = await Promise.all(containers.map(async (c) => ({ ...containerFrom(c), throughput: await throughput(`${id}/${children}/${encodeURIComponent(c.name)}`) })));
          return { name: d.properties?.resource?.id ?? d.name, throughput: shared, containers: each.sort((a, b) => a.name.localeCompare(b.name)) };
        }),
      ).then((out) => out.sort((a, b) => a.name.localeCompare(b.name)));
    },
    /** A storage account's blob containers, every page: blobs.js parseContainers'. */
    async containers(account, { signal } = {}) {
      const out = [];
      let marker = null;
      do {
        const q = new URLSearchParams({ comp: 'list', maxresults: '500', ...(marker ? { marker } : {}) });
        const page = parseContainers((await blob(account, `https://${account.host}/?${q}`, { signal, what: `Listing ${account.name}'s containers` })).text);
        out.push(...page.containers);
        marker = page.next;
      } while (marker);
      return out;
    },
    /** One folder of a container (`prefix`, ending in "/", or '' for its top): { prefixes, blobs, more }, at most `max` blobs. */
    async blobs(account, container, prefix = '', { signal, max = 5000 } = {}) {
      const out = { prefixes: [], blobs: [], more: false };
      let marker = null;
      do {
        const q = new URLSearchParams({ restype: 'container', comp: 'list', delimiter: '/', maxresults: '1000', ...(prefix ? { prefix } : {}), ...(marker ? { marker } : {}) });
        const page = parseBlobs((await blob(account, `${blobUrl(account, container)}?${q}`, { signal, what: `Listing ${container}/${prefix}` })).text);
        out.prefixes.push(...page.prefixes);
        out.blobs.push(...page.blobs);
        marker = page.next;
      } while (marker && out.blobs.length < max);
      out.more = Boolean(marker);
      return out;
    },
    /** A blob's first `max` bytes as text: { text, type, partial }. */
    async readBlob(account, container, name, { signal, max = VIEW_MAX } = {}) {
      const res = await blob(account, blobUrl(account, container, name), { signal, headers: { 'x-ms-range': `bytes=0-${max - 1}` }, what: `Reading ${container}/${name}` });
      return { text: res.text, type: res.headers?.get?.('content-type') ?? '', partial: res.status === 206 && /\/(\d+)$/.exec(res.headers?.get?.('content-range') ?? '')?.[1] > max };
    },
    async serviceBusNamespaces(sub, opts) {
      const list = await all(`/subscriptions/${sub}/providers/Microsoft.ServiceBus/namespaces?api-version=${BUS}`, { ...opts, what: 'Listing the Service Bus namespaces' });
      return list.map(namespaceFrom);
    },
    /** A namespace's queues, topics and each topic's subscriptions, with their counts: servicebus.js entityFrom's. */
    async serviceBusEntities(ns, { signal } = {}) {
      const [queues, topics] = await Promise.all([
        all(`${ns.id}/queues?api-version=${BUS}`, { signal, what: `Listing ${ns.name}'s queues` }),
        all(`${ns.id}/topics?api-version=${BUS}`, { signal, what: `Listing ${ns.name}'s topics` }),
      ]);
      const subs = await Promise.all(topics.map((t) => all(`${ns.id}/topics/${encodeURIComponent(t.name)}/subscriptions?api-version=${BUS}`, { signal, what: `Listing ${t.name}'s subscriptions` })));
      return [...queues.map((q) => entityFrom('queue', q)), ...topics.flatMap((t, i) => [entityFrom('topic', t), ...subs[i].map((x) => entityFrom('subscription', x, t.name))])];
    },
    /**
     * Up to `max` of an entity's dead letters, oldest first, without taking them: each is peek-locked,
     * and every lock let go again once they're read (their delivery count goes up by one).
     */
    async peekDeadLetters(ns, entity, { max = 20, signal } = {}) {
      const what = `Peeking ${entity.name}'s dead letters`;
      const held = [];
      try {
        while (held.length < max) {
          const m = await lockNext(ns, entity, signal, what);
          if (!m) break;
          held.push(m);
        }
      } finally {
        await unlock(ns, held);
      }
      return held.map(({ lock: _, ...m }) => m).sort((a, b) => Number(a.sequence) - Number(b.sequence));
    },
    /**
     * Resubmits the dead letters with these sequence numbers: each is locked, a copy sent to the entity
     * (a subscription's to its topic), and only then completed; the others locked on the way are let go.
     * Looks through at most `scan` of them. Resolves { moved, missing } (the sequence numbers not found).
     */
    async resubmitDeadLetters(ns, entity, sequences, { signal, scan = 500 } = {}) {
      const want = new Set(sequences.map(String));
      const held = [];
      let moved = 0;
      let seen = 0;
      try {
        while (want.size && seen < scan) {
          const m = await lockNext(ns, entity, signal, `Resubmitting ${entity.name}'s dead letters`);
          if (!m) break;
          seen++;
          held.push(m);
          if (!want.has(String(m.sequence))) continue;
          await bus(ns, `${resubmitPath(entity)}/messages`, { method: 'POST', text: m.body, headers: resendHeaders(m), signal, what: `Sending a copy of ${m.id || m.sequence} to ${resubmitPath(entity)}` });
          await bus(ns, m.lock, { method: 'DELETE', signal, what: `Completing dead letter ${m.id || m.sequence}` });
          held.pop();
          want.delete(String(m.sequence));
          moved++;
        }
      } finally {
        await unlock(ns, held);
      }
      return { moved, missing: [...want] };
    },
    /** Receives and deletes every dead letter of an entity (at most `max`): how many went. */
    async purgeDeadLetters(ns, entity, { signal, max = 10_000 } = {}) {
      let n = 0;
      while (n < max) {
        const res = await bus(ns, `${deadLetterPath(entity)}/messages/head?timeout=1`, { method: 'DELETE', signal, what: `Purging ${entity.name}'s dead letters` });
        if (res.status === 204 || !res.headers?.get?.('brokerproperties')) break;
        n++;
      }
      return n;
    },
    /** An app's ramp-up rules (testing in production): routing.js's [{ slot, host, percent }]. */
    async routing(app, opts) {
      return routingFrom(await arm(`${app.id}/config/web?api-version=${WEB}`, { ...opts, what: `Reading ${label(app)}'s routing` }));
    },
    /** Sets them whole: what isn't in `rules` gets no traffic. */
    async setRouting(app, rules, opts) {
      await arm(`${app.id}/config/web?api-version=${WEB}`, { ...opts, method: 'PATCH', body: { properties: { experiments: { rampUpRules: rampUpRules(rules) } } }, what: `Routing ${label(app)}'s traffic` });
    },
    /** An App Service plan (serverfarm) by its id: scale.js planFrom's. */
    async plan(planId, opts) {
      return planFrom(await arm(`${planId}?api-version=${WEB}`, { ...opts, what: `Reading the plan ${planId.split('/').pop()}` }));
    },
    /**
     * Scales a plan to `sku` ({ name, tier, capacity }). The plan's update (PATCH) takes no SKU, so it's
     * read and written back whole (PUT) with the new one, as az appservice plan update does.
     */
    async scalePlan(plan, sku, { signal } = {}) {
      const what = `Scaling ${plan.name}`;
      const now = await arm(`${plan.id}?api-version=${WEB}`, { signal, what });
      const { name, tier, capacity } = sku;
      const next = { location: now.location, kind: now.kind, tags: now.tags, sku: { name, tier, capacity }, properties: now.properties ?? {} };
      return planFrom(await arm(`${plan.id}?api-version=${WEB}`, { method: 'PUT', body: next, signal, what }));
    },
    /** The subscription's autoscale settings (Microsoft.Insights/autoscalesettings): scale.js autoscaleFrom's. */
    async autoscaleSettings(sub, opts) {
      const list = await all(`/subscriptions/${sub}/providers/Microsoft.Insights/autoscalesettings?api-version=2022-10-01`, { ...opts, what: 'Reading the autoscale settings' });
      return list.map(autoscaleFrom);
    },
    /** How each of its Key Vault references (@Microsoft.KeyVault(…) settings) resolved: referenceFrom's. */
    async keyVaultReferences(target, opts) {
      const list = await all(`${target.id}/config/configreferences/appsettings?api-version=2022-03-01`, { ...opts, what: `Reading ${label(target)}'s Key Vault references` });
      return list.map(referenceFrom);
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

/** A key from a list of them ({ default: '…' }, or whichever there is), leaving out ARM's own fields. */
function keyIn(keys) {
  if (!keys || typeof keys !== 'object') return null;
  if (typeof keys.default === 'string') return keys.default;
  return Object.entries(keys).find(([k, v]) => typeof v === 'string' && !['id', 'name', 'type', 'kind', 'location'].includes(k))?.[1] ?? null;
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
