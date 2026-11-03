// The demo: a shop at shop.example with a staging copy, its pages measured as a headless Chrome would
// (three runs each, a little noisy), axe-core's violations, a header or two missing, a source map left
// on the server, a certificate running out on staging and no CAA record. The same interface as
// provider.js's createLantern; the security and domain checks are the kit's own (webchecks.js), run
// against a stand-in network, so --demo shows what the real ones say. `state.calls` is the tests' handle.
import { checkDomain, checkSite } from '@fleet/kit/webchecks.js';
import { assemble } from './audit.js';
import { NO_BROWSER } from './provider.js';

const DAY = 86_400_000;
const PROD = 'https://shop.example';
const STAGING = 'https://staging.shop.example';

export const DEMO_PAGES = [
  { name: '/', url: `${STAGING}/`, env: 'staging' },
  { name: '/checkout', url: `${STAGING}/checkout`, env: 'staging' },
  { name: '/', url: `${PROD}/`, env: 'prod' },
  { name: '/checkout', url: `${PROD}/checkout`, env: 'prod' },
];

const page = ({ lang = true, noindex = false, origin }) => `<!doctype html><html${lang ? ' lang="en"' : ''}><head><title>Shop — fresh things, delivered</title>
<meta name="description" content="Fresh fruit, bread and coffee, delivered the same day.">${noindex ? '<meta name="robots" content="noindex">' : ''}
<link rel="canonical" href="${origin}/"><link rel="stylesheet" href="/static/styles.css"><script src="/static/vendor.js"></script></head>
<body><h1>Fresh things</h1><img id="hero" src="http://cdn.shop.example/hero.jpg"><img src="/static/logo.png" width="120" height="40" alt="Shop">
<a href="/about">About</a><a href="/old-offer">Last summer's offer</a><a href="https://partner.example/">Our partner</a>
<script src="/static/app.js" defer></script></body></html>`;

const SECURE = { 'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff' };

/** The stand-in network: what each URL answers, as [status, headers, body]. */
function routes() {
  return {
    'http://shop.example/': [301, { location: `${PROD}/` }],
    'http://www.shop.example/': [301, { location: 'https://www.shop.example/' }],
    'https://www.shop.example/': [301, { location: `${PROD}/` }],
    [`${PROD}/`]: [200, { 'content-type': 'text/html; charset=utf-8', server: 'nginx/1.24.0', ...SECURE, 'set-cookie': ['session=d3m0; Path=/; Secure', 'consent=yes; Path=/; Secure; SameSite=Lax'] }, page({ origin: PROD })],
    [`${PROD}/checkout`]: [200, { 'content-type': 'text/html; charset=utf-8', server: 'nginx/1.24.0', ...SECURE, 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'referrer-policy': 'strict-origin-when-cross-origin' }, page({ origin: PROD })],
    'http://shop.example/checkout': [301, { location: `${PROD}/checkout` }],
    [`${PROD}/static/app.js`]: [200, { 'content-type': 'text/javascript' }, 'start();\n//# sourceMappingURL=app.js.map'],
    [`${PROD}/static/app.js.map`]: [200, { 'content-type': 'application/json' }, '{"version":3,"sources":["src/main.ts","src/cart.ts","src/api.ts"],"mappings":"AAAA"}'],
    [`${PROD}/static/vendor.js`]: [200, { 'content-type': 'text/javascript' }, 'lib();'],
    [`${PROD}/about`]: [200, {}],
    [`${PROD}/old-offer`]: [404, {}],
    'https://partner.example/': [200, {}],
    'http://staging.shop.example/': [200, { 'content-type': 'text/html' }, page({ lang: false, noindex: true, origin: STAGING })],
    'http://staging.shop.example/checkout': [200, { 'content-type': 'text/html' }, page({ lang: false, noindex: true, origin: STAGING })],
    [`${STAGING}/`]: [200, { 'content-type': 'text/html; charset=utf-8', 'x-powered-by': 'Express', ...SECURE, 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' }, page({ lang: false, noindex: true, origin: STAGING })],
    [`${STAGING}/checkout`]: [200, { 'content-type': 'text/html; charset=utf-8', 'x-powered-by': 'Express', ...SECURE, 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer' }, page({ lang: false, noindex: true, origin: STAGING })],
    [`${STAGING}/static/app.js`]: [200, { 'content-type': 'text/javascript' }, 'start();'],
    [`${STAGING}/static/vendor.js`]: [200, { 'content-type': 'text/javascript' }, 'lib();'],
    [`${STAGING}/about`]: [200, {}],
    [`${STAGING}/old-offer`]: [404, {}],
  };
}

/** A fetch over `routes()`: an unknown host doesn't resolve, an unknown path is a 404. */
export function demoFetch() {
  const table = routes();
  return async (url) => {
    const r = table[url];
    if (!r) {
      if (/^https?:\/\/(staging\.)?shop\.example\//.test(url)) return new Response('Not found', { status: 404 });
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }
    const [status, headers = {}, body = ''] = r;
    const h = new Headers();
    for (const [k, v] of Object.entries(headers)) for (const x of [].concat(v)) h.append(k, x);
    return new Response(status >= 300 && status < 400 ? null : body, { status, headers: h });
  };
}

/** The stand-in DNS: staging is a CNAME to its App Service app; nobody wrote a CAA record. */
export function demoResolver() {
  const zone = {
    'A shop.example': ['20.50.2.10'],
    'AAAA shop.example': ['2603:1020:203::10'],
    'MX shop.example': [{ exchange: 'shop-example.mail.protection.outlook.com', priority: 0 }],
    'CNAME www.shop.example': ['shop.example'],
    'A www.shop.example': ['20.50.2.10'],
    'CNAME staging.shop.example': ['shop-staging.azurewebsites.net'],
    'A staging.shop.example': ['20.105.232.1'],
    'A shop-staging.azurewebsites.net': ['20.105.232.1'],
  };
  const ask = (type) => async (name) => {
    if (zone[`${type} ${name}`]) return zone[`${type} ${name}`];
    throw Object.assign(new Error(`query${type} ENODATA ${name}`), { code: 'ENODATA' });
  };
  return { resolve4: ask('A'), resolve6: ask('AAAA'), resolveCname: ask('CNAME'), resolveCaa: ask('CAA'), resolveMx: ask('MX') };
}

/** The stand-in certificates: production's has two months left, staging's nine days. */
export const demoProbe = (now) => async (url) => {
  const host = new URL(url).hostname;
  const staging = host.startsWith('staging.');
  return { protocol: 'TLSv1.3', authorized: true, validTo: new Date(now() + (staging ? 9 : 61) * DAY).toISOString(), subject: host, issuer: staging ? 'Microsoft Azure RSA TLS Issuing CA 03' : 'R11', names: [host], selfSigned: false, hostnameError: null };
};

// The requests a home page makes, in order: [type, path, kB, start ms, end ms, mime, status].
const REQUESTS = [
  ['document', '/', 18, 0, 410, 'text/html', 200],
  ['stylesheet', '/static/styles.css', 62, 430, 610, 'text/css', 200],
  ['script', '/static/vendor.js', 910, 430, 1180, 'text/javascript', 200],
  ['image', 'http://cdn.shop.example/hero.jpg', 640, 640, 1650, 'image/jpeg', 200],
  ['image', '/static/logo.png', 12, 640, 720, 'image/png', 200],
  ['font', '/static/inter.woff2', 41, 650, 800, 'font/woff2', 200],
  ['script', '/static/app.js', 420, 1190, 1480, 'text/javascript', 200],
  ['fetch', '/api/cart', 2, 1500, 1620, 'application/json', 200],
  ['script', '/static/old.js', 0, 1500, 1540, 'text/html', 404],
];

const AXE = [
  { id: 'image-alt', impact: 'critical', help: 'Images must have alternative text', description: 'Ensures <img> elements have alternate text or a role of none or presentation', helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/image-alt', tags: ['cat.text-alternatives', 'wcag2a', 'wcag111'], nodes: 1, targets: [{ selector: '#hero', summary: 'Fix any of the following:\n  Element does not have an alt attribute', html: '<img id="hero" src="http://cdn.shop.example/hero.jpg">' }] },
  { id: 'color-contrast', impact: 'serious', help: 'Elements must meet minimum color contrast ratio thresholds', description: 'Ensures the contrast between foreground and background colors meets WCAG 2 AA minimum contrast ratio thresholds', helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast', tags: ['cat.color', 'wcag2aa', 'wcag143'], nodes: 3, targets: [{ selector: '.price-tag', summary: 'Fix any of the following:\n  Element has insufficient color contrast of 2.9 (foreground color: #9a9a9a, background color: #ffffff, font size: 10.5pt (14px), font weight: normal). Expected contrast ratio of 4.5:1', html: '<span class="price-tag">€4.20</span>' }, { selector: '.footer a', summary: '…' }] },
  { id: 'link-name', impact: 'serious', help: 'Links must have discernible text', description: 'Ensures links have discernible text', helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/link-name', tags: ['cat.name-role-value', 'wcag2a', 'wcag244', 'wcag412'], nodes: 1, targets: [{ selector: '.social > a:nth-of-type(2)', summary: 'Fix all of the following:\n  Element is in tab order and does not have accessible text', html: '<a href="https://social.example/shop"><svg>…</svg></a>' }] },
  { id: 'region', impact: 'moderate', help: 'All page content should be contained by landmarks', description: 'Ensures all page content is contained by landmarks', helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/region', tags: ['cat.keyboard', 'best-practice'], nodes: 2, targets: [{ selector: '.promo-banner', summary: 'Fix any of the following:\n  Some page content is not contained by landmarks', html: '<div class="promo-banner">' }] },
];

// Each page's three runs: LCP, CLS, INP, TTFB, FCP; production is slower than staging, the checkout more so.
const VITALS = {
  [`${PROD}/`]: { lcp: [2900, 2750, 3100], cls: [0.18, 0.17, 0.19], inp: [240, 210, 260], ttfb: [620, 590, 700], fcp: [1500, 1450, 1600] },
  [`${PROD}/checkout`]: { lcp: [4300, 4100, 4500], cls: [0.05, 0.05, 0.06], inp: [520, 480, 560], ttfb: [1100, 980, 1200], fcp: [2100, 2000, 2300] },
  [`${STAGING}/`]: { lcp: [1800, 1750, 1900], cls: [0.02, 0.02, 0.03], inp: [0, 0, 0], ttfb: [410, 390, 450], fcp: [1100, 1050, 1150] },
  [`${STAGING}/checkout`]: { lcp: [2400, 2300, 2600], cls: [0.04, 0.04, 0.05], inp: [180, 170, 190], ttfb: [700, 650, 760], fcp: [1400, 1350, 1500] },
};

/** Three raw runs of `url`, as browser.js's runPage returns them. */
function demoRuns(url) {
  const u = new URL(url);
  const v = VITALS[url] ?? VITALS[`${PROD}/`];
  const staging = u.hostname.startsWith('staging.');
  const requests = REQUESTS.map(([type, path, kb, start, end, mime, status], i) => ({ id: `r${i}`, url: path.startsWith('http') ? path : `${u.origin}${i === 0 ? u.pathname : path}`, method: path === '/api/cart' ? 'POST' : 'GET', type, size: kb * 1000, start, end, mime, status, main: i === 0, protocol: 'h2' }));
  const facts = {
    title: 'Shop — fresh things, delivered',
    description: 'Fresh fruit, bread and coffee, delivered the same day.',
    robots: staging ? 'noindex' : null,
    viewport: 'width=device-width, initial-scale=1',
    canonical: `${u.origin}/`,
    lang: staging ? null : 'en',
    h1: 1,
    images: [
      { src: 'http://cdn.shop.example/hero.jpg', selector: '#hero', width: null, height: null, styled: false },
      { src: `${u.origin}/static/logo.png`, selector: 'header > img', width: '120', height: '40', styled: false },
    ],
    links: [`${u.origin}/about`, `${u.origin}/old-offer`, 'https://partner.example/'],
    blocking: [{ kind: 'stylesheet', url: `${u.origin}/static/styles.css` }, { kind: 'script', url: `${u.origin}/static/vendor.js` }],
  };
  const consoleErrors = [{ source: 'network', text: 'Failed to load resource: the server responded with a status of 404 ()', url: `${u.origin}/static/old.js` }, ...(u.pathname === '/checkout' ? [{ source: 'exception', text: "TypeError: Cannot read properties of undefined (reading 'total')" }] : [])];
  return [0, 1, 2].map((i) => ({
    vitals: { lcp: v.lcp[i], cls: v.cls[i], inp: v.inp[i], ttfb: v.ttfb[i], fcp: v.fcp[i], lcpElement: 'img#hero' },
    requests,
    facts,
    console: consoleErrors,
    axe: i === 2 ? (staging ? AXE.slice(0, 2) : AXE) : null,
  }));
}

export function demoLantern({ chrome = true, now = () => Date.now() } = {}) {
  const state = { calls: [], written: {} };
  const web = { fetchImpl: demoFetch(), probe: demoProbe(now) };
  const call = (...c) => state.calls.push(c);
  return {
    name: 'demo',
    state,
    pages() {
      call('pages');
      return { pages: DEMO_PAGES.map((p) => ({ ...p })), domains: ['shop.example', 'www.shop.example', 'staging.shop.example'], sources: ['demo'], errors: [] };
    },
    browser() {
      return chrome ? { path: '/demo/chrome' } : null;
    },
    async audit(url, { runs = 3, name, env, onProgress = () => {} } = {}) {
      call('audit', url, runs);
      onProgress('run 1 of 3 in Chrome');
      const security = await checkSite(url, web);
      if (!/shop\.example/.test(new URL(url).hostname)) return assemble({ url, name, env, runs: [{ error: `${url}: net::ERR_NAME_NOT_RESOLVED` }], security, chrome: chrome ? '/demo/chrome' : null, at: now() });
      const raw = chrome ? demoRuns(url).slice(0, Math.max(1, Math.min(3, runs))) : [];
      const facts = chrome ? null : demoRuns(url)[0].facts;
      const links = { checked: 3, broken: [{ url: `${new URL(url).origin}/old-offer`, status: 404 }] };
      return assemble({ url, name, env, runs: raw, facts, links, security, chrome: chrome ? '/demo/chrome' : null, note: chrome ? undefined : NO_BROWSER, at: now() });
    },
    async security(url) {
      call('security', url);
      return checkSite(url, web);
    },
    async domain(host) {
      call('domain', host);
      return checkDomain(host, { ...web, resolver: demoResolver(), now: new Date(now()) });
    },
    async run(command) {
      call('run', command);
      return { stdout: `(demo) ${command}`, stderr: '' };
    },
    writeFile(path, text) {
      call('writeFile', path);
      state.written[path] = text;
    },
  };
}
