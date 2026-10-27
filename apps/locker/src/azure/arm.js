// Azure itself: Azure Resource Manager for the subscriptions, web and function apps, their slots, settings,
// connection strings and Key Vault references, and the vaults; each vault's own API for its secrets and
// certificates. createAzure builds the provider the app talks to; src/demo.js has the same interface
// without Azure. Everything goes through `fetch` with a token from `token(resource)`, both passed in, so
// tests run it against a fake. A secret's value is read only by secretValue, on purpose, and nothing here
// puts one in an error.
import { callSignal } from '@fleet/kit/run.js';

export const ARM = 'https://management.azure.com';
// Key Vault's data plane, with a token of its own.
export const VAULT = 'https://vault.azure.net';
const WEB = '2023-12-01';
const KV_ARM = '2023-07-01';
const KV = '7.4';

/** Azure's error, in words: ARM's and Key Vault's { error: { code, message } }. */
export function azureError(status, body, what) {
  const e = body?.error ?? body?.Error;
  const inner = e?.innererror?.code ?? e?.innerError?.code;
  const message = [e?.message, inner].filter(Boolean).join(': ') || `Azure answered ${status}`;
  if (status === 401) return `${what}: the sign-in was refused (${message}). Try az login.`;
  if (status === 403) return `${what}: you don't have access (${message})`;
  if (status === 404) return `${what}: not found (${message})`;
  return `${what}: ${message}`;
}

/** The app's kind from ARM's comma list ("functionapp,linux"): 'function' or 'app'. */
export const kindOf = (kind) => (/functionapp/i.test(kind ?? '') ? 'function' : 'app');

const groupOf = (id) => /\/resourceGroups\/([^/]+)/i.exec(id ?? '')?.[1] ?? '';

/** An ARM site or slot as Locker shows it: { id, name, slot, kind, resourceGroup, location, state }. */
export function siteFrom(s, parent = null) {
  const p = s.properties ?? {};
  return {
    id: s.id,
    name: parent ? parent.name : s.name,
    // A slot's name is "app/slot".
    slot: parent ? String(s.name).split('/').pop() : null,
    kind: kindOf(s.kind),
    resourceGroup: p.resourceGroup ?? groupOf(s.id),
    location: s.location,
    state: p.state ?? 'Unknown',
  };
}

/** An app or slot in words: shop-api, shop-api/staging. */
export const label = (t) => (t ? `${t.name}${t.slot ? `/${t.slot}` : ''}` : '');

/** A vault from ARM: { id, name, uri, resourceGroup, location }. */
export function vaultFrom(v) {
  return { id: v.id, name: v.name, uri: String(v.properties?.vaultUri ?? `https://${v.name}.vault.azure.net/`).replace(/\/?$/, '/'), resourceGroup: groupOf(v.id), location: v.location };
}

const iso = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);

/** A secret's or certificate's name from its id (https://v.vault.azure.net/secrets/<name>[/<version>]). */
export const nameOfId = (id) => String(id ?? '').split('/')[4] ?? '';

/** A secret as Key Vault lists it (never with its value): { name, enabled, contentType, created, updated, expires, notBefore, managed }. */
export function secretFrom(s) {
  const a = s.attributes ?? {};
  return {
    kind: 'secret',
    name: nameOfId(s.id),
    enabled: a.enabled !== false,
    contentType: s.contentType ?? '',
    created: iso(a.created),
    updated: iso(a.updated),
    expires: iso(a.exp),
    notBefore: iso(a.nbf),
    // The secret behind a certificate: the certificate's own row says what matters about it.
    managed: Boolean(s.managed),
  };
}

/** A certificate as Key Vault lists it: { kind: 'certificate', name, enabled, created, updated, expires, thumbprint }. */
export function certificateFrom(c) {
  const a = c.attributes ?? {};
  return { kind: 'certificate', name: nameOfId(c.id), enabled: a.enabled !== false, contentType: 'certificate', created: iso(a.created), updated: iso(a.updated), expires: iso(a.exp), notBefore: iso(a.nbf), thumbprint: c.x5t ?? '' };
}

/** How one of an app's Key Vault references resolved, as ARM's configreferences say: { name, status, details, vault, secret }. */
export function referenceFrom(r) {
  const p = r.properties ?? {};
  return { name: String(r.name ?? r.id ?? '').split('/').pop(), status: p.status ?? 'Unknown', details: p.details ?? '', vault: p.vaultName ?? '', secret: p.secretName ?? '' };
}

const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const stop = () => (clearTimeout(t), reject(Object.assign(new Error('Cancelled'), { cancelled: true })));
    const t = setTimeout(() => (signal?.removeEventListener('abort', stop), resolve()), ms);
    signal?.addEventListener('abort', stop, { once: true });
  });

/** A secret's name in a vault's address, refused when it isn't one (nothing else may reach the URL). */
function secretPath(name) {
  if (!/^[0-9A-Za-z-]{1,127}$/.test(String(name ?? ''))) throw new Error(`"${name}" isn't a Key Vault secret name: letters, digits and dashes.`);
  return encodeURIComponent(name);
}

/** The provider over real Azure: `fetch` and `token(resource)` from outside. */
export function createAzure({ fetch = globalThis.fetch, token }) {
  // Throttled calls are tried again; failures are thrown in words, with the status on the error.
  const call = async (resource, url, { method = 'GET', body, signal, what = 'Azure' } = {}, tries = 0) => {
    const own = callSignal(signal);
    let res;
    let text;
    try {
      res = await fetch(url, {
        method,
        signal: own.signal,
        headers: { Authorization: `Bearer ${await token(resource)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429 && tries < 3 && !signal?.aborted) {
        own.done();
        const said = Number(res.headers?.get?.('retry-after'));
        await pause(Math.min(30_000, Number.isFinite(said) && said >= 0 ? said * 1000 : 1000 * 2 ** tries), signal);
        return call(resource, url, { method, body, signal, what }, tries + 1);
      }
      text = await res.text();
    } finally {
      own.done();
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: the status says enough.
    }
    if (!res.ok) throw Object.assign(new Error(azureError(res.status, json, what)), { status: res.status });
    return json;
  };
  const arm = (path, opts) => call(`${ARM}/`, path.startsWith('http') ? path : `${ARM}${path}`, opts);
  const kv = (vault, path, opts) => call(VAULT, `${vault.uri}${path}${path.includes('?') ? '&' : '?'}api-version=${KV}`, opts);
  // ARM and Key Vault page their lists with nextLink.
  const all = async (first, get, opts) => {
    const out = [];
    for (let url = first; url; ) {
      const page = await get(url, opts);
      out.push(...(page?.value ?? []));
      url = page?.nextLink ?? null;
    }
    return out;
  };
  return {
    kind: 'azure',
    async subscriptions(opts) {
      const subs = await all('/subscriptions?api-version=2022-12-01', arm, { ...opts, what: 'Listing subscriptions' });
      return subs.filter((s) => s.state !== 'Disabled').map((s) => ({ id: s.subscriptionId, name: s.displayName }));
    },
    /** The subscription's web and function apps (no slots: slots(site) reads those). */
    async sites(sub, opts) {
      const sites = await all(`/subscriptions/${sub}/providers/Microsoft.Web/sites?api-version=${WEB}`, arm, { ...opts, what: 'Listing the apps' });
      return sites.map((s) => siteFrom(s)).sort((a, b) => a.resourceGroup.localeCompare(b.resourceGroup) || a.name.localeCompare(b.name));
    },
    async slots(site, opts) {
      const slots = await all(`${site.id}/slots?api-version=${WEB}`, arm, { ...opts, what: `Listing ${site.name}'s slots` });
      return slots.map((s) => siteFrom(s, site));
    },
    /** An app's or slot's application settings, { name: value }. */
    async settings(target, opts) {
      const r = await arm(`${target.id}/config/appsettings/list?api-version=${WEB}`, { ...opts, method: 'POST', what: `Reading ${label(target)}'s settings` });
      return r?.properties ?? {};
    },
    /** Its connection strings, { name: { value, type } }. */
    async connectionStrings(target, opts) {
      const r = await arm(`${target.id}/config/connectionstrings/list?api-version=${WEB}`, { ...opts, method: 'POST', what: `Reading ${label(target)}'s connection strings` });
      return Object.fromEntries(Object.entries(r?.properties ?? {}).map(([k, v]) => [k, { value: v?.value ?? '', type: v?.type ?? 'Custom' }]));
    },
    /** How its Key Vault references resolved, settings' and connection strings' (referenceFrom's). */
    async references(target, opts) {
      const read = (kind) => all(`${target.id}/config/configreferences/${kind}?api-version=2022-03-01`, arm, { ...opts, what: `Reading ${label(target)}'s Key Vault references` }).catch(() => []);
      const [settings, strings] = await Promise.all([read('appsettings'), read('connectionstrings')]);
      return [...settings, ...strings].map(referenceFrom);
    },
    async vaults(sub, opts) {
      const list = await all(`/subscriptions/${sub}/providers/Microsoft.KeyVault/vaults?api-version=${KV_ARM}`, arm, { ...opts, what: 'Listing the key vaults' });
      return list.map(vaultFrom).sort((a, b) => a.name.localeCompare(b.name));
    },
    /** A vault's secrets, without their values (and without those behind certificates). */
    async secrets(vault, opts) {
      const list = await all('secrets?maxresults=25', (url, o) => (url.startsWith('http') ? call(VAULT, url, o) : kv(vault, url, o)), { ...opts, what: `Listing ${vault.name}'s secrets` });
      return list.map(secretFrom).filter((s) => !s.managed).sort((a, b) => a.name.localeCompare(b.name));
    },
    async certificates(vault, opts) {
      const list = await all('certificates?maxresults=25', (url, o) => (url.startsWith('http') ? call(VAULT, url, o) : kv(vault, url, o)), { ...opts, what: `Listing ${vault.name}'s certificates` });
      return list.map(certificateFrom).sort((a, b) => a.name.localeCompare(b.name));
    },
    /** A secret's current value: only ever on an explicit ask (reveal, copy, add to .env). */
    async secretValue(vault, name, opts) {
      const r = await kv(vault, `secrets/${secretPath(name)}`, { ...opts, what: `Reading ${name} in ${vault.name}` });
      return String(r?.value ?? '');
    },
    /** Sets a secret (a new version of it, or the first); the answer, which repeats the value, is dropped. */
    async setSecret(vault, name, value, { contentType, ...opts } = {}) {
      await kv(vault, `secrets/${secretPath(name)}`, { ...opts, method: 'PUT', body: { value: String(value), ...(contentType ? { contentType } : {}) }, what: `Setting ${name} in ${vault.name}` });
    },
    /** Turns a secret's current version off (enabled false), or back on. */
    async enableSecret(vault, name, enabled, opts) {
      await kv(vault, `secrets/${secretPath(name)}/`, { ...opts, method: 'PATCH', body: { attributes: { enabled: Boolean(enabled) } }, what: `${enabled ? 'Enabling' : 'Disabling'} ${name} in ${vault.name}` });
    },
    portalUrl: (resource) => `https://portal.azure.com/#@/resource${resource.id}`,
  };
}
