// A web app's and a domain's checks from the outside, without a browser: the security headers, cookies'
// flags, what the server says it runs, the TLS certificate, mixed content and source maps served in
// production; and for a host, its DNS records (A, AAAA, CNAME, CAA, MX), the redirects from http:// and
// from the bare domain, whether https is enforced, and the days left on its certificate. Lantern runs
// them on its pages, Sonar on an App Service app's custom domains.
//
// The judges are pure and take what came back: a response is { url?, status, headers, body? }, its
// headers [[name, value]] pairs (Hail's shape), a plain object or a fetch Headers; they return findings
// in the kit's findings.js shape, `where` the URL or the host, `excerpt` the header or record seen
// (never a cookie's value), and any `extra` fields given. The fetchers (`fetchPage`, `redirectChain`,
// `probeCertificate`, `lookupDns`, `findSourceMaps`) and the two that put it all together (`checkSite`,
// `checkDomain`) take their fetch, TLS connect and resolver as options, so tests answer for them.
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

export const CHECK_TIMEOUT = 8000;
// A certificate this close to its end is a finding: high under a week, medium under a month.
export const EXPIRY_WARN_DAYS = 30;
export const EXPIRY_HIGH_DAYS = 7;
// What a page's body is read up to, and how many of its scripts are looked at for a source map.
const BODY_MAX = 2_000_000;
const SCRIPTS_MAX = 8;
const HIDDEN = '••••••';

// ---------------------------------------------------------------------------------------------------
// Headers.

/** A response's headers as [[name, value]] pairs, from pairs, a plain object or a fetch Headers (each Set-Cookie its own pair). */
export function headerPairs(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers;
  if (typeof headers.entries === 'function' && typeof headers.get === 'function') {
    const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    const pairs = [...headers.entries()].filter(([k]) => !(cookies.length && k.toLowerCase() === 'set-cookie'));
    return [...pairs, ...cookies.map((c) => ['set-cookie', c])];
  }
  return Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, String(v)]]));
}

/** The first value of header `name`, or undefined. */
export const headerValue = (headers, name) => headerPairs(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const headerValues = (headers, name) => headerPairs(headers).filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v);

const finding = (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const isHtml = (res) => /html/i.test(headerValue(res?.headers, 'content-type') ?? '') || /^\s*<(!doctype|html)/i.test(res?.body ?? '');
const isHttps = (url) => /^https:/i.test(String(url ?? ''));

/**
 * The security headers a page (or an API's answer) should carry: CSP, HSTS (over https), nosniff,
 * frame protection (X-Frame-Options or CSP frame-ancestors) and Referrer-Policy. `https` defaults to
 * the URL's scheme. Rules: csp-missing, hsts-missing, hsts-short, xcto-missing, framing-allowed,
 * referrer-policy-missing (Hail's /scan uses the same ids).
 */
export function judgeHeaders(res, { where = res?.url, https = isHttps(where), extra = {} } = {}) {
  if (!res) return [];
  const h = (n) => headerValue(res.headers, n);
  const html = isHtml(res);
  const base = { where, ...extra };
  const out = [];
  const hsts = h('strict-transport-security');
  if (https && !hsts) out.push(finding({ ...base, rule: 'hsts-missing', severity: 'medium', title: 'No Strict-Transport-Security', why: 'A first visit over http, or a downgrade on the way, can be intercepted before the browser reaches https.', fix: 'Strict-Transport-Security: max-age=31536000; includeSubDomains' }));
  else if (https) {
    const age = Number(/max-age\s*=\s*"?(\d+)/i.exec(hsts)?.[1] ?? 0);
    if (age < 15_552_000) out.push(finding({ ...base, rule: 'hsts-short', severity: 'low', title: 'Strict-Transport-Security lasts under 180 days', excerpt: `Strict-Transport-Security: ${hsts}`, why: 'A short max-age leaves returning visitors open to a downgrade sooner.', fix: 'max-age=31536000 (a year) or more.' }));
  }
  const csp = h('content-security-policy');
  if (!csp) out.push(finding({ ...base, rule: 'csp-missing', severity: html ? 'medium' : 'low', title: 'No Content-Security-Policy', why: html ? "Without one, an injected script runs with the page's full rights." : 'A JSON response rendered as a page (an error, an old browser) has no limits on what runs.', fix: html ? "Start from Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; object-src 'none'" : "Content-Security-Policy: default-src 'none'; frame-ancestors 'none' on API responses." }));
  if (!/nosniff/i.test(h('x-content-type-options') ?? '')) out.push(finding({ ...base, rule: 'xcto-missing', severity: 'low', title: 'No X-Content-Type-Options: nosniff', why: 'Browsers may guess a response is a script or a page from its content.', fix: 'X-Content-Type-Options: nosniff' }));
  if (!h('x-frame-options') && !/frame-ancestors/i.test(csp ?? '')) out.push(finding({ ...base, rule: 'framing-allowed', severity: html ? 'medium' : 'low', title: 'Any site can frame it', why: 'Neither X-Frame-Options nor CSP frame-ancestors is set, so it can be framed for clickjacking.', fix: "Content-Security-Policy: frame-ancestors 'none' (or X-Frame-Options: DENY)." }));
  if (!h('referrer-policy')) out.push(finding({ ...base, rule: 'referrer-policy-missing', severity: 'low', title: 'No Referrer-Policy', why: 'Links to other sites may carry full URLs, query strings included.', fix: 'Referrer-Policy: strict-origin-when-cross-origin (or no-referrer).' }));
  return out;
}

/** What the server gives away: a version in Server, X-Powered-By and ASP.NET's version headers. Rules server-version, powered-by. */
export function judgeServerHeaders(res, { where = res?.url, extra = {} } = {}) {
  if (!res) return [];
  const out = [];
  const server = headerValue(res.headers, 'server');
  if (server && /\d/.test(server)) out.push(finding({ where, ...extra, rule: 'server-version', severity: 'low', title: 'Server says its version', excerpt: `Server: ${server}`, why: 'A version tells an attacker which known vulnerabilities to try.', fix: 'Send Server without a version, or not at all.' }));
  for (const name of ['X-Powered-By', 'X-AspNet-Version', 'X-AspNetMvc-Version', 'X-Generator']) {
    const v = headerValue(res.headers, name);
    if (v) out.push(finding({ where, ...extra, rule: 'powered-by', severity: 'low', title: `${name} says what it runs on`, excerpt: `${name}: ${v}`, why: 'The framework (and its version) tells an attacker what to try.', fix: `Stop sending ${name} (app.disable('x-powered-by'), removing it in web.config and the like).` }));
  }
  return out;
}

/** A Set-Cookie value as { name, attrs: Map of lower-case attribute → value, sameSite }. */
export function parseSetCookie(value) {
  const [pair, ...rest] = String(value).split(';');
  const attrs = new Map(
    rest
      .map((a) => a.trim())
      .filter(Boolean)
      .map((a) => {
        const i = a.indexOf('=');
        return i < 0 ? [a.toLowerCase(), ''] : [a.slice(0, i).trim().toLowerCase(), a.slice(i + 1).trim()];
      }),
  );
  return { name: pair.split('=')[0].trim(), attrs, sameSite: attrs.get('samesite') ?? null };
}

// Names that look like a session or a sign-in: the cookies that must be HttpOnly.
const SESSIONISH = /sess|sid$|^sid|auth|token|jwt|login|remember|identity|^connect\.sid$|^phpsessid$|^jsessionid$|^asp\.net_sessionid$|^\.aspnetcore\.|^__host-|^__secure-/i;

/**
 * Each cookie set without Secure (over https), HttpOnly (a session's) or SameSite. The excerpt has the
 * cookie's name and flags, never its value. Rules cookie-not-secure, cookie-not-httponly,
 * cookie-no-samesite, cookie-samesite-none-insecure.
 */
export function judgeCookies(res, { where = res?.url, https = isHttps(where), extra = {} } = {}) {
  const out = [];
  for (const raw of headerValues(res?.headers, 'set-cookie')) {
    const c = parseSetCookie(raw);
    if (!c.name) continue;
    const excerpt = `Set-Cookie: ${c.name}=${HIDDEN}${[...c.attrs].map(([k, v]) => `; ${k}${v ? `=${v}` : ''}`).join('')}`;
    const base = { where, ...extra, excerpt, cookie: c.name };
    if (https && !c.attrs.has('secure')) out.push(finding({ ...base, rule: 'cookie-not-secure', severity: 'medium', title: `Cookie ${c.name} isn't Secure`, why: 'Without Secure, the browser also sends it over plain http, where it can be read.', fix: `Set-Cookie: ${c.name}=…; Secure` }));
    if (SESSIONISH.test(c.name) && !c.attrs.has('httponly')) out.push(finding({ ...base, rule: 'cookie-not-httponly', severity: 'medium', title: `Session cookie ${c.name} isn't HttpOnly`, why: 'Any script on the page (an injected one too) can read it and take the session.', fix: `Set-Cookie: ${c.name}=…; HttpOnly` }));
    if (!c.sameSite) out.push(finding({ ...base, rule: 'cookie-no-samesite', severity: 'low', title: `Cookie ${c.name} has no SameSite`, why: "Browsers' default (Lax) varies; saying it makes cross-site requests' behaviour certain.", fix: `Set-Cookie: ${c.name}=…; SameSite=Lax (or Strict)` }));
    else if (/^none$/i.test(c.sameSite) && !c.attrs.has('secure')) out.push(finding({ ...base, rule: 'cookie-samesite-none-insecure', severity: 'medium', title: `Cookie ${c.name} is SameSite=None without Secure`, why: 'Browsers reject SameSite=None without Secure, and it goes on every cross-site request.', fix: `Set-Cookie: ${c.name}=…; SameSite=None; Secure, or SameSite=Lax` }));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The certificate.

/** Whole days from `now` to `validTo` (negative once it has passed), or null without one. */
export function daysLeft(validTo, now = new Date()) {
  if (!validTo) return null;
  const t = new Date(validTo).getTime();
  return Number.isNaN(t) ? null : Math.floor((t - now.getTime()) / 86_400_000);
}

/**
 * What a certificate probe found (`probeCertificate`'s { validTo, selfSigned, authorizationError,
 * hostnameError, error }) as findings for `where`. Rules cert-expired, cert-expiring,
 * cert-hostname-mismatch, cert-self-signed, cert-untrusted, tls-unchecked (Hail's ids).
 */
export function judgeCertificate(info, { where, now = new Date(), extra = {} } = {}) {
  if (!info) return [];
  const base = { where, ...extra };
  if (info.error) return [finding({ ...base, rule: 'tls-unchecked', severity: 'unknown', title: "Couldn't check the certificate", why: info.error })];
  const out = [];
  const days = daysLeft(info.validTo, now);
  if (days !== null) {
    const at = new Date(info.validTo).toISOString().slice(0, 10);
    if (days < 0) out.push(finding({ ...base, rule: 'cert-expired', severity: 'critical', title: 'The certificate has expired', excerpt: `Not after: ${at}`, days, why: 'Browsers refuse the site, and clients that skip the check are open to interception.', fix: 'Renew the certificate (and automate it).' }));
    else if (days < EXPIRY_WARN_DAYS) out.push(finding({ ...base, rule: 'cert-expiring', severity: days < EXPIRY_HIGH_DAYS ? 'high' : 'medium', title: `The certificate expires in ${days} day${days === 1 ? '' : 's'}`, excerpt: `Not after: ${at}`, days, why: 'Once it expires, browsers refuse the site.', fix: 'Renew the certificate (and automate it).' }));
  }
  if (info.hostnameError) out.push(finding({ ...base, rule: 'cert-hostname-mismatch', severity: 'high', title: "The certificate doesn't name this host", excerpt: info.hostnameError, why: 'Browsers refuse it; clients told to ignore it are open to interception.', fix: 'Serve a certificate whose names include this host.' }));
  if (info.selfSigned) out.push(finding({ ...base, rule: 'cert-self-signed', severity: 'high', title: 'The certificate is self-signed', excerpt: info.authorizationError ?? 'Issuer is the subject', why: 'Nothing vouches for it, so browsers refuse it and a man in the middle can present their own.', fix: "Use a certificate from a trusted CA (Let's Encrypt, your cloud's)." }));
  else if (info.authorizationError && !info.hostnameError && !/EXPIRED/.test(info.authorizationError)) {
    out.push(finding({ ...base, rule: 'cert-untrusted', severity: 'high', title: "The certificate isn't trusted", excerpt: info.authorizationError, why: "Its chain doesn't lead to a trusted CA (an intermediate missing, or a private CA).", fix: 'Serve the full chain from a trusted CA.' }));
  }
  return out;
}

/**
 * One TLS handshake with `host:port` (from an https URL or a host), not refusing what it finds:
 * { protocol, validFrom, validTo, subject, issuer, names, selfSigned, authorized, authorizationError,
 * hostnameError }, or { error } when no handshake works. `connect` is tls.connect (tests pass their own
 * `ca` through `options`).
 */
export function probeCertificate(target, { timeout = CHECK_TIMEOUT, connect = tls.connect, options = {} } = {}) {
  const u = /^[a-z]+:\/\//i.test(target) ? new URL(target) : new URL(`https://${target}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port) || 443;
  return new Promise((resolve) => {
    let s;
    const done = (value) => {
      clearTimeout(timer);
      s?.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done({ error: `${u.host} didn't finish the TLS handshake within ${timeout / 1000} s` }), timeout);
    try {
      s = connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'], ...options });
    } catch (e) {
      return done({ error: e.message });
    }
    s.once('secureConnect', () => {
      const cert = s.getPeerCertificate(true);
      if (!cert || !Object.keys(cert).length) return done({ error: `${u.host} sent no certificate` });
      const identity = tls.checkServerIdentity(host, cert);
      const authError = s.authorizationError ? String(s.authorizationError.code ?? s.authorizationError) : null;
      done({
        protocol: s.getProtocol(),
        authorized: s.authorized,
        authorizationError: authError,
        validFrom: cert.valid_from ? new Date(cert.valid_from).toISOString() : null,
        validTo: cert.valid_to ? new Date(cert.valid_to).toISOString() : null,
        subject: cert.subject?.CN ?? null,
        issuer: cert.issuer?.CN ?? cert.issuer?.O ?? null,
        names: String(cert.subjectaltname ?? '').split(/,\s*/).filter((n) => n.startsWith('DNS:')).map((n) => n.slice(4)),
        selfSigned: Boolean(cert.fingerprint256 && cert.issuerCertificate?.fingerprint256 === cert.fingerprint256) || /SELF_SIGNED/.test(authError ?? ''),
        hostnameError: identity ? identity.reason ?? identity.message : null,
      });
    });
    s.once('error', (e) => done({ error: e.message }));
  });
}

// ---------------------------------------------------------------------------------------------------
// The page's body: mixed content and source maps.

const ATTR = (name) => new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
const attrOf = (tag, name) => {
  const m = ATTR(name).exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : null;
};
const tagsOf = (html, names) => [...String(html ?? '').replace(/<!--[\s\S]*?-->/g, '').matchAll(new RegExp(`<(${names})\\b[^>]*>`, 'gi'))].map((m) => ({ name: m[1].toLowerCase(), tag: m[0] }));

// Which tags load what, and whether a browser blocks it on an https page (active) or only warns (passive).
const LOADS = [
  { tags: 'script', attr: 'src', active: true },
  { tags: 'iframe|frame', attr: 'src', active: true },
  { tags: 'object', attr: 'data', active: true },
  { tags: 'embed', attr: 'src', active: true },
  { tags: 'link', attr: 'href', active: true, when: (tag) => /\brel\s*=\s*["']?[^"'>]*\b(stylesheet|preload|modulepreload|icon)\b/i.test(tag) },
  { tags: 'img|audio|video|source|track', attr: 'src', active: false },
  { tags: 'form', attr: 'action', active: true },
];

/** What an https page's HTML loads over plain http: [{ tag, url, active }]. Nothing for an http page. */
export function mixedContent(html, pageUrl) {
  if (!isHttps(pageUrl)) return [];
  const out = [];
  for (const l of LOADS) {
    for (const { name, tag } of tagsOf(html, l.tags)) {
      if (l.when && !l.when(tag)) continue;
      const v = attrOf(tag, l.attr);
      if (v && /^http:\/\//i.test(v)) out.push({ tag: name, url: v, active: l.active });
    }
  }
  return out;
}

/** Mixed content as findings: what a browser blocks (scripts, frames, styles, forms) medium, images and media low. Rule mixed-content. */
export function judgeMixedContent(list, { where, extra = {} } = {}) {
  return list.map((m) =>
    finding({
      where,
      ...extra,
      rule: 'mixed-content',
      severity: m.active ? 'medium' : 'low',
      title: m.active ? `A ${m.tag} is loaded over plain http` : `An ${m.tag === 'img' ? 'image' : m.tag} is loaded over plain http`,
      excerpt: `<${m.tag}> ${m.url}`,
      url: m.url,
      why: m.active ? 'Browsers block it on an https page, so that part of the page breaks; where it did load, anyone on the way could change it.' : 'Browsers mark the page not secure, and anyone on the way can see or swap it.',
      fix: `Load ${m.url.replace(/^http:/i, 'https:')} instead (or a path on the same site).`,
    }),
  );
}

/** The same-origin scripts an HTML page loads, as absolute URLs, first `max` of them. */
export function scriptUrls(html, pageUrl, max = SCRIPTS_MAX) {
  const origin = new URL(pageUrl).origin;
  const out = [];
  for (const { tag } of tagsOf(html, 'script')) {
    const src = attrOf(tag, 'src');
    if (!src) continue;
    try {
      const u = new URL(src, pageUrl);
      if (u.origin === origin && !out.includes(u.href)) out.push(u.href);
    } catch {
      // Not a URL: nothing to fetch.
    }
  }
  return out.slice(0, max);
}

/** The source map a script names (`//# sourceMappingURL=`), as an absolute URL or `inline` for a data: one; null when it names none. */
export function sourceMapUrl(js, scriptUrl) {
  const m = /\/[/*][#@]\s*sourceMappingURL\s*=\s*(\S+?)\s*(?:\*\/)?\s*$/m.exec(String(js ?? '').slice(-4000));
  if (!m) return null;
  if (/^data:/i.test(m[1])) return 'inline';
  try {
    return new URL(m[1], scriptUrl).href;
  } catch {
    return null;
  }
}

/** Whether a response body is a source map: JSON with `version`, `mappings` and `sources`. */
export function looksLikeSourceMap(body) {
  try {
    const j = JSON.parse(String(body ?? ''));
    return Boolean(j && typeof j === 'object' && 'mappings' in j && Array.isArray(j.sources));
  } catch {
    return false;
  }
}

/** Source maps found as findings: one per script whose map answers, or is inline. Rule source-map-served. */
export function judgeSourceMaps(list, { where, extra = {} } = {}) {
  return list.map((s) =>
    finding({
      where,
      ...extra,
      rule: 'source-map-served',
      severity: 'medium',
      title: s.inline ? `${shortPath(s.script)} carries its source map inline` : `${shortPath(s.script)}'s source map is served`,
      excerpt: s.inline ? `${s.script} (sourceMappingURL=data:…)` : s.map,
      url: s.map ?? s.script,
      why: s.sources ? `The original source (${s.sources} file${s.sources === 1 ? '' : 's'}, comments and names included) can be read by anyone.` : 'The original source, comments and names included, can be read by anyone.',
      fix: 'Build for production without source maps, or upload them to your error tracker and keep them off the server (hidden-source-map).',
    }),
  );
}

const shortPath = (url) => {
  try {
    const u = new URL(url);
    return u.pathname.split('/').filter(Boolean).at(-1) ?? u.pathname;
  } catch {
    return String(url);
  }
};

// ---------------------------------------------------------------------------------------------------
// Redirects and DNS.

/**
 * The redirects from http:// and from the bare domain, as findings for `host`: http that doesn't end on
 * https (no-https-redirect), a step from https back to http (redirect-downgrade), more than three hops
 * (redirect-chain-long), no https at all (https-unreachable), a bare domain that doesn't answer
 * (bare-domain-unreachable). A chain is redirectChain's [{ url, status, location?, error? }].
 */
export function judgeRedirects({ http, https, bare } = {}, { where, extra = {} } = {}) {
  const out = [];
  const base = { where, ...extra };
  const last = (chain) => chain?.at(-1);
  const route = (chain) => chain.map((s) => `${s.status ?? '×'} ${s.url}`).join(' → ');
  if (https && last(https)?.error && !https.some((s) => s.status)) out.push(finding({ ...base, rule: 'https-unreachable', severity: 'high', title: "https doesn't answer", excerpt: last(https).error, why: 'Without https, everything sent to the site can be read and changed on the way.', fix: 'Serve the site over https (a free certificate from your host or Let’s Encrypt).' }));
  if (http?.length) {
    const end = last(http);
    if (!end.error && !isHttps(end.url)) out.push(finding({ ...base, rule: 'no-https-redirect', severity: 'high', title: "Plain http isn't sent to https", excerpt: route(http), why: 'Anything sent over http, cookies and credentials included, can be read and changed on the way.', fix: 'Answer every http request with a 301 to the same URL over https (and send HSTS there).' }));
  }
  for (const chain of [http, https, bare].filter(Boolean)) {
    const down = chain.findIndex((s, i) => i > 0 && !isHttps(s.url) && isHttps(chain[i - 1].url));
    if (down > 0) {
      out.push(finding({ ...base, rule: 'redirect-downgrade', severity: 'medium', title: 'A redirect goes from https back to http', excerpt: route(chain), why: 'The hop over http can be intercepted, undoing what https protected.', fix: 'Redirect to https URLs only.' }));
      break;
    }
  }
  for (const chain of [http, bare].filter(Boolean)) {
    if (chain.length > 4) {
      out.push(finding({ ...base, rule: 'redirect-chain-long', severity: 'low', title: `${chain.length - 1} redirects before the page`, excerpt: route(chain), why: 'Each hop is a round trip before anything shows, and a slower first visit.', fix: 'Redirect straight to the final https URL.' }));
      break;
    }
  }
  if (bare?.length && last(bare).error && !bare.some((s) => s.status)) out.push(finding({ ...base, rule: 'bare-domain-unreachable', severity: 'low', title: `${hostOf(bare[0].url)} doesn't answer`, excerpt: last(bare).error, why: 'People type the domain without www; they get an error rather than the site.', fix: `Point ${hostOf(bare[0].url)} at the site and redirect it to the main host.` }));
  return out;
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url);
  }
};

/**
 * DNS records (lookupDns's) as findings for `host`: it doesn't resolve (dns-no-address), its CNAME
 * points at a name that doesn't (dangling-cname: anyone who claims that name serves your domain), no
 * CAA record on it or a parent (missing-caa).
 */
export function judgeDns(records, { where = records?.host, extra = {} } = {}) {
  if (!records) return [];
  const base = { where, ...extra };
  const out = [];
  const addresses = records.a.length + records.aaaa.length;
  if (records.cname.length && records.cnameResolves === false) out.push(finding({ ...base, rule: 'dangling-cname', severity: 'high', title: `${records.host} points at ${records.cname[0]}, which doesn't resolve`, excerpt: `CNAME ${records.cname[0]}`, why: 'Whoever claims that name (a deleted cloud app, a bucket) serves pages on your domain: a subdomain takeover.', fix: `Remove the CNAME, or point it at something that exists.` }));
  else if (!addresses && !records.cname.length) out.push(finding({ ...base, rule: 'dns-no-address', severity: 'high', title: `${records.host} doesn't resolve`, excerpt: records.errors?.a ?? 'No A, AAAA or CNAME record', why: 'Nobody can reach the site by this name.', fix: 'Add an A/AAAA record (or a CNAME) for it.' }));
  if (!records.caa.length) out.push(finding({ ...base, rule: 'missing-caa', severity: 'low', title: 'No CAA record', why: 'Any certificate authority may issue certificates for the domain; a CAA record names the ones you use.', fix: `${records.apex ?? records.host}. CAA 0 issue "letsencrypt.org" (or your CA), on the domain itself.` }));
  return out;
}

/** The bare domain of a host: www. taken off (`www.shop.com` → `shop.com`); null when there's nothing to take. */
export const bareDomain = (host) => (/^www\./i.test(host) && host.split('.').length > 2 ? host.slice(4) : null);

// The DNS errors that mean "no such record" rather than "couldn't ask".
const NO_RECORD = /ENODATA|ENOTFOUND|NXDOMAIN|NOTFOUND|ENONAME/i;

/**
 * A host's records: { host, a, aaaa, cname, caa: [{ critical, issue|issuewild|iodef }], caaAt, mx:
 * [{ exchange, priority }], cnameResolves?, apex, errors }. CAA is looked for on the host, then each
 * parent up to its last two labels, as a CA does. `resolver` has node:dns's promise methods (resolve4,
 * resolve6, resolveCname, resolveCaa, resolveMx).
 */
export async function lookupDns(host, { resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 }) } = {}) {
  const errors = {};
  const ask = async (kind, method, name = host) => {
    try {
      return (await resolver[method](name)) ?? [];
    } catch (e) {
      if (!NO_RECORD.test(`${e.code} ${e.message}`)) errors[kind] = `${e.code ?? 'Error'}: ${String(e.message).split('\n')[0]}`;
      else if (kind === 'a') errors.a = `${e.code ?? 'ENOTFOUND'} ${name}`;
      return [];
    }
  };
  const [a, aaaa, cname, mx] = await Promise.all([ask('a', 'resolve4'), ask('aaaa', 'resolve6'), ask('cname', 'resolveCname'), ask('mx', 'resolveMx')]);
  const labels = host.split('.');
  let caa = [];
  let caaAt = null;
  for (let i = 0; i <= labels.length - 2; i++) {
    const name = labels.slice(i).join('.');
    caa = await ask('caa', 'resolveCaa', name);
    if (caa.length) {
      caaAt = name;
      break;
    }
  }
  const out = { host, a, aaaa, cname, caa, caaAt, mx: [...mx].sort((x, y) => x.priority - y.priority), apex: labels.slice(-2).join('.'), errors };
  if (cname.length) {
    const [ta, taaaa, tcname] = await Promise.all([ask('target', 'resolve4', cname[0]), ask('target', 'resolve6', cname[0]), ask('target', 'resolveCname', cname[0])]);
    // A resolver following the chain answers resolve4 for the host itself; one that doesn't is asked about the target.
    out.cnameResolves = Boolean(a.length || aaaa.length || ta.length || taaaa.length || tcname.length);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Fetching.

const withTimeout = (signal, timeout) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout));
const fetchError = (url, e) => {
  const cause = e.cause?.code ?? e.cause?.message ?? e.code;
  if (e.name === 'TimeoutError') return `${hostOf(url)} didn't answer in time`;
  return `${hostOf(url)}: ${cause ?? e.message}`;
};

/**
 * One request, no redirects followed: { url, status, headers (pairs), body, ms } or { url, error }.
 * The body is read for GET (up to 2 MB), not for HEAD.
 */
export async function fetchPage(url, { fetchImpl = globalThis.fetch, method = 'GET', signal, timeout = CHECK_TIMEOUT, headers = {} } = {}) {
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { method, redirect: 'manual', signal: withTimeout(signal, timeout), headers: { 'user-agent': 'Mozilla/5.0 (fleet webchecks)', ...headers } });
    const body = method === 'HEAD' ? '' : (await res.text()).slice(0, BODY_MAX);
    return { url, status: res.status, headers: headerPairs(res.headers), body, ms: Date.now() - started };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { url, error: fetchError(url, e) };
  }
}

/** The redirects from `url`, followed by hand up to `max`: [{ url, status, location?, error? }], the last the end of the road. */
export async function redirectChain(url, { fetchImpl = globalThis.fetch, max = 8, signal, timeout = CHECK_TIMEOUT } = {}) {
  const chain = [];
  let at = url;
  for (let i = 0; i <= max; i++) {
    const res = await fetchPage(at, { fetchImpl, method: 'GET', signal, timeout });
    if (res.error) {
      chain.push({ url: at, error: res.error });
      break;
    }
    const location = headerValue(res.headers, 'location');
    chain.push({ url: at, status: res.status, ...(location ? { location } : {}), res });
    if (!(res.status >= 300 && res.status < 400 && location)) break;
    at = new URL(location, at).href;
    if (chain.some((s) => s.url === at)) {
      chain.push({ url: at, error: 'Redirects in a loop' });
      break;
    }
  }
  return chain;
}

/**
 * The scripts' source maps an HTML page gives away: [{ script, map, inline?, sources? }], for each
 * same-origin script naming one that answers with a map, or carrying it inline; a script naming none is
 * tried with `.map` added.
 */
export async function findSourceMaps(html, pageUrl, { fetchImpl = globalThis.fetch, signal, timeout = CHECK_TIMEOUT, max = SCRIPTS_MAX } = {}) {
  const out = [];
  for (const script of scriptUrls(html, pageUrl, max)) {
    const js = await fetchPage(script, { fetchImpl, signal, timeout });
    if (js.error || js.status >= 400) continue;
    const named = sourceMapUrl(js.body, script);
    if (named === 'inline') {
      out.push({ script, inline: true });
      continue;
    }
    const map = named ?? `${script.replace(/[?#].*$/, '')}.map`;
    const res = await fetchPage(map, { fetchImpl, signal, timeout });
    if (!res.error && res.status === 200 && looksLikeSourceMap(res.body)) {
      let sources;
      try {
        sources = JSON.parse(res.body).sources.length;
      } catch {
        sources = undefined;
      }
      out.push({ script, map, ...(sources ? { sources } : {}) });
    }
  }
  return out;
}

/**
 * A page's security from the outside, without a browser: its redirects (from http:// too, for an https
 * URL), the headers, cookies and server headers of where it lands, mixed content and source maps in its
 * HTML, and its certificate. { url, final, status, chain, httpChain, cert, findings, error? }.
 * `probe` is probeCertificate (or a stand-in), `now` the clock for the certificate.
 */
export async function checkSite(url, { fetchImpl = globalThis.fetch, probe = probeCertificate, signal, now = new Date(), timeout = CHECK_TIMEOUT, sourceMaps = true } = {}) {
  const chain = await redirectChain(url, { fetchImpl, signal, timeout });
  const end = chain.at(-1);
  const out = { url, final: end.url, status: end.status ?? null, chain: chain.map(({ res, ...s }) => s), findings: [] };
  const where = url;
  if (end.error) {
    out.error = end.error;
    out.findings.push(finding({ where, rule: 'site-unreachable', severity: 'high', title: "The page doesn't answer", excerpt: end.error, why: 'Nothing could be checked, and nobody can open it.', fix: 'Check the address, DNS and that the site is up.' }));
    return out;
  }
  const res = end.res;
  out.findings.push(...judgeHeaders(res, { where, https: isHttps(end.url) }), ...judgeServerHeaders(res, { where }), ...judgeCookies(res, { where, https: isHttps(end.url) }));
  // The cookies set on the way (a redirect that signs in, say) count too.
  for (const step of chain.slice(0, -1)) if (step.res) out.findings.push(...judgeCookies(step.res, { where, https: isHttps(step.url) }));
  if (isHtml(res)) {
    out.findings.push(...judgeMixedContent(mixedContent(res.body, end.url), { where }));
    if (sourceMaps) out.findings.push(...judgeSourceMaps(await findSourceMaps(res.body, end.url, { fetchImpl, signal, timeout }), { where }));
  }
  if (isHttps(url)) {
    const u = new URL(url);
    out.httpChain = (await redirectChain(`http://${u.host}${u.pathname}${u.search}`, { fetchImpl, signal, timeout })).map(({ res: _r, ...s }) => s);
    out.findings.push(...judgeRedirects({ http: out.httpChain }, { where }));
  } else out.findings.push(...judgeRedirects({ http: out.chain }, { where }));
  if (isHttps(end.url)) {
    out.cert = await probe(end.url, { timeout });
    out.findings.push(...judgeCertificate(out.cert, { where: hostOf(end.url), now }));
  }
  out.findings = dedupe(out.findings);
  return out;
}

/** One finding per rule and where (and cookie or URL), the first kept. */
function dedupe(list) {
  const seen = new Set();
  return list.filter((f) => {
    const key = `${f.rule}|${f.where}|${f.cookie ?? ''}|${f.url ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A domain's checks: its DNS records, the redirects from http:// and from the bare domain, whether
 * https is enforced (http ends on https), its certificate and the days left on it. { host, bare, dns,
 * http, https, bareChain, enforced, cert, days, findings }.
 */
export async function checkDomain(host, { fetchImpl = globalThis.fetch, probe = probeCertificate, resolver, signal, now = new Date(), timeout = CHECK_TIMEOUT } = {}) {
  const h = String(host).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '');
  const bare = bareDomain(h);
  const strip = (chain) => chain.map(({ res: _r, ...s }) => s);
  const [records, http, https, bareChain] = await Promise.all([
    lookupDns(h, resolver ? { resolver } : {}),
    redirectChain(`http://${h}/`, { fetchImpl, signal, timeout }).then(strip),
    redirectChain(`https://${h}/`, { fetchImpl, signal, timeout }).then(strip),
    bare ? redirectChain(`https://${bare}/`, { fetchImpl, signal, timeout }).then(strip) : null,
  ]);
  const reachable = https.some((s) => s.status);
  const cert = reachable || !https.at(-1)?.error ? await probe(`https://${h}/`, { timeout }) : null;
  const findings = [...judgeDns(records, { where: h }), ...judgeRedirects({ http, https, bare: bareChain }, { where: h }), ...(cert ? judgeCertificate(cert, { where: h, now }) : [])];
  return {
    host: h,
    bare,
    dns: records,
    http,
    https,
    bareChain,
    enforced: Boolean(http.length && !http.at(-1).error && isHttps(http.at(-1).url)),
    cert,
    days: cert && !cert.error ? daysLeft(cert.validTo, now) : null,
    findings,
  };
}

/** A domain check as lines of text: the records, the redirects, https and the certificate. */
export function domainLines(d) {
  const route = (chain) => (chain?.length ? chain.map((s) => (s.error ? `× ${s.error}` : `${s.status} ${s.url}`)).join(' → ') : '—');
  const lines = [
    `A        ${d.dns.a.join(', ') || '—'}`,
    `AAAA     ${d.dns.aaaa.join(', ') || '—'}`,
    `CNAME    ${d.dns.cname.join(', ') || '—'}${d.dns.cnameResolves === false ? '  (doesn\'t resolve)' : ''}`,
    `CAA      ${d.dns.caa.length ? d.dns.caa.map((c) => `${Object.keys(c).find((k) => k !== 'critical')} ${Object.entries(c).find(([k]) => k !== 'critical')?.[1]}`).join(', ') + (d.dns.caaAt && d.dns.caaAt !== d.host ? ` (on ${d.dns.caaAt})` : '') : '—'}`,
    `MX       ${d.dns.mx.map((m) => `${m.priority} ${m.exchange}`).join(', ') || '—'}`,
    '',
    `http://  ${route(d.http)}`,
    `https:// ${route(d.https)}`,
    ...(d.bare ? [`${d.bare}  ${route(d.bareChain)}`] : []),
    `HTTPS    ${d.enforced ? 'enforced (http is sent to https)' : 'not enforced'}`,
    `Cert     ${d.cert?.error ? d.cert.error : d.cert ? `${d.cert.issuer ?? '?'}, until ${String(d.cert.validTo).slice(0, 10)} (${d.days} days)` : '—'}`,
  ];
  return lines;
}
