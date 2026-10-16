// Azure DevOps organizations Keel connects to. The primary one comes from
// AZDO_ORG_URL (or the demo organization) and can't be removed; Admins add
// more in Settings, kept in the data folder (orgs.json, shared by every
// server process). Each organization has a short key, e.g. "contoso".
import path from 'node:path';
import { config } from './config.js';
import { sharedJson } from './jsonfile.js';

export const DEMO_ORG_URL = 'https://dev.azure.com/contoso-demo';

const err = (message, status = 400) => Object.assign(new Error(message), { status });

/** "https://dev.azure.com/acme" → "acme"; "https://acme.visualstudio.com" → "acme"; a server collection → "host-collection". */
export function orgKeyOf(url) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'dev.azure.com' && parts[0]) return parts[0].toLowerCase();
  const vs = host.match(/^([^.]+)\.visualstudio\.com$/);
  if (vs) return vs[1];
  return [host.split('.')[0], ...parts].join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/** A cleaned organization URL, or an error a person can act on. */
export function normalizeOrgUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw err('Enter the organization address, like https://dev.azure.com/your-org');
  }
  if (u.protocol !== 'https:' && !(config.mock && u.protocol === 'http:')) throw err('Use an https address for the organization.');
  if (u.username || u.password || u.search || u.hash) throw err('Enter just the organization address, without credentials or query.');
  const parts = u.pathname.split('/').filter(Boolean);
  if (u.hostname.toLowerCase() === 'dev.azure.com') {
    if (!parts[0]) throw err('Add the organization name: https://dev.azure.com/your-org');
    return `https://dev.azure.com/${parts[0]}`;
  }
  if (/\.visualstudio\.com$/i.test(u.hostname)) return `https://${u.hostname.toLowerCase()}`;
  // Azure DevOps Server: keep the collection path.
  return `${u.origin}${parts.length ? `/${parts.join('/')}` : ''}`;
}

export function createOrgStore(file = path.join(config.dataDir, config.mock ? 'orgs.mock.json' : 'orgs.json')) {
  const store = sharedJson(file, () => ({ orgs: [] }));
  const primaryUrl = config.mock ? DEMO_ORG_URL : config.orgUrl;
  const primary = () => (primaryUrl ? { key: orgKeyOf(primaryUrl), url: primaryUrl, name: orgKeyOf(primaryUrl), primary: true } : null);

  return {
    primary,
    /** Every organization: the primary first, then the ones Admins added. */
    all() {
      const p = primary();
      const extras = (store.get().orgs || []).filter((o) => o.key !== p?.key);
      return [...(p ? [p] : []), ...extras.map((o) => ({ ...o, primary: false }))];
    },
    get(key) {
      return this.all().find((o) => o.key === key) || null;
    },
    /** Changes whenever the list changes, so per-person connections are rebuilt. */
    signature() {
      return this.all().map((o) => o.key).join(',');
    },
    add({ url, name }) {
      const clean = normalizeOrgUrl(url);
      const key = orgKeyOf(clean);
      if (this.all().some((o) => o.key === key)) throw err(`${key} is already connected.`, 409);
      store.update((d) => {
        d.orgs = [...(d.orgs || []), { key, url: clean, name: String(name || '').trim().slice(0, 60) || key }];
      });
      return this.get(key);
    },
    rename(key, name) {
      if (primary()?.key === key) throw err('The primary organization comes from AZDO_ORG_URL.');
      store.update((d) => {
        const o = (d.orgs || []).find((x) => x.key === key);
        if (!o) throw err('No such organization.', 404);
        o.name = String(name || '').trim().slice(0, 60) || key;
      });
    },
    remove(key) {
      if (primary()?.key === key) throw err('The primary organization comes from AZDO_ORG_URL and can\'t be removed.');
      store.update((d) => {
        const before = (d.orgs || []).length;
        d.orgs = (d.orgs || []).filter((o) => o.key !== key);
        if (d.orgs.length === before) throw err('No such organization.', 404);
      });
    },
  };
}
