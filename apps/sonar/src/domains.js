// /domains: an App Service app's custom domains checked from the outside through the kit's webchecks.js
// (DNS, the redirects from http:// and the bare domain, https enforced or not, the certificate's days
// left), and the stand-in network the demo checks them against. Pure but for the demo's stand-ins.
import { domainLines } from '@fleet/kit/webchecks.js';
import { findingsText } from '@fleet/kit/findings.js';

/** An app's custom domains: its host names without Azure's own (*.azurewebsites.net and the like). */
export const customDomains = (target) => (target.hostNames ?? []).filter((h) => h && !/\.(azurewebsites\.net|azurewebsites\.windows\.net|azurecontainerapps\.io|azurestaticapps\.net)$/i.test(h));

/** The checks of each domain as one text, for the viewer: what is wrong first, then the records, redirects, https and certificate. */
export const domainsText = (checked) => checked.map((d) => [d.host, ...findingsText(d.findings).trimEnd().split('\n').map((l) => (l ? `  ${l}` : '')), '', ...domainLines(d).map((l) => (l ? `  ${l}` : ''))].join('\n')).join('\n\n');

const DAY = 86_400_000;

/**
 * The demo's network for its custom domains: shop.contoso.com sends http to https but its certificate
 * runs out in 20 days and nobody wrote a CAA record; api.contoso.com answers plain http as it is.
 */
export function demoDomainNetwork(now) {
  const zone = {
    'CNAME shop.contoso.com': ['contoso-web.azurewebsites.net'],
    'A shop.contoso.com': ['20.50.2.10'],
    'A contoso-web.azurewebsites.net': ['20.50.2.10'],
    'CNAME api.contoso.com': ['contoso-api.azurewebsites.net'],
    'A api.contoso.com': ['20.50.2.11'],
    'A contoso-api.azurewebsites.net': ['20.50.2.11'],
    'CAA api.contoso.com': [{ critical: 0, issue: 'digicert.com' }],
    'MX contoso.com': [{ exchange: 'contoso-com.mail.protection.outlook.com', priority: 0 }],
  };
  const ask = (type) => async (name) => {
    if (zone[`${type} ${name}`]) return zone[`${type} ${name}`];
    throw Object.assign(new Error(`query${type} ENODATA ${name}`), { code: 'ENODATA' });
  };
  const routes = {
    'http://shop.contoso.com/': [301, { location: 'https://shop.contoso.com/' }],
    'https://shop.contoso.com/': [200, { 'content-type': 'text/html' }],
    'http://api.contoso.com/': [200, { 'content-type': 'application/json' }],
    'https://api.contoso.com/': [200, { 'content-type': 'application/json' }],
  };
  return {
    resolver: { resolve4: ask('A'), resolve6: ask('AAAA'), resolveCname: ask('CNAME'), resolveCaa: ask('CAA'), resolveMx: ask('MX') },
    fetchImpl: async (url) => {
      const r = routes[url];
      if (!r) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      return new Response(r[0] >= 300 && r[0] < 400 ? null : '{}', { status: r[0], headers: r[1] });
    },
    probe: async (url) => {
      const host = new URL(url).hostname;
      return { protocol: 'TLSv1.3', authorized: true, validTo: new Date(now + (host.startsWith('shop.') ? 20 : 200) * DAY).toISOString(), subject: host, issuer: 'DigiCert Global G2 TLS RSA SHA256 2020 CA1', names: [host], selfSigned: false, hostnameError: null };
    },
  };
}
