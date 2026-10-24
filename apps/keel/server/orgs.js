// Organizations Keel connects to. The primary one is Azure DevOps, from
// AZDO_ORG_URL (or the demo organization), and can't be removed; Admins add
// more in Settings, kept in the data folder (orgs.json, shared by every
// server process): other Azure DevOps organizations, or GitHub owners
// (kind "github", an organization or user on GitHub or GitHub Enterprise
// Server). Each has a short key, e.g. "contoso" or "gh-acme".
import path from 'node:path';
import { config } from './config.js';
import { sharedJson } from './jsonfile.js';

export const DEMO_ORG_URL = 'https://dev.azure.com/contoso-demo';

const err = (message, status = 400) => Object.assign(new Error(message), { status });

/** Whether an address is a GitHub owner's: github.com, unless said otherwise. */
export const kindOf = (url, kind) => (kind === 'github' || kind === 'azdo' ? kind : /(^|\.)github\.com$/i.test(safeHost(url)) ? 'github' : 'azdo');
const safeHost = (url) => {
  try {
    return new URL(String(url).trim()).hostname;
  } catch {
    return '';
  }
};

/**
 * "https://dev.azure.com/acme" → "acme"; "https://acme.visualstudio.com" → "acme"; a server collection → "host-collection".
 * GitHub: "https://github.com/acme" → "gh-acme", and on a GitHub Enterprise Server "gh-host-acme".
 */
export function orgKeyOf(url, kind = 'azdo') {
  const u = new URL(url);
  if (kind === 'github') {
    const host = u.hostname.toLowerCase();
    const owner = u.pathname.split('/').filter(Boolean)[0]?.toLowerCase() || '';
    return (host === 'github.com' ? `gh-${owner}` : `gh-${host.split('.')[0]}-${owner}`).replace(/[^a-z0-9-]/g, '-');
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'dev.azure.com' && parts[0]) return parts[0].toLowerCase();
  const vs = host.match(/^([^.]+)\.visualstudio\.com$/);
  if (vs) return vs[1];
  return [host.split('.')[0], ...parts].join('-').toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/** A cleaned organization URL, or an error a person can act on. */
export function normalizeOrgUrl(raw, kind = 'azdo') {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw err(kind === 'github' ? 'Enter the GitHub address, like https://github.com/your-org' : 'Enter the organization address, like https://dev.azure.com/your-org');
  }
  if (u.protocol !== 'https:' && !(config.mock && u.protocol === 'http:')) throw err('Use an https address for the organization.');
  if (u.username || u.password || u.search || u.hash) throw err('Enter just the organization address, without credentials or query.');
  const parts = u.pathname.split('/').filter(Boolean);
  if (kind === 'github') {
    // An organization or user: its first path segment. A repository's address names its owner too.
    if (!parts[0]) throw err('Add the organization or user: https://github.com/your-org');
    return `${u.origin.toLowerCase()}/${parts[0]}`;
  }
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
  const primary = () => (primaryUrl ? { key: orgKeyOf(primaryUrl), url: primaryUrl, name: orgKeyOf(primaryUrl), kind: 'azdo', primary: true } : null);

  return {
    primary,
    /** Every organization: the primary first, then the ones Admins added. */
    all() {
      const p = primary();
      const extras = (store.get().orgs || []).filter((o) => o.key !== p?.key);
      return [...(p ? [p] : []), ...extras.map((o) => ({ ...o, kind: o.kind || 'azdo', primary: false }))];
    },
    get(key) {
      return this.all().find((o) => o.key === key) || null;
    },
    /** Changes whenever the list changes, so per-person connections are rebuilt. */
    signature() {
      return this.all().map((o) => o.key).join(',');
    },
    add({ url, name, kind }) {
      const k = kindOf(url, kind);
      const clean = normalizeOrgUrl(url, k);
      const key = orgKeyOf(clean, k);
      if (this.all().some((o) => o.key === key)) throw err(`${key} is already connected.`, 409);
      const fallback = k === 'github' ? new URL(clean).pathname.slice(1) : key;
      store.update((d) => {
        d.orgs = [...(d.orgs || []), { key, url: clean, name: String(name || '').trim().slice(0, 60) || fallback, kind: k }];
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
